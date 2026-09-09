/**
 * Handing a file to the phone — the two decisions that decide whether a
 * save happens at all, and the guard that decides whether it was worth
 * happening.
 *
 * User report, 2026-09-09, from a real handset on production: *"the save
 * as photo isn't working for the character, or the 3d file, or link. the
 * photo in particular is blank."* Three separate faults, and two of them
 * are in here:
 *
 *   - the picture was blank because the export never sized its render
 *     passes (they build at 1x1 and are only measured by `setSize`), so
 *     the whole scene went into one pixel and that pixel was stretched
 *     over the file. `frameHasInk` is what stops a frame like that ever
 *     being handed over as a saved picture again;
 *   - the file rows did nothing because `deliver` awaited a share that was
 *     refused and only THEN reached for the download — on an activation
 *     the failed share had already spent. A refusal is now reported, and
 *     remembered, so the second tap takes the file route with a live
 *     gesture behind it.
 *
 * The renders need a gpu, so the pixels themselves are checked in a
 * browser (a playwright run over the phone page). What is here is
 * everything that can be decided without one.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { deliver, frameHasInk } from '../../src/phone/keepsake';

// ── a DOM small enough to read ───────────────────────────────────────────────

interface Recorded {
  opened: string[];
  anchors: { href: string; download: string }[];
  revoked: string[];
}

function stubDom(
  navigatorStub: Record<string, unknown>,
  options: { framed?: boolean } = {},
): { recorded: Recorded; restore: () => void } {
  const globals = globalThis as Record<string, unknown>;
  const before = new Map<string, PropertyDescriptor | undefined>();
  const set = (name: string, value: unknown): void => {
    if (!before.has(name)) before.set(name, Object.getOwnPropertyDescriptor(globals, name));
    Object.defineProperty(globals, name, { value, configurable: true, writable: true });
  };

  const recorded: Recorded = { opened: [], anchors: [], revoked: [] };
  set('document', {
    body: { appendChild: (): void => {} },
    createElement: (): Record<string, unknown> => {
      const anchor = {
        href: '',
        download: '',
        click(): void {
          recorded.anchors.push({ href: anchor.href, download: anchor.download });
        },
        remove(): void {},
      };
      return anchor;
    },
  });
  // `framed()` reads `window.parent !== window`, so the stub has to be able
  // to be its own parent.
  const self = {} as Record<string, unknown>;
  Object.assign(self, {
    parent: options.framed ? ({} as unknown) : self,
    open: (url: string): unknown => {
      recorded.opened.push(url);
      return {};
    },
    setTimeout: (): number => 0,
  });
  set('window', self);
  set('navigator', navigatorStub);
  set('URL', {
    createObjectURL: (): string => 'blob:ref-world/one',
    revokeObjectURL: (u: string): void => {
      recorded.revoked.push(u);
    },
  });

  return {
    recorded,
    restore(): void {
      for (const [name, desc] of before) {
        if (desc) Object.defineProperty(globals, name, desc);
        else delete globals[name];
      }
    },
  };
}

let live: { restore: () => void } | null = null;
afterEach(() => {
  live?.restore();
  live = null;
});

const png = (): Blob => new Blob(['png'], { type: 'image/png' });
const glb = (): Blob => new Blob(['glb'], { type: 'model/gltf-binary' });

// ── the guard on a blank frame ───────────────────────────────────────────────

describe('frameHasInk', () => {
  /** `side²` pixels of one flat colour, RGBA. */
  const flat = (side: number, v: number): Uint8Array => {
    const px = new Uint8Array(side * side * 4);
    px.fill(v);
    for (let i = 3; i < px.length; i += 4) px[i] = 255;
    return px;
  };

  it('rejects the flat square the broken export produced', () => {
    // Measured, at 256px, before the fix: 19 distinct colours, zero ink
    // pixels, a uniform rgb(144,144,139) — not even the paper value. It is
    // a perfectly valid png, which is exactly the problem: it shares, it
    // downloads, it lands in the camera roll, and it is nothing.
    expect(frameHasInk(flat(256, 144))).toBe(false);
  });

  it('rejects an empty sheet of paper', () => {
    // 0xdf is SURFACE.ground. A frame with the paper and no creature on it
    // is the other way this fails, and it is just as much a failure.
    expect(frameHasInk(flat(256, 0xdf))).toBe(false);
  });

  it('accepts a creature on paper', () => {
    const px = flat(256, 0xdf);
    // A silhouette over a fiftieth of the frame — far less than a real one
    // (the fixed export measures about a tenth).
    for (let i = 0; i < 256 * 256 * 4 * 0.02; i += 4) {
      px[i] = 8;
      px[i + 1] = 8;
      px[i + 2] = 8;
    }
    expect(frameHasInk(px)).toBe(true);
  });

  it('is not fooled by a handful of stray dark pixels', () => {
    const px = flat(256, 0xdf);
    for (let i = 0; i < 4 * 4; i += 4) {
      px[i] = 0;
      px[i + 1] = 0;
      px[i + 2] = 0;
    }
    expect(frameHasInk(px)).toBe(false);
  });
});

// ── where a file actually goes ───────────────────────────────────────────────

describe('deliver', () => {
  it('opens a PICTURE in a tab of its own inside the companion frame', async () => {
    // A `download` anchor is right on a page and is the route most likely
    // to be dropped in a frame: some engines block a framed download
    // outright, and mobile safari ignores `download` on a blob url and
    // navigates instead — which in a frame means the person's companion
    // goes somewhere rather than the file arriving. A tab they can press
    // and hold in is how a picture reaches a camera roll.
    const dom = stubDom({}, { framed: true });
    live = dom;
    expect(await deliver(png(), 'refworld-wonder.png')).toBe('opened');
    expect(dom.recorded.opened).toEqual(['blob:ref-world/one']);
    expect(dom.recorded.anchors).toHaveLength(0);
  });

  it('keeps the anchor for a MODEL, even framed, because the name matters', async () => {
    // `window.open` carries no filename: measured in chromium, a glb
    // opened that way arrived as `e16f0657-aedf-…`. There is nothing to
    // look at in a glb, so a tab buys nothing and costs the name.
    const dom = stubDom({}, { framed: true });
    live = dom;
    expect(await deliver(glb(), 'refworld-wonder.glb')).toBe('downloaded');
    expect(dom.recorded.opened).toEqual([]);
    expect(dom.recorded.anchors[0]?.download).toBe('refworld-wonder.glb');
  });

  it('downloads on a page, where a download is the honest answer', async () => {
    const dom = stubDom({});
    live = dom;
    expect(await deliver(png(), 'refworld-wonder.png')).toBe('downloaded');
    expect(dom.recorded.opened).toEqual([]);
    expect(dom.recorded.anchors[0]).toEqual({
      href: 'blob:ref-world/one',
      download: 'refworld-wonder.png',
    });
  });

  it('takes the share sheet when the browser says it can carry the file', async () => {
    const shared: { files?: File[] }[] = [];
    const dom = stubDom({
      canShare: () => true,
      share: (data: { files?: File[] }) => {
        shared.push(data);
        return Promise.resolve();
      },
    });
    live = dom;
    expect(await deliver(png(), 'refworld-wonder.png')).toBe('shared');
    expect(shared[0]?.files?.[0]?.name).toBe('refworld-wonder.png');
    expect(dom.recorded.anchors).toHaveLength(0);
  });

  it('reads a cancelled sheet as done, never as a failure', async () => {
    const abort = Object.assign(new Error('cancelled'), { name: 'AbortError' });
    const dom = stubDom({ canShare: () => true, share: () => Promise.reject(abort) });
    live = dom;
    // Falling through would hand them a file they just declined.
    expect(await deliver(png(), 'refworld-wonder.png')).toBe('shared');
    expect(dom.recorded.anchors).toHaveLength(0);
    expect(dom.recorded.opened).toEqual([]);
  });

  // LAST, deliberately: the refusal latch is module state for the life of
  // the document, which is the whole point of it — a browser that refused
  // once refuses again, and the second tap should not spend itself finding
  // that out a second time.
  it('reports a REFUSED sheet, and takes the file route on the next tap', async () => {
    // The fault the user hit. `await share(...)` and then falling through
    // to the anchor spends the tap's activation on the share that failed,
    // so the download is refused too and nothing happens at all. It has to
    // be said out loud — and then remembered, or every tap fails the same
    // way forever.
    const dom = stubDom({
      canShare: () => true,
      share: () => Promise.reject(new Error('not allowed')),
    });
    live = dom;
    expect(await deliver(png(), 'refworld-wonder.png')).toBe('failed');
    expect(dom.recorded.anchors).toHaveLength(0);

    // The second tap has an activation of its own and skips the sheet.
    expect(await deliver(png(), 'refworld-wonder.png')).toBe('downloaded');
    expect(dom.recorded.anchors).toHaveLength(1);
  });
});
