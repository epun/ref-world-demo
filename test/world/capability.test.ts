/**
 * The gl capability probe (src/world/capability.ts).
 *
 * > User ask, 2026-09-17: *"let's make sure it's optimized on Safari."*
 *
 * An iPhone is the main handset and the one device nobody working on this can
 * attach a profiler to, so the page reports what it found. What matters here
 * is that the probe cannot be the thing that breaks the page — a driver that
 * refuses a parameter, throws on `getExtension` or will not name its
 * precision has to come back as a number, not as an exception — and that the
 * warnings actually fire on the shapes they exist for.
 *
 * The iOS shape is the important case: `OES_texture_float_linear` absent (it
 * is, on every iOS Safari) with `OES_texture_half_float_linear` present. That
 * is why the shore bake is R16F (src/world/ghibli/shore.ts), and on that
 * shape the probe must report NO warnings at all — the world is correct
 * there, and a probe that cried wolf would be ignored.
 */

import { describe, expect, it } from 'vitest';
import {
  capabilityWarnings,
  probeCapabilities,
  type ProbeContext,
} from '../../src/world/capability';

/** Enum-ish parameter ids; only distinctness matters. */
const P = {
  MAX_TEXTURE_SIZE: 1,
  MAX_TEXTURE_IMAGE_UNITS: 2,
  MAX_VERTEX_TEXTURE_IMAGE_UNITS: 3,
  FRAGMENT_SHADER: 4,
  HIGH_FLOAT: 5,
};

function context(
  present: readonly string[],
  params: Record<number, unknown> = {},
  precision: { rangeMin: number; rangeMax: number; precision: number } | null = {
    rangeMin: 127,
    rangeMax: 127,
    precision: 23,
  },
): ProbeContext {
  return {
    ...P,
    getExtension: (name: string): unknown => (present.includes(name) ? {} : null),
    getParameter: (p: number): unknown =>
      p in params
        ? params[p]
        : p === P.MAX_TEXTURE_SIZE
          ? 4096
          : p === P.MAX_TEXTURE_IMAGE_UNITS || p === P.MAX_VERTEX_TEXTURE_IMAGE_UNITS
            ? 16
            : null,
    getShaderPrecisionFormat: () => precision,
  };
}

const env = {
  devicePixelRatio: 3,
  performanceMemory: false,
  worker: true,
  moduleWorker: true,
};

describe('probeCapabilities', () => {
  it('reports the iOS shape, and finds nothing wrong with it', () => {
    // No float-linear, half-float-linear present, no parallel compile — which
    // is iOS Safari as of writing.
    const caps = probeCapabilities(
      context(['OES_texture_half_float_linear', 'EXT_color_buffer_half_float']),
      true,
      env,
    );
    expect(caps.webgl).toBe(2);
    expect(caps.extensions['OES_texture_float_linear']).toBe(false);
    expect(caps.extensions['OES_texture_half_float_linear']).toBe(true);
    expect(caps.extensions['KHR_parallel_shader_compile']).toBe(false);
    expect(caps.maxTextureSize).toBe(4096);
    expect(caps.maxFragmentSamplers).toBe(16);
    expect(caps.devicePixelRatio).toBe(3);
    expect(caps.performanceMemory).toBe(false);
    // 2^127 is a real 32-bit float; the warnings want 2^62 or better.
    expect(capabilityWarnings(caps)).toEqual([]);
  });

  it('survives a driver that throws at every question', () => {
    const hostile: ProbeContext = {
      ...P,
      getExtension: (): unknown => {
        throw new Error('no');
      },
      getParameter: (): unknown => {
        throw new Error('no');
      },
      getShaderPrecisionFormat: () => {
        throw new Error('no');
      },
    };
    const caps = probeCapabilities(hostile, false, env);
    expect(caps.webgl).toBe(1);
    expect(caps.maxTextureSize).toBe(-1);
    expect(caps.highpFragmentRangeMax).toBe(-1);
    // A -1 precision is "would not say", not "is bad": no precision warning.
    expect(capabilityWarnings(caps)).toContain(
      'webgl 1 only — the bakes assume core webgl 2 formats',
    );
    expect(capabilityWarnings(caps).some((w) => w.includes('highp'))).toBe(false);
  });

  it('warns when highp is really fp16, which is what would not announce itself', () => {
    const caps = probeCapabilities(context([]), true, env);
    expect(capabilityWarnings(caps)).toEqual([]);
    const weak = probeCapabilities(
      context([], {}, { rangeMin: 15, rangeMax: 15, precision: 10 }),
      true,
      env,
    );
    expect(weak.highpFragmentRangeMax).toBe(15);
    expect(weak.highpFragmentPrecision).toBe(10);
    expect(capabilityWarnings(weak).some((w) => w.includes('highp fragment float'))).toBe(true);
  });

  it('warns on a texture ceiling under the bakes this world makes', () => {
    const small = probeCapabilities(context([], { [P.MAX_TEXTURE_SIZE]: 512 }), true, env);
    expect(capabilityWarnings(small).some((w) => w.includes('max texture size'))).toBe(true);
  });

  it('warns on a sampler ceiling the ghibli materials would not fit under', () => {
    const few = probeCapabilities(
      context([], { [P.MAX_TEXTURE_IMAGE_UNITS]: 4, [P.MAX_VERTEX_TEXTURE_IMAGE_UNITS]: 4 }),
      true,
      env,
    );
    expect(capabilityWarnings(few).some((w) => w.includes('samplers'))).toBe(true);
  });
});
