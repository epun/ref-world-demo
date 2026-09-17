/**
 * The nearest-creature arrow on the phone's minimap (src/ui/minimap.ts).
 *
 * > User ask, 2026-09-17: *"on mobile we should show a directional arrow in
 * > relation to the closest user on the minimap."*
 *
 * Four things are pinned here:
 *
 * 1. THE CHOICE. Nearest by GROUND distance, with hysteresis — two creatures
 *    the same distance away must not hand the arrow back and forth thirty
 *    times a second, so the one already being pointed at keeps it until
 *    somebody beats it by the margin.
 * 2. THE DIRECTION MATH. Inside the window the arrow is short and sits just
 *    short of their dot; outside it, it sits at the border in that direction.
 * 3. THE LABEL. Metres, through the game's own `WORLD_SCALE` conversion and
 *    not a second copy of it, lowercase, one unit (TASTE §5).
 * 4. WHERE IT IS DRAWN, and where it is NOT: a phone with a creature of its
 *    own in the katamari world, and nowhere else. A projection's map and
 *    every world without the game draw exactly what they drew before — the
 *    ink golden in test/ui/minimap.test.ts is the other half of that.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Vector3 } from 'three';
import {
  ARROW_EDGE_INSET_PX,
  ARROW_LABEL_GAP_PX,
  ARROW_LEN_PX,
  ARROW_TIP_GAP_PX,
  NEAREST_MARGIN,
  arrowMark,
  bearingLabel,
  installWorldMinimap,
  labelAnchor,
  pickNearest,
  worldMapExtent,
  type NearbyCreature,
} from '../../src/ui/minimap';
import { mapBorderInset, mapMarkScale, worldToMap, type MapFrame } from '../../src/phone/minimap';
import { metresOf } from '../../src/ui/size';
import { WORLD_SCALE } from '../../src/world/katamari/rules';
import { setIslandMode, setLandscapeMode } from '../../src/world/landscape';

/* The arrow belongs to the katamari world, whose map is the island. */
beforeAll(() => {
  setLandscapeMode('landscape');
  setIslandMode(true);
});
afterAll(() => {
  setLandscapeMode('plain');
  setIslandMode(false);
});

const frame: MapFrame = { w: 200, h: 200, inset: 14 };

describe('pickNearest — the closest other creature, and it does not flicker', () => {
  const others: NearbyCreature[] = [
    { id: 'far', x: 60, z: 0 },
    { id: 'near', x: 0, z: 10 },
    { id: 'mid', x: 20, z: 20 },
  ];

  it('picks by ground distance', () => {
    const hit = pickNearest({ x: 0, z: 0 }, others)!;
    expect(hit.id).toBe('near');
    expect(hit.dist).toBeCloseTo(10, 6);
  });

  it('is nothing at all when this handset is alone in the room', () => {
    expect(pickNearest({ x: 0, z: 0 }, [])).toBe(null);
  });

  it('refuses a self that is not a position', () => {
    expect(pickNearest(null, others)).toBe(null);
    expect(pickNearest({ x: Number.NaN, z: 0 }, others)).toBe(null);
  });

  it('skips a creature with no id or no place', () => {
    expect(
      pickNearest({ x: 0, z: 0 }, [
        { id: '', x: 1, z: 0 },
        { id: 'bad', x: Number.NaN, z: 0 },
        { id: 'ok', x: 30, z: 0 },
      ])!.id,
    ).toBe('ok');
  });

  it('HOLDS the creature it is pointing at until somebody beats it by the margin', () => {
    const a: NearbyCreature = { id: 'a', x: 0, z: 10 };
    // Within the margin: a hair closer, and not enough to take the arrow.
    const closer: NearbyCreature = { id: 'b', x: 0, z: 10 * (1 - NEAREST_MARGIN / 2) };
    expect(pickNearest({ x: 0, z: 0 }, [a, closer], 'a')!.id).toBe('a');
    // …and with nobody held, the closer one simply wins.
    expect(pickNearest({ x: 0, z: 0 }, [a, closer], null)!.id).toBe('b');
    // Past the margin it changes its mind.
    const much: NearbyCreature = { id: 'b', x: 0, z: 10 * (1 - NEAREST_MARGIN * 2) };
    expect(pickNearest({ x: 0, z: 0 }, [a, much], 'a')!.id).toBe('b');
  });

  it('gives the arrow up when the creature it held has gone', () => {
    const hit = pickNearest({ x: 0, z: 0 }, others, 'retired')!;
    expect(hit.id).toBe('near');
  });

  it('keeps the held one on an exact tie, which is where a flicker lives', () => {
    const a: NearbyCreature = { id: 'a', x: 0, z: 10 };
    const b: NearbyCreature = { id: 'b', x: 10, z: 0 };
    expect(pickNearest({ x: 0, z: 0 }, [a, b], 'b')!.id).toBe('b');
    expect(pickNearest({ x: 0, z: 0 }, [a, b], 'a')!.id).toBe('a');
  });
});

describe('bearingLabel — one unit, lowercase, at a glance', () => {
  it('reads whole metres from a metre up', () => {
    expect(bearingLabel(12)).toBe('12m');
    expect(bearingLabel(12.4)).toBe('12m');
    expect(bearingLabel(12.6)).toBe('13m');
    expect(bearingLabel(1)).toBe('1m');
  });

  it('drops to centimetres while metres would say nothing', () => {
    expect(bearingLabel(0.34)).toBe('34cm');
    expect(bearingLabel(0.004)).toBe('0cm');
  });

  it('survives nonsense, and never carries a capital (TASTE §5)', () => {
    expect(bearingLabel(0)).toBe('0cm');
    expect(bearingLabel(-3)).toBe('0cm');
    expect(bearingLabel(Number.NaN)).toBe('0cm');
    for (const m of [0, 0.3, 1, 12.4, 400]) {
      expect(bearingLabel(m)).not.toMatch(/[A-Z]/);
    }
  });

  it('measures on the game’s own ruler and not a second copy of it', () => {
    // The label is metresOf(units) — the one conversion the ball readout in
    // the other corner uses (src/ui/size.ts).
    expect(metresOf(10)).toBeCloseTo(10 / WORLD_SCALE, 12);
    expect(bearingLabel(metresOf(10))).toBe(`${Math.round(10 / WORLD_SCALE)}m`);
  });
});

describe('arrowMark — inside the window, and outside it', () => {
  const self = { px: 100, py: 100 };

  it('points at the dot, short, when the creature is on the map', () => {
    const target = { px: 140, py: 100 };
    const mark = arrowMark(self, target, frame)!;
    expect(mark.inside).toBe(true);
    expect(mark.angle).toBeCloseTo(0, 6);
    // Just short of their dot, and no longer than one arrow.
    expect(mark.tipX).toBeCloseTo(140 - ARROW_TIP_GAP_PX, 6);
    expect(mark.tipY).toBeCloseTo(100, 6);
    expect(mark.length).toBeLessThanOrEqual(ARROW_LEN_PX);
  });

  it('keeps the arrow inside the dot it points at when they are close', () => {
    const mark = arrowMark(self, { px: 103, py: 100 }, frame)!;
    // Nearer than the gap: the mark shrinks to nothing rather than
    // overshooting backwards past the self dot.
    expect(mark.length).toBe(0);
    expect(mark.tipX).toBeCloseTo(100, 6);
  });

  it('sits at the border, just inside it, when the creature is off the map', () => {
    const mark = arrowMark(self, { px: 400, py: 100 }, frame)!;
    expect(mark.inside).toBe(false);
    expect(mark.angle).toBeCloseTo(0, 6);
    expect(mark.tipX).toBeCloseTo(frame.w - frame.inset - ARROW_EDGE_INSET_PX, 6);
    expect(mark.tipY).toBeCloseTo(100, 6);
    expect(mark.length).toBe(ARROW_LEN_PX);
  });

  it('leaves through the nearer edge on a diagonal', () => {
    // Far away and mostly north: it must leave through the top, not the side.
    const mark = arrowMark(self, { px: 260, py: -900 }, frame)!;
    expect(mark.inside).toBe(false);
    // Pulled back ALONG the ray, so its y sits between the edge and one
    // inset inside it rather than exactly on that line.
    expect(mark.tipY).toBeGreaterThan(frame.inset);
    expect(mark.tipY).toBeLessThan(frame.inset + ARROW_EDGE_INSET_PX + 1);
    expect(mark.tipX).toBeGreaterThan(self.px);
    expect(mark.tipX).toBeLessThan(frame.w - frame.inset);
  });

  it('carries the direction, whichever way they are', () => {
    for (const [dx, dy] of [
      [1, 0],
      [0, 1],
      [-1, 0],
      [0, -1],
      [1, 1],
    ] as const) {
      const mark = arrowMark(self, { px: self.px + dx * 500, py: self.py + dy * 500 }, frame)!;
      expect(mark.angle).toBeCloseTo(Math.atan2(dy, dx), 6);
    }
  });

  it('scales with the map’s own mark scale', () => {
    const small = arrowMark(self, { px: 400, py: 100 }, frame, 0.5)!;
    expect(small.length).toBeCloseTo(ARROW_LEN_PX * 0.5, 6);
  });

  it('is nothing when there is no direction between them', () => {
    expect(arrowMark(self, { px: 100, py: 100 }, frame)).toBe(null);
  });
});

describe('labelAnchor — the distance sits beside the arrow, never on it', () => {
  it('is off the arrow at a right angle, by the gap', () => {
    const mark = arrowMark({ px: 100, py: 100 }, { px: 160, py: 100 }, frame)!;
    const at = labelAnchor(mark, frame);
    // A right angle: on the arrow's own axis it is only pulled back along
    // the shaft, and off it by exactly the gap.
    const alongX = at.x - mark.tipX;
    const acrossY = Math.abs(at.y - mark.tipY);
    expect(acrossY).toBeCloseTo(ARROW_LABEL_GAP_PX, 6);
    expect(alongX).toBeLessThan(0);
  });

  it('falls on the side that faces into the map, wherever the arrow is', () => {
    const centre = { px: frame.w / 2, py: frame.h / 2 };
    for (const [dx, dy] of [
      [1, 0],
      [0, 1],
      [-1, 0],
      [0, -1],
      [1, 1],
      [-1, 1],
    ] as const) {
      const mark = arrowMark(centre, { px: centre.px + dx * 900, py: centre.py + dy * 900 }, frame)!;
      const at = labelAnchor(mark, frame);
      // Closer to the middle than the tip it is labelling: a label that fell
      // outward would be drawn under the border, or clipped away by it.
      const tipOut = Math.hypot(mark.tipX - centre.px, mark.tipY - centre.py);
      const labelOut = Math.hypot(at.x - centre.px, at.y - centre.py);
      expect(labelOut).toBeLessThan(tipOut);
    }
  });

  it('never lands on the self dot the short arrow starts from', () => {
    // The case that sent it there: somebody a few metres away, so the whole
    // arrow is a handful of pixels long.
    const from = { px: 100, py: 100 };
    const mark = arrowMark(from, { px: 112, py: 100 }, frame)!;
    const at = labelAnchor(mark, frame);
    expect(Math.hypot(at.x - from.px, at.y - from.py)).toBeGreaterThan(
      ARROW_LABEL_GAP_PX * 0.9,
    );
  });
});

// ── the drawn arrow ──────────────────────────────────────────────────────────

interface Stroke {
  points: [number, number][];
}
interface Label {
  text: string;
  x: number;
  y: number;
  font: string;
}
interface Draws {
  strokes: Stroke[];
  labels: Label[];
  canvases: number;
}

/** A 2d context that records what it is asked to stroke and to write. The
 * marks the rest of the map draws are covered by test/ui/minimap.test.ts;
 * this one only has to see the arrow. */
function recordingCtx(draws: Draws): CanvasRenderingContext2D {
  let path: [number, number][] = [];
  const ctx = {
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 0,
    lineJoin: '',
    font: '',
    textAlign: '',
    textBaseline: '',
    imageSmoothingEnabled: true,
    setTransform(): void {},
    clearRect(): void {},
    translate(): void {},
    save(): void {},
    restore(): void {},
    clip(): void {},
    drawImage(): void {},
    beginPath(): void {
      path = [];
    },
    moveTo(x: number, y: number): void {
      path.push([x, y]);
    },
    lineTo(x: number, y: number): void {
      path.push([x, y]);
    },
    quadraticCurveTo(_cx: number, _cy: number, x: number, y: number): void {
      path.push([x, y]);
    },
    arc(x: number, y: number): void {
      path.push([x, y]);
    },
    closePath(): void {},
    fill(): void {},
    stroke(): void {
      draws.strokes.push({ points: [...path] });
    },
    fillText(text: string, x: number, y: number): void {
      draws.labels.push({ text, x, y, font: String(ctx.font) });
    },
  };
  return ctx as unknown as CanvasRenderingContext2D;
}

function stubDom(draws: Draws, size = 200): { draw: (now?: number) => void; restore: () => void } {
  const canvas = {
    className: '',
    width: 0,
    height: 0,
    style: {},
    setAttribute(): void {},
    addEventListener(): void {},
    removeEventListener(): void {},
    remove(): void {},
    getBoundingClientRect: () => ({ width: size, height: size, left: 0, top: 0 }),
    getContext: () => recordingCtx(draws),
  };
  let frameCb: FrameRequestCallback | null = null;
  const globals = globalThis as Record<string, unknown>;
  const before = {
    document: globals.document,
    window: globals.window,
    raf: globals.requestAnimationFrame,
    caf: globals.cancelAnimationFrame,
  };
  globals.document = {
    hidden: false,
    head: { appendChild(): void {} },
    getElementById: () => null,
    createElement: (tag: string) => {
      if (tag !== 'canvas') return { id: '', textContent: '', style: {} };
      draws.canvases += 1;
      return draws.canvases === 1
        ? canvas
        : {
            width: 0,
            height: 0,
            getContext: () => ({
              createImageData: (w: number, h: number) => ({
                width: w,
                height: h,
                data: new Uint8ClampedArray(w * h * 4),
              }),
              putImageData: (): void => {},
            }),
          };
    },
    addEventListener(): void {},
    removeEventListener(): void {},
  };
  globals.window = { devicePixelRatio: 1 };
  globals.requestAnimationFrame = (cb: FrameRequestCallback): number => {
    frameCb = cb;
    return 1;
  };
  globals.cancelAnimationFrame = (): void => {};
  return {
    draw: (now = 1000): void => {
      const cb = frameCb;
      frameCb = null;
      cb?.(now);
    },
    restore: (): void => {
      globals.document = before.document;
      globals.window = before.window;
      globals.requestAnimationFrame = before.raf;
      globals.cancelAnimationFrame = before.caf;
    },
  };
}

interface ArrowRun {
  self?: { x: number; z: number };
  poses?: NearbyCreature[];
  me?: string;
  /** Hand the config over after the mount, the way src/main.ts does. */
  late?: boolean;
  size?: number;
}

function drawArrow(run: ArrowRun): Draws {
  const draws: Draws = { strokes: [], labels: [], canvases: 0 };
  const dom = stubDom(draws, run.size ?? 200);
  const config = run.poses
    ? {
        poses: () => run.poses!,
        me: run.me ?? 'me',
        metres: metresOf,
      }
    : null;
  const handle = installWorldMinimap({
    manager: { positions: () => [] },
    cameraRig: {
      azimuth: 0,
      frameAt: (): void => {},
      camera: {
        position: { x: 0, y: 40, z: 40 },
        getWorldDirection: (t: Vector3): Vector3 => t.set(0, -1, -1).normalize(),
      },
    },
    mount: { appendChild: (): void => {} } as unknown as HTMLElement,
    ...(run.self ? { self: () => run.self! } : {}),
    ...(config && !run.late ? { nearest: config } : {}),
  });
  if (config && run.late) handle.setNearest(config);
  dom.draw(1000);
  handle.dispose();
  dom.restore();
  return draws;
}

/** The map's own frame at a given inset size — the numbers the draw loop
 * derives, so the assertions can be about world points, not px guesses. */
function frameFor(size: number): { frame: MapFrame; scale: number } {
  const scale = mapMarkScale(size);
  const inset = mapBorderInset(scale);
  return { frame: { w: size, h: size, inset: inset + 5 * scale }, scale };
}

describe('the phone’s map points at the nearest other creature', () => {
  const me = { x: 0, z: 0 };

  it('draws nothing when there is nobody else', () => {
    const alone = drawArrow({ self: me, poses: [{ id: 'me', x: 0, z: 0 }], me: 'me' });
    expect(alone.labels).toEqual([]);
  });

  it('draws a shaft, a head and a distance when somebody is out there', () => {
    const them = { id: 'you', x: 40, z: 0 };
    const draws = drawArrow({ self: me, poses: [{ id: 'me', ...me }, them], me: 'me' });
    expect(draws.labels.length).toBe(1);
    const dist = Math.hypot(them.x - me.x, them.z - me.z);
    expect(draws.labels[0]!.text).toBe(bearingLabel(metresOf(dist)));
    // Lowercase type, at a small size, in the map's own face.
    expect(draws.labels[0]!.font).toMatch(/px ui-sans-serif/);
    expect(draws.labels[0]!.text).not.toMatch(/[A-Z]/);
    // The last two strokes inside the field are the arrow's — a two-point
    // shaft and a head of two hairlines off one point — and then the map's
    // own border goes over the top of everything, as it always has.
    const shaft = draws.strokes.at(-3)!;
    const head = draws.strokes.at(-2)!;
    expect(shaft.points.length).toBe(2);
    expect(head.points.length).toBe(4);
    expect(head.points[0]).toEqual(head.points[2]);
  });

  it('points AT their dot when they are on the map, from the self dot', () => {
    const them = { id: 'you', x: 40, z: 0 };
    const size = 200;
    const draws = drawArrow({ self: me, poses: [{ id: 'me', ...me }, them], me: 'me', size });
    const { frame: mapFrame, scale } = frameFor(size);
    const from = worldToMap(me.x, me.z, worldMapExtent(), mapFrame);
    const to = worldToMap(them.x, them.z, worldMapExtent(), mapFrame);
    const expected = arrowMark(from, to, mapFrame, scale)!;
    expect(expected.inside).toBe(true);
    const shaft = draws.strokes.at(-3)!;
    const tip = shaft.points[1]!;
    expect(tip[0]).toBeCloseTo(expected.tipX, 6);
    expect(tip[1]).toBeCloseTo(expected.tipY, 6);
    // …and the tail is behind it, toward you.
    expect(shaft.points[0]![0]).toBeLessThan(tip[0]);
  });

  it('sits at the border when they are off the window', () => {
    // Well outside the mapped square.
    const them = { id: 'you', x: worldMapExtent() * 4, z: 0 };
    const size = 200;
    const draws = drawArrow({ self: me, poses: [{ id: 'me', ...me }, them], me: 'me', size });
    const { frame: mapFrame, scale } = frameFor(size);
    const from = worldToMap(me.x, me.z, worldMapExtent(), mapFrame);
    const to = worldToMap(them.x, them.z, worldMapExtent(), mapFrame);
    const expected = arrowMark(from, to, mapFrame, scale)!;
    expect(expected.inside).toBe(false);
    const tip = draws.strokes.at(-3)!.points[1]!;
    expect(tip[0]).toBeCloseTo(expected.tipX, 6);
    // Just inside the frame, never over it.
    expect(tip[0]).toBeLessThan(mapFrame.w - mapFrame.inset);
    expect(tip[0]).toBeGreaterThan(mapFrame.w / 2);
  });

  it('is drawn when the config arrives after the mount, as main.ts hands it', () => {
    const them = { id: 'you', x: 40, z: 0 };
    const draws = drawArrow({
      self: me,
      poses: [{ id: 'me', ...me }, them],
      me: 'me',
      late: true,
    });
    expect(draws.labels.length).toBe(1);
  });

  it('is absent on a PROJECTION — no self, nothing to point from', () => {
    const draws = drawArrow({ poses: [{ id: 'a', x: 40, z: 0 }], me: 'me' });
    expect(draws.labels).toEqual([]);
  });

  it('is absent with no config at all — every world without the game', () => {
    const draws = drawArrow({ self: me });
    expect(draws.labels).toEqual([]);
  });
});

describe('the arrow is the phone’s, and only in the game', () => {
  const main = readFileSync(join(process.cwd(), 'src/main.ts'), 'utf8');

  it('is handed over behind the katamari flag, the tray and a creature', () => {
    // The window is "inside the same block", not a byte count: the corner's
    // live view landed between the two on 2026-09-17 (src/world/portrait.ts),
    // which is a third thing handed over under the same three conditions.
    const site =
      /if \(worldGame === 'katamari' && tray\?\.middle && myDrawerId\.length > 0\) \{[\s\S]{0,3600}?setNearest\(/;
    expect(main).toMatch(site);
    expect([...main.matchAll(/setNearest\(/g)].length).toBe(1);
  });

  it('reads the one identity this page already has for “mine”', () => {
    expect(main).toMatch(/me: myDrawerId/);
    expect(main).toMatch(/poses: \(\) => creatures\.poses\(\)/);
  });

  it('takes its metre conversion from the readout’s own module', () => {
    // Not a second copy of WORLD_SCALE, and not a static import of the
    // katamari rules into every world's first chunk.
    expect(main).toMatch(/metres: m\.metresOf/);
    expect(main).not.toMatch(/WORLD_SCALE/);
    const map = readFileSync(join(process.cwd(), 'src/ui/minimap.ts'), 'utf8');
    expect(map).not.toMatch(/from '\.\.\/world\/katamari\//);
    expect(map).not.toMatch(/from '\.\/size'/);
  });
});
