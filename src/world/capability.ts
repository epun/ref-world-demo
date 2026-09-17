/**
 * WHAT THIS BROWSER ACTUALLY OFFERS — one read, printed once, on the tier that
 * needs it (2026-09-17).
 *
 * > User ask: *"let's make sure it's optimized on Safari."* An iPhone is the
 * > main handset this world is watched from, and it is the one device nobody
 * > working on it can attach a profiler to.
 *
 * So the page says what it found. Every line here is a capability some
 * decision in this codebase depends on, and each one is a thing iOS Safari
 * has been known to differ on:
 *
 *   - **`OES_texture_float_linear`** — iOS does NOT expose it, and a 32-bit
 *     float texture is not texture-filterable without it. A sampler with
 *     `LINEAR` on one makes the texture INCOMPLETE and it samples black,
 *     which is why the shore bake is R16F (src/world/ghibli/shore.ts). If
 *     this ever reads `true` on a phone, that constraint has lifted.
 *   - **`OES_texture_half_float_linear` / `EXT_color_buffer_half_float`** — the
 *     16-bit pair, which iOS does expose. In core WebGL 2 R16F is filterable
 *     anyway; this says whether the WebGL 1 guarantees are there too.
 *   - **`EXT_color_buffer_float`** — RENDERING to a 32-bit float target.
 *     Nothing here does (the ink chain's colour targets are 8-bit and its
 *     depth texture is a depth format), so this is reported and not required.
 *   - **`KHR_parallel_shader_compile`** — the warm path `compileAsync` asks
 *     for (src/world/scene.ts). Feature-detected there, absent under
 *     swiftshader, and absent on iOS as of writing: programs still link, one
 *     at a time, on first draw.
 *   - **the sampler counts** — the ghibli materials bind at most five (the
 *     blade field: grass, comb, press, region, height, four of them in the
 *     VERTEX shader). Both limits are 16 at minimum in WebGL 2; this is here
 *     so a material that grows past them is caught as a number rather than as
 *     a black frame.
 *   - **`MAX_TEXTURE_SIZE`** — every bake this world makes is 1024 or under
 *     and the limit is 4096 everywhere that matters, so this is a margin
 *     check.
 *   - **the highp fragment precision** — the one that would not announce
 *     itself. Every noise term in the cel chain is driven by a world position
 *     in the hundreds; at 16-bit mediump they lose their `fract` entirely
 *     (src/world/toon.ts, src/world/ghibli/ground.ts). `rangeMax` of 2^62 or
 *     more is a real 32-bit float.
 *   - **`performance.memory`** — Chrome only. Anything reading it has to cope
 *     with its absence, which is most of the time.
 *   - **module workers** — `new Worker(url, { type: 'module' })`. Safari has
 *     supported them since 15; the probe asks rather than assumes, without
 *     constructing one.
 *
 * PURE, and injectable: `probeCapabilities` takes the gl context and the
 * globals it reads, so it is testable under node with a stub and it touches
 * nothing. `logCapabilities` is the only thing that prints, and only on a dev
 * deployment — `__IS_DEV__` and not `import.meta.env.DEV`, because the whole
 * point is to read this off a real iPhone on the deployed valiocon link.
 */

/** What one probe found. Every field is a plain value, so it logs as a table. */
export interface Capabilities {
  /** 2 for a WebGL 2 context, 1 otherwise. */
  webgl: 1 | 2;
  /** Extension names the context reports, in the order asked. */
  extensions: Record<string, boolean>;
  maxTextureSize: number;
  /** Fragment samplers, and vertex samplers — the blade field uses four. */
  maxFragmentSamplers: number;
  maxVertexSamplers: number;
  /** `log2` of the largest representable highp fragment float, or -1 if the
   * driver will not say. 62 or more is a real 32-bit float; 15 is fp16. */
  highpFragmentRangeMax: number;
  /** Bits of mantissa the driver promises a highp fragment float. */
  highpFragmentPrecision: number;
  /** The renderer string, when `WEBGL_debug_renderer_info` allows it. */
  renderer: string | null;
  /** Whether `performance.memory` exists at all (Chrome only). */
  performanceMemory: boolean;
  /** Whether `Worker` exists, and whether module workers are constructible. */
  worker: boolean;
  moduleWorker: boolean;
  /** The device's own ratio, before this world's cap. */
  devicePixelRatio: number;
}

/** The extensions worth naming — see the header for why each one. */
export const PROBED_EXTENSIONS: readonly string[] = [
  'OES_texture_float_linear',
  'OES_texture_half_float_linear',
  'EXT_color_buffer_float',
  'EXT_color_buffer_half_float',
  'KHR_parallel_shader_compile',
  'EXT_texture_filter_anisotropic',
  'WEBGL_debug_renderer_info',
];

/** The slice of a gl context this probe touches, so a test can stub it. */
export interface ProbeContext {
  getExtension(name: string): unknown;
  getParameter(p: number): unknown;
  getShaderPrecisionFormat(
    shaderType: number,
    precisionType: number,
  ): { rangeMin: number; rangeMax: number; precision: number } | null;
  MAX_TEXTURE_SIZE: number;
  MAX_TEXTURE_IMAGE_UNITS: number;
  MAX_VERTEX_TEXTURE_IMAGE_UNITS: number;
  FRAGMENT_SHADER: number;
  HIGH_FLOAT: number;
}

/** The globals it reads, injectable for the same reason. */
export interface ProbeEnvironment {
  devicePixelRatio?: number;
  performanceMemory?: boolean;
  worker?: boolean;
  moduleWorker?: boolean;
}

function defaultEnvironment(): ProbeEnvironment {
  const g = globalThis as {
    devicePixelRatio?: number;
    performance?: { memory?: unknown };
    Worker?: unknown;
  };
  return {
    devicePixelRatio: typeof g.devicePixelRatio === 'number' ? g.devicePixelRatio : 1,
    performanceMemory: g.performance?.memory !== undefined,
    worker: typeof g.Worker === 'function',
    // A module worker cannot be feature-detected without constructing one, and
    // constructing one costs a request. `Worker` plus a browser new enough to
    // have WebGL 2 is the honest proxy, said as a proxy: Safari has had them
    // since 15 and every WebGL 2 iOS Safari is 15 or later.
    moduleWorker: typeof g.Worker === 'function',
  };
}

/**
 * Read the context. Never throws: a driver that refuses a parameter reports a
 * -1 rather than taking the frame with it.
 */
export function probeCapabilities(
  gl: ProbeContext,
  isWebGL2: boolean,
  env: ProbeEnvironment = defaultEnvironment(),
): Capabilities {
  const ask = (name: string): boolean => {
    try {
      return gl.getExtension(name) != null;
    } catch {
      return false;
    }
  };
  const number = (p: number): number => {
    try {
      const value = gl.getParameter(p);
      return typeof value === 'number' ? value : -1;
    } catch {
      return -1;
    }
  };
  const extensions: Record<string, boolean> = {};
  for (const name of PROBED_EXTENSIONS) extensions[name] = ask(name);

  let rangeMax = -1;
  let precision = -1;
  try {
    const format = gl.getShaderPrecisionFormat(gl.FRAGMENT_SHADER, gl.HIGH_FLOAT);
    if (format) {
      rangeMax = format.rangeMax;
      precision = format.precision;
    }
  } catch {
    /* a driver that will not say leaves the -1s, which the log calls out */
  }

  let renderer: string | null = null;
  if (extensions['WEBGL_debug_renderer_info'] === true) {
    try {
      const ext = gl.getExtension('WEBGL_debug_renderer_info') as {
        UNMASKED_RENDERER_WEBGL: number;
      } | null;
      if (ext) {
        const value = gl.getParameter(ext.UNMASKED_RENDERER_WEBGL);
        renderer = typeof value === 'string' ? value : null;
      }
    } catch {
      /* masked, which most browsers now are */
    }
  }

  return {
    webgl: isWebGL2 ? 2 : 1,
    extensions,
    maxTextureSize: number(gl.MAX_TEXTURE_SIZE),
    maxFragmentSamplers: number(gl.MAX_TEXTURE_IMAGE_UNITS),
    maxVertexSamplers: number(gl.MAX_VERTEX_TEXTURE_IMAGE_UNITS),
    highpFragmentRangeMax: rangeMax,
    highpFragmentPrecision: precision,
    renderer,
    performanceMemory: env.performanceMemory === true,
    worker: env.worker === true,
    moduleWorker: env.moduleWorker === true,
    devicePixelRatio: env.devicePixelRatio ?? 1,
  };
}

/**
 * The things this world would have to change if they were not so — read off
 * one probe, as sentences rather than as a table, so a person holding a phone
 * can see at a glance whether anything is wrong.
 *
 * An empty list is the expected answer on every device this ships to.
 */
export function capabilityWarnings(caps: Capabilities): string[] {
  const out: string[] = [];
  if (caps.webgl !== 2) {
    out.push('webgl 1 only — the bakes assume core webgl 2 formats');
  }
  if (caps.maxTextureSize < 1024) {
    out.push(`max texture size ${caps.maxTextureSize} is under the 1024 bakes this world makes`);
  }
  if (caps.maxFragmentSamplers < 8 || caps.maxVertexSamplers < 8) {
    out.push(
      `samplers ${caps.maxFragmentSamplers} fragment / ${caps.maxVertexSamplers} vertex — ` +
        'the blade field binds five',
    );
  }
  // 2^62 is what a 32-bit float reports; fp16 reports 15.
  if (caps.highpFragmentRangeMax >= 0 && caps.highpFragmentRangeMax < 62) {
    out.push(
      `highp fragment float is only 2^${caps.highpFragmentRangeMax} — ` +
        'the cel chain runs world coordinates in the hundreds through fract',
    );
  }
  return out;
}

/**
 * Print one probe, ONCE, on a dev deployment. Silent in a demo build.
 *
 * Called from `start` on the phone tier (src/world/scene.ts). `console.info`
 * and a plain object, because a Safari remote console is where this gets read.
 */
export function logCapabilities(caps: Capabilities): void {
  if (!__IS_DEV__) return;
  const found = Object.entries(caps.extensions)
    .filter(([, on]) => on)
    .map(([name]) => name);
  const missing = Object.entries(caps.extensions)
    .filter(([, on]) => !on)
    .map(([name]) => name);
  // Lowercase, like every other string this project puts on a screen.
  console.info('refworld gl probe', {
    webgl: caps.webgl,
    renderer: caps.renderer ?? 'masked',
    'device pixel ratio': caps.devicePixelRatio,
    'max texture size': caps.maxTextureSize,
    samplers: `${caps.maxFragmentSamplers} fragment / ${caps.maxVertexSamplers} vertex`,
    'highp fragment': `2^${caps.highpFragmentRangeMax}, ${caps.highpFragmentPrecision} bits`,
    'performance.memory': caps.performanceMemory,
    'module worker': caps.moduleWorker,
    'extensions found': found,
    'extensions missing': missing,
  });
  for (const warning of capabilityWarnings(caps)) console.warn('refworld gl probe:', warning);
}
