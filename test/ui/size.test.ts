/**
 * The ball-size readout (src/ui/size.ts).
 *
 * > User ask, 2026-09-16: *"for the mobile ui on the world view i want to
 * > show ball diameter in the top left hand side."*
 *
 * Four things are pinned here, in the order they can go wrong:
 *
 * 1. THE FORMAT. Three bands and two unit boundaries, and the boundaries are
 *    where a hand-written formatter always breaks: `0.9999 m` must read
 *    `1m 0cm`, never `99cm 10mm`. Plus the taste's own rule — lowercase,
 *    everywhere, at confidence 1.00 (TASTE §5).
 * 2. THE CONVERSION. Units → metres through the object library's own
 *    `WORLD_SCALE` and not a second copy of it, so the ball is measured on
 *    the same ruler as the props it is rolling over.
 * 3. THE MARK SET. `icon` + `ruleLine` + `border` and nothing else
 *    (TASTE §4): the sheet the module ships is read back and checked for the
 *    things a corner readout is most likely to grow — a background, a card,
 *    a shadow.
 * 4. THE CORNER ITSELF, against a recording DOM (this project keeps no
 *    jsdom): it mounts, it shows NOTHING until there is a ball, it rolls the
 *    number up instead of jumping to it, and it takes itself off the page on
 *    dispose.
 *
 * …and the wiring, read out of src/main.ts: the readout is behind the game
 * flag and behind a dynamic import, so a world without the katamari never
 * mounts it and never even fetches it.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  BAND_ALPHA,
  BAND_FEATHER,
  BAND_PX,
  INSET_PX,
  formatLength,
  installBallSize,
  metresOf,
  ringBoxPx,
  ringTextPath,
} from '../../src/ui/size';
import { WORLD_SCALE } from '../../src/world/katamari/rules';

describe('formatLength — the game says it in two units', () => {
  it('reads centimetres and millimetres under a metre', () => {
    expect(formatLength(0.345)).toBe('34cm 5mm');
    expect(formatLength(0.05)).toBe('5cm 0mm');
    expect(formatLength(0.004)).toBe('0cm 4mm');
  });

  it('reads metres and centimetres from a metre up', () => {
    expect(formatLength(1)).toBe('1m 0cm');
    expect(formatLength(1.23)).toBe('1m 23cm');
    expect(formatLength(9.07)).toBe('9m 7cm');
    expect(formatLength(99.994)).toBe('99m 99cm');
  });

  it('drops the centimetres over a hundred metres', () => {
    expect(formatLength(100)).toBe('100m');
    expect(formatLength(123.4)).toBe('123m');
    expect(formatLength(1234.6)).toBe('1235m');
  });

  it('carries a rounded unit up into its band rather than overflowing it', () => {
    // The trap: 0.9999 m is 1000mm, which is not 99cm 10mm.
    expect(formatLength(0.9999)).toBe('1m 0cm');
    // …and the same trap one band up: 99.999 m is 10000cm, not 99m 100cm.
    expect(formatLength(99.999)).toBe('100m');
  });

  it('rounds in the smallest unit of the band', () => {
    expect(formatLength(0.3456)).toBe('34cm 6mm');
    expect(formatLength(0.3454)).toBe('34cm 5mm');
    expect(formatLength(1.0051)).toBe('1m 1cm');
    expect(formatLength(1.0049)).toBe('1m 0cm');
  });

  it('says a real zero rather than nothing, and survives nonsense', () => {
    expect(formatLength(0)).toBe('0cm 0mm');
    expect(formatLength(-4)).toBe('0cm 0mm');
    expect(formatLength(Number.NaN)).toBe('0cm 0mm');
    expect(formatLength(Number.POSITIVE_INFINITY)).toBe('0cm 0mm');
  });

  it('has no uppercase in it, at any size (TASTE §5)', () => {
    for (const m of [0, 0.004, 0.345, 1, 1.23, 99.999, 100, 5000]) {
      expect(formatLength(m)).toBe(formatLength(m).toLowerCase());
      expect(formatLength(m)).not.toMatch(/[A-Z]/);
    }
  });
});

describe('metresOf — the library’s own scale, read backwards', () => {
  it('inverts WORLD_SCALE rather than carrying a second number', () => {
    expect(metresOf(1.6)).toBeCloseTo(1.6 / WORLD_SCALE, 12);
    // Which is the constant's own reason for existing: 1.6 units is the
    // 1.7 m adult the katamari rules pitched the world at.
    expect(metresOf(1.6)).toBeCloseTo(1.7, 2);
  });

  it('is zero for nothing, and for nonsense', () => {
    expect(metresOf(0)).toBe(0);
    expect(metresOf(-2)).toBe(0);
    expect(metresOf(Number.NaN)).toBe(0);
  });
});

describe('ringTextPath — the number curves, and the glyphs stand up', () => {
  /*
   * > User direction with a mock, 2026-09-17: the size text sits on the outer
   * > radius of the circle, curving along it, *"with the text readable and
   * > flipped the correct way"* — the mock's own glyphs were upside down.
   *
   * SVG lays text along a path with each glyph's up-vector on the LEFT of the
   * travel direction, so on the lower half of a circle the direction IS the
   * answer: clockwise hangs the letters feet-outward, counter-clockwise
   * stands them up. That is what these pin, off the path data.
   */
  it('runs counter-clockwise, which is what stands the letters up', () => {
    const d = ringTextPath(42);
    // One move and one arc, with the sweep flag 0 — counter-clockwise in a
    // y-down space. (`A rx ry rot large sweep x y`.)
    const arc = d.slice(d.indexOf('A'));
    const parts = arc.split(/\s+/);
    expect(parts[0]).toBe('A');
    expect(parts[4]).toBe('0');
    expect(parts[5]).toBe('0');
  });

  it('starts below the centre and ends to its right', () => {
    const d = ringTextPath(42);
    const nums = d.match(/-?\d+\.\d+/g)!.map(Number);
    const [sx, sy] = [nums[0]!, nums[1]!];
    // The end point is the last pair.
    const ex = nums[nums.length - 2]!;
    const ey = nums[nums.length - 1]!;
    // Below the centre (y down), and left of it — the lower-left of the ring.
    expect(sy).toBeGreaterThan(50);
    expect(sx).toBeLessThan(50);
    // …round to its right, and above where it started: the text climbs from
    // the bottom of the ring to its right-hand side, reading left to right.
    expect(ex).toBeGreaterThan(50);
    expect(ey).toBeLessThan(sy);
  });

  it('is on the radius it was asked for, all the way round', () => {
    for (const r of [30, 42, 48]) {
      const d = ringTextPath(r);
      const nums = d.match(/-?\d+\.\d+/g)!.map(Number);
      const start = Math.hypot(nums[0]! - 50, nums[1]! - 50);
      const end = Math.hypot(
        nums[nums.length - 2]! - 50,
        nums[nums.length - 1]! - 50,
      );
      expect(start).toBeCloseTo(r, 3);
      expect(end).toBeCloseTo(r, 3);
    }
  });

  it('answers nothing for a radius that is not one', () => {
    for (const bad of [0, -3, Number.NaN]) expect(ringTextPath(bad)).toBe('');
  });
});

// ── the corner, against a recording DOM ──────────────────────────────────────

interface StubEl {
  tag: string;
  id: string;
  className: string;
  textContent: string;
  style: Record<string, string>;
  attrs: Record<string, string>;
  classes: Set<string>;
  classList: {
    add(name: string): void;
    remove(name: string): void;
    contains(name: string): boolean;
    toggle(name: string, on?: boolean): void;
  };
  children: StubEl[];
  parent: StubEl | null;
  setAttribute(name: string, value: string): void;
  setAttributeNS(ns: string | null, name: string, value: string): void;
  /** What a layout would have measured. The recording DOM has no layout, so
   * a test that cares sets it (the inset's diameter is the row's width). */
  offsetWidth: number;
  /** …and what it would have measured tall. The box's wavering frame is
   * drawn at the row's real size, so a test about the frame sets both. */
  offsetHeight: number;
  getBoundingClientRect(): { left: number; top: number; width: number; height: number };
  appendChild(child: StubEl): StubEl;
  append(...kids: StubEl[]): void;
  remove(): void;
}

function makeEl(tag: string): StubEl {
  const el: StubEl = {
    tag,
    id: '',
    className: '',
    textContent: '',
    style: {},
    attrs: {},
    classes: new Set<string>(),
    classList: {
      add: (name: string): void => void el.classes.add(name),
      remove: (name: string): void => void el.classes.delete(name),
      contains: (name: string): boolean => el.classes.has(name),
      toggle: (name: string, on?: boolean): void => {
        const next = on ?? !el.classes.has(name);
        if (next) el.classes.add(name);
        else el.classes.delete(name);
      },
    },
    children: [],
    parent: null,
    offsetWidth: 0,
    offsetHeight: 0,
    getBoundingClientRect(): {
      left: number;
      top: number;
      width: number;
      height: number;
    } {
      // Whatever the caller wrote on the element, which for the inset is the
      // width and height the module itself set (an svg sized in attributes).
      const w = Number(el.attrs['width'] ?? '0');
      const h = Number(el.attrs['height'] ?? '0');
      return { left: 16, top: 16, width: w, height: h };
    },
    setAttribute(name: string, value: string): void {
      el.attrs[name] = value;
    },
    // A namespaced attribute is recorded under its own name: the readout
    // writes `xlink:href` beside `href` on its text path, for Safari.
    setAttributeNS(_ns: string | null, name: string, value: string): void {
      el.attrs[name] = value;
    },
    appendChild(child: StubEl): StubEl {
      child.parent = el;
      el.children.push(child);
      return child;
    },
    append(...kids: StubEl[]): void {
      for (const kid of kids) el.appendChild(kid);
    },
    remove(): void {
      const at = el.parent?.children.indexOf(el) ?? -1;
      if (el.parent && at >= 0) el.parent.children.splice(at, 1);
      el.parent = null;
    },
  };
  return el;
}

/** Find the first descendant carrying `className`. */
function find(root: StubEl, className: string): StubEl | null {
  if (root.className === className || root.attrs['class'] === className) return root;
  for (const kid of root.children) {
    const hit = find(kid, className);
    if (hit) return hit;
  }
  return null;
}

/**
 * Enough DOM for installBallSize: a head to hang the sheet off, elements
 * that remember what was set on them, and a rAF the test drives by hand.
 *
 * This project keeps no jsdom (see test/phone/keepui.test.ts), and the
 * things worth pinning here — what the readout says, when it appears, and
 * whether it leaves — are all observable on a recording DOM.
 */
function stubDom(): {
  mount: StubEl;
  head: StubEl;
  step(now: number): void;
  restore(): void;
} {
  const head = makeEl('head');
  const mount = makeEl('body');
  const styles = new Map<string, StubEl>();
  let pending: FrameRequestCallback | null = null;

  const globals = globalThis as Record<string, unknown>;
  const before = {
    document: globals.document,
    raf: globals.requestAnimationFrame,
    caf: globals.cancelAnimationFrame,
  };
  globals.document = {
    hidden: false,
    head,
    getElementById: (id: string): StubEl | null => styles.get(id) ?? null,
    createElement: (tag: string): StubEl => {
      const el = makeEl(tag);
      if (tag === 'style') {
        // The sheet registers itself the way a real one does, so a second
        // install finds it and does not append a second copy.
        Object.defineProperty(el, 'id', {
          get: () => el.attrs['id'] ?? '',
          set: (value: string) => {
            el.attrs['id'] = value;
            styles.set(value, el);
          },
        });
      }
      return el;
    },
    createElementNS: (_ns: string, tag: string): StubEl => makeEl(tag),
    addEventListener: (): void => {},
    removeEventListener: (): void => {},
  };
  globals.requestAnimationFrame = (cb: FrameRequestCallback): number => {
    pending = cb;
    return 1;
  };
  globals.cancelAnimationFrame = (): void => {
    pending = null;
  };
  return {
    mount,
    head,
    step: (now: number): void => {
      const cb = pending;
      pending = null;
      cb?.(now);
    },
    restore: (): void => {
      globals.document = before.document;
      globals.requestAnimationFrame = before.raf;
      globals.cancelAnimationFrame = before.caf;
    },
  };
}

describe('the corner mounts, waits for a ball, and leaves cleanly', () => {
  it('shows nothing at all while the creature is still a shell', () => {
    const dom = stubDom();
    // What `ballDiameter` answers before hatch — and in every world without
    // the game, which is the same 0 for the same reason.
    const handle = installBallSize({
      diameter: () => 0,
      mount: dom.mount as unknown as HTMLElement,
    });
    for (let f = 1; f <= 30; f++) dom.step(f * 40);
    expect(handle.shown()).toBe(false);
    expect(handle.text()).toBe('');
    const el = handle.el as unknown as StubEl;
    const inset = find(el, 'world-size-inset')!;
    // Not slid in, and with no number on it: an empty corner, not a zero.
    expect(inset.classList.contains('in')).toBe(false);
    expect(find(el, 'world-size-value')!.children[0]!.textContent).toBe('');
    handle.dispose();
    dom.restore();
  });

  it('slides in and rolls the number up to the ball’s real size', () => {
    const dom = stubDom();
    const units = 2;
    const handle = installBallSize({
      diameter: () => units,
      mount: dom.mount as unknown as HTMLElement,
    });
    const inset = find(handle.el as unknown as StubEl, 'world-size-inset')!;

    dom.step(40);
    // It has arrived — by sliding, which is the class the sheet transitions.
    expect(handle.shown()).toBe(true);
    expect(inset.classList.contains('in')).toBe(true);
    // …and the number started from nothing rather than appearing at the
    // answer: the spring is what carries it, over MOTION.primaryMs.
    const first = handle.text();
    expect(first).not.toBe('');
    expect(first).not.toBe(formatLength(metresOf(units)));

    // Run the spring out. Never past the target — ζ ≥ 1 by construction.
    const seen: string[] = [first];
    for (let f = 2; f <= 300; f++) {
      dom.step(f * 40);
      if (handle.text() !== seen[seen.length - 1]) seen.push(handle.text());
    }
    expect(handle.text()).toBe(formatLength(metresOf(units)));
    // It rolled: several distinct readings on the way, in order.
    expect(seen.length).toBeGreaterThan(3);
    /** A reading back as a number of metres, so the order can be asserted. */
    const value = (s: string): number => {
      let total = 0;
      for (const [, n, unit] of s.matchAll(/(\d+)(mm|cm|m)/g)) {
        const v = Number(n);
        total += unit === 'mm' ? v / 1000 : unit === 'cm' ? v / 100 : v;
      }
      return total;
    };
    for (let i = 1; i < seen.length; i++) {
      expect(value(seen[i]!)).toBeGreaterThanOrEqual(value(seen[i - 1]!));
    }
    handle.dispose();
    dom.restore();
  });

  it('keeps drifting once the number has settled (TASTE §3)', () => {
    const dom = stubDom();
    const handle = installBallSize({
      diameter: () => 3,
      mount: dom.mount as unknown as HTMLElement,
    });
    for (let f = 1; f <= 200; f++) dom.step(f * 40);
    const drift = find(handle.el as unknown as StubEl, 'world-size-drift')!;
    const at = drift.style['transform'];
    for (let f = 201; f <= 260; f++) dom.step(f * 40);
    expect(drift.style['transform']).not.toBe(at);
    expect(drift.style['transform']).toMatch(/^translate\(/);
    handle.dispose();
    dom.restore();
  });

  it('feathers a 40% white band between the picture and the outline', () => {
    /*
     * > User mock, 2026-09-17: the band between the 3d disc and the outline
     * > has *"a white fill at 40% opacity with a slight feathered blur"* at
     * > its edges — and the outline is the ref world hairline.
     *
     * A radial gradient rather than a blur filter: a filter is an offscreen
     * pass on a phone for a mark a hundred pixels across, and what the mock
     * asks for is an edge that is not an edge. Four stops do it — nothing at
     * the picture, full white across the middle, nothing at the outline.
     */
    const dom = stubDom();
    const handle = installBallSize({
      diameter: () => 3,
      mount: dom.mount as unknown as HTMLElement,
    });
    for (let f = 1; f <= 120; f++) dom.step(f * 40);
    const el = handle.el as unknown as StubEl;

    const band = find(el, 'world-size-band')!;
    // `find` matches a class, and a gradient has none: it is the one child of
    // the mark's `defs`.
    const inset = find(el, 'world-size-inset')!;
    const grad = inset.children
      .flatMap((kid) => (kid.tag === 'defs' ? kid.children : []))
      .find((kid) => kid.tag === 'radialGradient');
    expect(grad).toBeTruthy();
    expect(band.tag).toBe('circle');
    // The band is filled by the gradient and by nothing else.
    expect(band.attrs['fill']).toMatch(/^url\(#rw-size-\d+-band\)$/);

    const stops = (grad?.children ?? []).filter((kid) => kid.tag === 'stop');
    expect(stops.length).toBe(4);
    const alpha = stops.map((stop) => Number(stop.attrs['stop-opacity']));
    const offset = stops.map((stop) => Number(stop.attrs['offset']));
    // Transparent at both edges, 40% across the middle.
    expect(alpha[0]).toBe(0);
    expect(alpha[1]).toBeCloseTo(BAND_ALPHA, 6);
    expect(alpha[2]).toBeCloseTo(BAND_ALPHA, 6);
    expect(alpha[3]).toBe(0);
    // The colour is the theme's light role, from the sheet — not a hex in a
    // module (TASTE §7, the achromatic gate).
    for (const stop of stops) expect(stop.attrs['class']).toBe('world-size-stop');
    expect(dom.head.children[0]!.textContent).toContain('stop-color: var(--rw-light');
    // The feather really is a fraction of the band and not a hard step.
    expect(offset[1]! - offset[0]!).toBeGreaterThan(0.01);
    expect(offset[3]! - offset[2]!).toBeGreaterThan(0.01);
    /*
     * …and the inner edge IS the picture's own edge. The offsets are
     * fractions of the gradient's own radius, so this reads them back into
     * the viewBox's units and compares with the disc: the band starts exactly
     * where the 3d view stops.
     */
    const gradR = Number(grad!.attrs['r']);
    expect(offset[0]! * gradR).toBeCloseTo((100 / 2) * (INSET_PX / ringBoxPx()), 2);
    // The outer edge is the outline's own radius, so nothing white spills
    // past the hairline.
    expect(offset[3]!).toBeCloseTo(1, 6);
    expect(BAND_FEATHER).toBeGreaterThan(0);

    // The outline outermost: the project's wavering hand at a hairline.
    const ring = find(el, 'world-size-inset-ring')!;
    expect(ring.tag).toBe('path');
    expect((ring.attrs['d'] ?? '').length).toBeGreaterThan(80);
    // The stroke is in viewBox units, so its rendered weight is that times
    // the box-to-pixel scale — a hairline at any size.
    const width = Number(ring.attrs['stroke-width']);
    expect((width * ringBoxPx()) / 100).toBeCloseTo(1.25, 3);
    handle.dispose();
    dom.restore();
  });

  it('takes itself off the page on dispose, and stops asking for frames', () => {
    const dom = stubDom();
    let reads = 0;
    const handle = installBallSize({
      diameter: () => {
        reads++;
        return 2;
      },
      mount: dom.mount as unknown as HTMLElement,
    });
    dom.step(40);
    expect(dom.mount.children.length).toBe(1);
    const after = reads;
    handle.dispose();
    expect(dom.mount.children.length).toBe(0);
    // The loop is cancelled: nothing is queued, so nothing reads again.
    dom.step(80);
    expect(reads).toBe(after);
    dom.restore();
  });

  it('mounts one sheet however many readouts are installed', () => {
    const dom = stubDom();
    const a = installBallSize({
      diameter: () => 1,
      mount: dom.mount as unknown as HTMLElement,
    });
    const b = installBallSize({
      diameter: () => 1,
      mount: dom.mount as unknown as HTMLElement,
    });
    expect(dom.head.children.length).toBe(1);
    a.dispose();
    b.dispose();
    dom.restore();
  });

  it('is marks only — no filled panel, no card, no shadow (TASTE §4)', () => {
    const dom = stubDom();
    const handle = installBallSize({
      diameter: () => 1,
      mount: dom.mount as unknown as HTMLElement,
    });
    const sheet = dom.head.children[0]!.textContent;
    /*
     * The marks, after the 2026-09-17 mock: the wavering OUTLINE, the type on
     * the band, and the band's own feathered white — the recorded paper-card
     * ruling (TASTE §9a) at the softest it has been drawn. One hairline, one
     * fill, both by the project's own hand, and no straight rule anywhere.
     */
    expect(sheet).toContain('.world-size-inset-ring');
    expect(sheet).toContain('.world-size-value');
    expect(sheet).not.toContain('border-bottom');
    // …and the marks that are not in this taste's vocabulary are not.
    expect(sheet).not.toMatch(/\bbackground\b/);
    expect(sheet).not.toMatch(/box-shadow/);
    expect(sheet).not.toMatch(/\bfilter\s*:\s*drop-shadow/);
    expect(sheet).not.toMatch(/border-radius/);
    // Motion is on the settle curve, never linear and never ease-in-out.
    expect(sheet).not.toMatch(/\b(?:linear|ease-in-out)\b/);
    // And the label a screen reader reads is lowercase, like every string.
    const label = (handle.el as unknown as StubEl).attrs['aria-label']!;
    expect(label).toBe(label.toLowerCase());
    handle.dispose();
    dom.restore();
  });
});

describe('the inset — the live view’s frame and its rect', () => {
  /*
   * > User ask, 2026-09-17: *"in the top left hand corner we should show a
   * > live view of the character and the objects it collects. the 3d view of
   * > the character and the object ball should not scale beyond the radius
   * > measurement ui div in the top left."*
   *
   * This module owns the MARK and the RECT; the picture inside it is
   * src/world/portrait.ts's, and the rect is the whole contract between them.
   */
  it('is one fixed mark: a disc of world inside a band', () => {
    const dom = stubDom();
    const handle = installBallSize({
      diameter: () => 2,
      mount: dom.mount as unknown as HTMLElement,
    });
    const el = handle.el as unknown as StubEl;
    for (let f = 1; f <= 120; f++) dom.step(f * 40);

    const inset = find(el, 'world-size-inset')!;
    /*
     * ONE SIZE: the disc plus the band on all four sides. It followed the
     * number's own width for an afternoon and moved the whole corner every
     * time a digit landed.
     */
    expect(Number(inset.attrs['width'])).toBe(ringBoxPx());
    expect(inset.attrs['height']).toBe(inset.attrs['width']);
    expect(ringBoxPx()).toBe(INSET_PX + 2 * BAND_PX);
    handle.dispose();
    dom.restore();
  });

  it('writes the number on the band, upright, over nothing else', () => {
    /*
     * > User mock, 2026-09-17: the size text sits on the outer radius of the
     * > circle, curving along it, *"with the text readable and flipped the
     * > correct way"*.
     *
     * So the type hangs on a `textPath` around the arc, and the arc's RADIUS
     * is what keeps it off both the picture and the outline: outside the
     * disc, inside the hairline.
     */
    const dom = stubDom();
    const handle = installBallSize({
      diameter: () => 2,
      mount: dom.mount as unknown as HTMLElement,
    });
    const el = handle.el as unknown as StubEl;
    for (let f = 1; f <= 200; f++) dom.step(f * 40);

    const label = find(el, 'world-size-value')!;
    expect(label.tag).toBe('text');
    const path = label.children[0]!;
    expect(path.tag).toBe('textPath');
    // It reads the corner's own number, lowercase.
    expect(path.textContent).toBe(handle.text());
    expect(path.textContent).toBe(path.textContent.toLowerCase());
    // …and it references the arc this mark generated, centred half way along
    // it so the reading stays on the lower-right diagonal at every length.
    const arc = find(el, 'world-size-arc')!;
    expect(path.attrs['href']).toBe(`#${arc.attrs['id']}`);
    expect(path.attrs['startOffset']).toBe('50%');
    expect(dom.head.children[0]!.textContent).toContain('text-anchor: middle');

    // THE ARC IS BETWEEN THE TWO EDGES: outside the disc, inside the outline.
    const d = arc.attrs['d'] ?? '';
    const nums = d.match(/-?\d+\.\d+/g)!.map(Number);
    const r = Math.hypot(nums[0]! - 50, nums[1]! - 50);
    const discR = (100 / 2) * (INSET_PX / ringBoxPx());
    const outlineR = 100 / 2 - 2;
    expect(r).toBeGreaterThan(discR);
    expect(r).toBeLessThan(outlineR);
    // And its sweep is the counter-clockwise one, which is what puts the
    // glyphs' feet on the inside (see `ringTextPath`).
    expect(d).toBe(ringTextPath(r));
    handle.dispose();
    dom.restore();
  });

  it('publishes no rect until there is something to show', () => {
    const dom = stubDom();
    const handle = installBallSize({
      diameter: () => 0,
      mount: dom.mount as unknown as HTMLElement,
    });
    for (let f = 1; f <= 40; f++) dom.step(f * 40);
    // A creature in its shell: no ball, no number — and no picture either.
    expect(handle.shown()).toBe(false);
    expect(handle.rect()).toBeNull();
    handle.dispose();
    dom.restore();
  });

  it('publishes the DISC’s box once it has — not the whole mark', () => {
    const dom = stubDom();
    const handle = installBallSize({
      diameter: () => 2,
      mount: dom.mount as unknown as HTMLElement,
    });
    for (let f = 1; f <= 200; f++) dom.step(f * 40);
    const rect = handle.rect()!;
    expect(rect).not.toBeNull();
    /*
     * The picture is the DISC, and the mark is the disc plus the band on all
     * four sides: hand the pass the whole svg and the creature would be drawn
     * under the number and under the outline.
     */
    expect(rect.w).toBe(INSET_PX);
    expect(rect.h).toBeCloseTo(rect.w, 6);
    // Inset from the mark's own corner by exactly the band.
    expect(rect.x).toBe(16 + BAND_PX);
    expect(rect.y).toBe(16 + BAND_PX);
    handle.dispose();
    dom.restore();
  });

  it('is a hairline ring and nothing else — no fill, no shadow', () => {
    const dom = stubDom();
    const handle = installBallSize({
      diameter: () => 2,
      mount: dom.mount as unknown as HTMLElement,
    });
    const el = handle.el as unknown as StubEl;
    for (let f = 1; f <= 200; f++) dom.step(f * 40);
    const ring = find(el, 'world-size-inset-ring')!;
    // A path, drawn by the project's own wavering hand, stroked at a
    // hairline in the viewBox's own units (so it is 1.25 css px at any size).
    expect(ring.tag).toBe('path');
    expect((ring.attrs['d'] ?? '').length).toBeGreaterThan(80);
    const width = Number(ring.attrs['stroke-width']);
    const size = Number(find(el, 'world-size-inset')!.attrs['width']);
    expect((width * size) / 100).toBeCloseTo(1.25, 3);

    // The sheet: the ring is unfilled, and the inset brings no surface with
    // it (TASTE §9a — paper and a hairline, nothing else). The paper inside
    // it is cleared in GL, not painted here, because this element is in
    // FRONT of the canvas.
    const sheet = dom.head.children[0]!.textContent;
    const rules = sheet.slice(sheet.indexOf('.world-size-inset'));
    expect(rules).toContain('fill: none');
    expect(rules).not.toContain('box-shadow');
    expect(rules).not.toContain('background');
    expect(rules).not.toContain('border-radius');
    handle.dispose();
    dom.restore();
  });
});

describe('the readout is absent on a world without the game', () => {
  const main = readFileSync(join(process.cwd(), 'src/main.ts'), 'utf8');

  it('is mounted only behind the katamari flag, the tray and a creature', () => {
    // One mount site, and it is inside the game's own condition — the same
    // arrangement the stick and the follow camera are under, plus the flag.
    const site = /if \(worldGame === 'katamari' && tray\?\.middle && myDrawerId\.length > 0\) \{[\s\S]{0,400}?installBallSize\(/;
    expect(main).toMatch(site);
    expect([...main.matchAll(/installBallSize\(/g)].length).toBe(1);
  });

  it('is reached by a DYNAMIC import, so no other world fetches the chunk', () => {
    // Like the object library (src/world/katamari/source.ts): a world
    // without the game must not carry this module in its first chunk.
    expect(main).toMatch(/void import\('\.\/ui\/size'\)/);
    expect(main).not.toMatch(/^import .*'\.\/ui\/size'/m);
  });

  it('reads the one identity this page already has for “mine”', () => {
    // Never a second answer to which creature is this handset's: the
    // minimap's self mark, the follow camera and the stick all read
    // `myDrawerId`, and so does this.
    expect(main).toMatch(/creatures\.ballDiameter\(myDrawerId\)/);
  });
});
