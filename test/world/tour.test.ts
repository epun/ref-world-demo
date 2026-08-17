/**
 * Presentation-tour tests — pure logic over a fake camera rig. No WebGL, no
 * DOM: the tour drives its rig through a structural interface, so a recorder
 * stands in for CameraRig and simulated time advances the state machine.
 */

import { describe, expect, it } from 'vitest';
import {
  CLOSE_ZOOM,
  CLUSTER_RADIUS,
  createTour,
  DWELL_MAX_MS,
  DWELL_MIN_MS,
  dwellDurationMs,
  findClusters,
  HATCH_HOLD_MS,
  HATCH_SLIDE_MS,
  HATCH_WIDE_ZOOM,
  isScenicTick,
  ORBIT_DRIFT_RAD_PER_SEC,
  pickSubject,
  scoreSubjects,
  WIDE_ZOOM,
  type EntityPoint,
} from '../../src/world/tour';

function pt(x: number, z: number, kind: EntityPoint['kind'] = 'character'): EntityPoint {
  return { x, z, r: 1, kind };
}

interface RigLog {
  frameAt: { x: number; y: number; z: number }[];
  zoomTo: number[];
  orbitDrift: number[];
}

function fakeRig(): { log: RigLog; rig: Parameters<typeof createTour>[0]['cameraRig'] } {
  const log: RigLog = { frameAt: [], zoomTo: [], orbitDrift: [] };
  return {
    log,
    rig: {
      frameAt: (p) => log.frameAt.push({ ...p }),
      zoomTo: (t) => log.zoomTo.push(t),
      orbitDrift: (r) => log.orbitDrift.push(r),
    },
  };
}

/** First tick whose scenic gate is closed — subject scoring runs there. */
function nonScenicTick(from = 0): number {
  for (let t = from; t < from + 100; t++) {
    if (!isScenicTick(t)) return t;
  }
  throw new Error('no non-scenic tick found in range');
}

/** Step a tour in fixed frames; returns total elapsed ms. */
function step(tour: ReturnType<typeof createTour>, ms: number, frameMs = 50): number {
  let elapsed = 0;
  while (elapsed < ms) {
    const h = Math.min(frameMs, ms - elapsed);
    tour.update(h, elapsed);
    elapsed += h;
  }
  return elapsed;
}

describe('interest scoring', () => {
  it('groups entities within the cluster radius, transitively', () => {
    const chain = [pt(0, 0), pt(CLUSTER_RADIUS - 2, 0), pt(2 * (CLUSTER_RADIUS - 2), 0)];
    const clusters = findClusters(chain);
    expect(clusters).toHaveLength(1);
    expect(clusters[0]?.size).toBe(3);

    const apart = [pt(0, 0), pt(CLUSTER_RADIUS * 3, 0)];
    expect(findClusters(apart)).toHaveLength(2);
  });

  it('prefers clusters over singles, with wide zoom for the cluster', () => {
    const points = [pt(0, 0), pt(5, 0), pt(60, 60)];
    const tick = nonScenicTick();
    const ranked = scoreSubjects(points, tick, null);
    expect(ranked[0]?.kind).toBe('cluster');
    expect(ranked[0]?.x).toBeCloseTo(2.5);
    expect(ranked[0]?.z).toBeCloseTo(0);
    expect(ranked[0]?.zoom).toBe(WIDE_ZOOM);
    const single = ranked.find((s) => s.kind === 'single');
    expect(single?.zoom).toBe(CLOSE_ZOOM);
    // The gap is a band, not a jitter artifact: any cluster beats any single.
    expect((ranked[0]?.score ?? 0) - (single?.score ?? 0)).toBeGreaterThan(1);
  });

  it('penalizes the previous dwell target so the tour keeps moving', () => {
    const points = [pt(0, 0), pt(40, 40)];
    const tick = nonScenicTick();
    const fresh = scoreSubjects(points, tick, null);
    const revisiting = scoreSubjects(points, tick, { x: fresh[0]?.x ?? 0, z: fresh[0]?.z ?? 0 });
    expect(revisiting[0]?.x).not.toBeCloseTo(fresh[0]?.x ?? 0);
  });

  it('always goes scenic on an empty world', () => {
    for (let tick = 0; tick < 10; tick++) {
      expect(pickSubject([], tick, null).kind).toBe('scenic');
    }
  });
});

describe('dwell + scenic pacing (deterministic, no Math.random)', () => {
  it('dwell durations are within bounds and reproducible from the tick', () => {
    for (let tick = 0; tick < 100; tick++) {
      const d = dwellDurationMs(tick);
      expect(d).toBeGreaterThanOrEqual(DWELL_MIN_MS);
      expect(d).toBeLessThan(DWELL_MAX_MS);
      expect(dwellDurationMs(tick)).toBe(d);
    }
    // Seeded, not constant.
    const all = new Set(Array.from({ length: 100 }, (_, t) => dwellDurationMs(t)));
    expect(all.size).toBeGreaterThan(50);
  });

  it('respects a custom dwell range', () => {
    for (let tick = 0; tick < 50; tick++) {
      const d = dwellDurationMs(tick, 4000, 8000);
      expect(d).toBeGreaterThanOrEqual(4000);
      expect(d).toBeLessThan(8000);
    }
  });

  it('scenic beats land at roughly 1 in 4 over 100 picks', () => {
    let scenic = 0;
    for (let tick = 0; tick < 100; tick++) {
      if (pickSubject([pt(10, 10), pt(-30, 20)], tick, null).kind === 'scenic') scenic++;
    }
    expect(scenic).toBeGreaterThanOrEqual(15);
    expect(scenic).toBeLessThanOrEqual(35);
  });

  it('two tours over the same world produce identical camera sequences', () => {
    const points = [pt(0, 0), pt(6, 2), pt(-40, 30), pt(50, -45)];
    const run = (): RigLog => {
      const { log, rig } = fakeRig();
      const tour = createTour({ cameraRig: rig, positions: () => points });
      tour.setMode('tour');
      step(tour, 60000);
      return log;
    };
    expect(run()).toEqual(run());
  });
});

describe('modes + user interrupt', () => {
  it('starts manual and does not move the camera until enabled', () => {
    const { log, rig } = fakeRig();
    const tour = createTour({ cameraRig: rig, positions: () => [pt(3, 3)] });
    expect(tour.mode()).toBe('manual');
    step(tour, 30000);
    expect(log.frameAt).toHaveLength(0);
    expect(log.zoomTo).toHaveLength(0);
  });

  it('tour mode frames a subject immediately and drifts the orbit', () => {
    const { log, rig } = fakeRig();
    const tour = createTour({ cameraRig: rig, positions: () => [pt(3, 3)] });
    tour.setMode('tour');
    expect(log.orbitDrift.at(-1)).toBe(ORBIT_DRIFT_RAD_PER_SEC);
    tour.update(16, 0);
    expect(log.frameAt).toHaveLength(1);
    expect(log.zoomTo).toHaveLength(1);
  });

  it('advances to a new dwell only after the seeded dwell time', () => {
    const { log, rig } = fakeRig();
    const tour = createTour({
      cameraRig: rig,
      positions: () => [pt(0, 0), pt(40, 40), pt(-40, 20)],
    });
    tour.setMode('tour');
    tour.update(16, 0);
    expect(log.frameAt).toHaveLength(1);
    step(tour, DWELL_MIN_MS - 200);
    expect(log.frameAt).toHaveLength(1);
    step(tour, DWELL_MAX_MS);
    expect(log.frameAt.length).toBeGreaterThanOrEqual(2);
  });

  it('user input flips to manual instantly and the tour stays off', () => {
    const { log, rig } = fakeRig();
    const tour = createTour({ cameraRig: rig, positions: () => [pt(3, 3)] });
    tour.setMode('tour');
    tour.update(16, 0);
    const frames = log.frameAt.length;
    tour.notifyUserInput();
    expect(tour.mode()).toBe('manual');
    expect(log.orbitDrift.at(-1)).toBe(0);
    // No resume on its own — only an explicit re-enable brings it back.
    step(tour, 60000);
    expect(log.frameAt).toHaveLength(frames);
    tour.setMode('tour');
    tour.update(16, 0);
    expect(log.frameAt.length).toBeGreaterThan(frames);
  });
});

describe('hatch-all moment', () => {
  it('slides wide to the centroid, fires the burst after the slide, holds, and stays manual', () => {
    const { log, rig } = fakeRig();
    const points = [pt(10, 0, 'egg'), pt(-10, 0, 'egg'), pt(0, 30, 'egg')];
    const tour = createTour({ cameraRig: rig, positions: () => points });
    let bursts = 0;
    tour.hatchAllMoment(() => bursts++);

    // Leg 1: wide zoom + centroid reframe, immediately, via the spring apis.
    expect(log.zoomTo.at(-1)).toBe(HATCH_WIDE_ZOOM);
    expect(log.frameAt.at(-1)?.x).toBeCloseTo(0);
    expect(log.frameAt.at(-1)?.z).toBeCloseTo(10);

    // Leg 2: the burst waits for the slide to settle.
    step(tour, HATCH_SLIDE_MS - 100);
    expect(bursts).toBe(0);
    step(tour, 200);
    expect(bursts).toBe(1);

    // Leg 3: the hold reframes nothing and never re-fires.
    const framesAtBurst = log.frameAt.length;
    step(tour, HATCH_HOLD_MS + 200);
    expect(bursts).toBe(1);
    expect(log.frameAt).toHaveLength(framesAtBurst);

    // Leg 4: manual was active, so manual stays — no tour pickup after.
    expect(tour.mode()).toBe('manual');
    step(tour, 30000);
    expect(log.frameAt).toHaveLength(framesAtBurst);
  });

  it('resumes the tour with a fresh dwell after the hold', () => {
    const { log, rig } = fakeRig();
    const tour = createTour({
      cameraRig: rig,
      positions: () => [pt(20, 20), pt(-25, 5)],
    });
    tour.setMode('tour');
    tour.update(16, 0);
    tour.hatchAllMoment(() => undefined);
    // Drift pauses for the wide hold, resumes for the tour.
    expect(log.orbitDrift.at(-1)).toBe(0);
    const framesAfterTrigger = log.frameAt.length; // includes the wide reframe
    step(tour, HATCH_SLIDE_MS + HATCH_HOLD_MS + 1000);
    expect(tour.mode()).toBe('tour');
    expect(log.orbitDrift.at(-1)).toBe(ORBIT_DRIFT_RAD_PER_SEC);
    // The tour picked its next dwell after the hold released.
    expect(log.frameAt.length).toBeGreaterThan(framesAfterTrigger);
  });

  it('user input during the slide cancels the script but still fires the burst', () => {
    const { rig } = fakeRig();
    const tour = createTour({ cameraRig: rig, positions: () => [pt(0, 0, 'egg')] });
    tour.setMode('tour');
    let bursts = 0;
    tour.hatchAllMoment(() => bursts++);
    step(tour, 200);
    expect(bursts).toBe(0);
    tour.notifyUserInput();
    expect(bursts).toBe(1);
    expect(tour.mode()).toBe('manual');
    // The hold no longer runs — nothing re-fires later.
    step(tour, HATCH_SLIDE_MS + HATCH_HOLD_MS);
    expect(bursts).toBe(1);
  });

  it('ignores a re-trigger while the moment is running', () => {
    const { rig } = fakeRig();
    const tour = createTour({ cameraRig: rig, positions: () => [pt(0, 0, 'egg')] });
    let bursts = 0;
    tour.hatchAllMoment(() => bursts++);
    tour.hatchAllMoment(() => bursts++);
    step(tour, HATCH_SLIDE_MS + HATCH_HOLD_MS + 200);
    expect(bursts).toBe(1);
  });
});

describe('dispose', () => {
  it('stops the drift and goes inert', () => {
    const { log, rig } = fakeRig();
    const tour = createTour({ cameraRig: rig, positions: () => [pt(1, 1)] });
    tour.setMode('tour');
    tour.dispose();
    expect(log.orbitDrift.at(-1)).toBe(0);
    const frames = log.frameAt.length;
    step(tour, 30000);
    expect(log.frameAt).toHaveLength(frames);
  });
});
