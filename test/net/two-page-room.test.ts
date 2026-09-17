/**
 * TWO PAGES IN ONE ROOM — the path nothing tested.
 *
 * > User report, 2026-09-17, phones on the production build: *"people can't
 * > move on their mobile devices"*, *"some characters get stuck when trying to
 * > move and glitch on mobile"*.
 *
 * Every single-page path was already pinned: a hatchling drives
 * (test/creatures/manager.test.ts), a phone that hosts with no rapier at all
 * drives (test/creatures/phone-host.test.ts). What nobody had ever exercised
 * is the MULTI-PAGE room, which is what every phone in a room actually is:
 *
 *   a handset is a VIEWER. Its stick does not move its creature — it states
 *   an intent, publishes it, and the page that is simulating applies it and
 *   sends the result back as a pose (src/net/worldsync.ts). Four hops, two
 *   pages, and the creature the person is watching is at the far end of it.
 *
 * So this is two real `CreatureManager`s and the real pure codec, wired to
 * each other through an in-memory bus with the same handling order
 * src/main.ts uses — claims, then the three messages that travel sideways or
 * up (`drive`, `hatchall`, `scene`), then the host's own description of the
 * world. Nothing here mocks the manager: the drive lands in the same
 * `drive()`, the poses come out of the same `poses()`, and the viewer's
 * creature is placed by the same `followPoses`.
 *
 * What it pins, each of which was a bug on 2026-09-17:
 *
 *   1. a VIEWER's driven creature moves, on both pages;
 *   2. a HOST HANDOFF leaves the creature where it was — no flight across the
 *      field, and no stale drive taking effect on the page that takes over
 *      (`clearDrives`, which is the *"stuck"* and the *"glitch"* at once);
 *   3. a PASSENGER's drive steers its carrier across the wire;
 *   4. the uplink's own rules: a held stick repeats at the rate it is read
 *      at, and the release is never dropped by the rate cap.
 */

import { Group, Scene, Vector3, type Object3D } from 'three';
import { beforeAll, describe, expect, it } from 'vitest';
import { createCreatureManager, type CreatureManager } from '../../src/creatures/manager';
import type { Collider } from '../../src/physics/colliders';
import type { LooseMeshes } from '../../src/world/loose';
import type { WorldHandles } from '../../src/world/scene';
import { ROLLING_SURFACE } from '../../src/world/surface';
import {
  DRIVE_INTERVAL_MS,
  DRIVE_PACE_MS,
  DRIVE_STALE_MS,
  HOST_HEARTBEAT_MS,
  HOST_STALE_MS,
  POSE_INTERVAL_MS,
  ROSTER_REPEAT_MS,
  createDriveUplink,
  electHost,
  makeHostId,
  packPoses,
  pruneClaims,
  readWorldSyncMessage,
  unpackPoses,
  type HostRole,
} from '../../src/net/worldsync';
import { snowman } from '../fixtures/strokes';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** src/main.ts, for the three lines this harness mirrors. */
const mainSrc = (): string => readFileSync(join(process.cwd(), 'src/main.ts'), 'utf8');

/** A phone's frame. */
const FRAME_MS = 33;

/** The instance scale a library-backed prop is drawn at. Well away from 1, so
 * a page that falls back to 1 is visibly wrong rather than arguably wrong. */
const LIBRARY_SCALE = 2.4;

beforeAll(() => {
  const g = globalThis as { document?: unknown };
  if (typeof g.document === 'undefined') {
    g.document = { createElement: () => ({ width: 0, height: 0, getContext: () => null }) };
  }
});

/**
 * A `LooseMeshes` that draws nothing and remembers everything.
 *
 * It DOES apply the scale, like the real module (src/world/loose.ts sets
 * `mesh.scale.setScalar(scale)` at creation) — the seat overwrites it with the
 * countered value a moment later, and a stub that ignored it could not tell
 * the difference between the two.
 */
function stubLoose(scene: Scene): LooseMeshes {
  const objects = new Map<string, Object3D>();
  return {
    show(item: string, _kind: string, _variant: number, scale: number): Object3D {
      const existing = objects.get(item);
      if (existing) return existing;
      const object = new Group();
      object.scale.setScalar(scale);
      scene.add(object);
      objects.set(item, object);
      return object;
    },
    move: () => {},
    remove: () => {},
    get: (item: string) => objects.get(item),
    dispose: () => {},
  } as unknown as LooseMeshes;
}

/**
 * A phone's world: no rigid bodies, ever (src/world/device.ts).
 *
 * `colliders` is what the page can see standing in the scatter, and
 * `rows` whether it still has the INSTANCE ROW for them — which is the
 * asymmetry the sticking report turned out to be. A viewer applying a
 * `stick` has neither: the host hid that placement the moment it took it.
 */
function phoneWorld(
  scene: Scene,
  colliders: Collider[] = [],
  rows = true,
): WorldHandles {
  const taken = new Set<string>();
  let version = 1;
  return {
    scene,
    cameraRig: { frameAt: () => {} },
    shadows: {
      addShadow: () => ({ setPosition: () => {}, setRadius: () => {} }),
      removeShadow: () => {},
    },
    bodies: () => null,
    physics: () => null,
    physicsExpected: () => false,
    enablePhysics: async () => {},
    scatter: {
      colliders: () => colliders.filter((c) => c.key === undefined || !taken.has(c.key)),
      collidersVersion: () => version,
      positions: () => [],
      nudge: () => {},
      hideTaken: (keys: ReadonlySet<string>) => {
        taken.clear();
        for (const k of keys) taken.add(k);
        version++;
      },
      setTaken: (keys: ReadonlySet<string>) => {
        taken.clear();
        for (const k of keys) taken.add(k);
        version++;
      },
      instanceRefs: (kind: string) =>
        rows
          ? colliders
              .filter((c) => c.kind === kind && c.key !== undefined && !taken.has(c.key))
              .map((c) => ({
                key: c.key!,
                // The instance scale the scatter drew it at — a library model
                // stands at 1.5–3, never 1 (docs/katamari-props.md), and the
                // difference between the two is the *"objects shrink when they
                // stick"* report.
                scale: LIBRARY_SCALE,
                radius: c.r,
                placement: { rotY: 0 },
              }))
          : [],
    },
  } as unknown as WorldHandles;
}

/** The topic, as a list of subscribers. qos 0 — every packet, in order. */
interface Bus {
  publish(raw: string): void;
  join(listener: (raw: string) => void): void;
  /** Everything that has crossed it, for the assertions. */
  sent: string[];
  /** Drop the next `n` packets of this kind, to model a qos-0 broker. */
  drop(kind: string, n: number): void;
}

function createBus(): Bus {
  const listeners: ((raw: string) => void)[] = [];
  const dropping = new Map<string, number>();
  const sent: string[] = [];
  return {
    sent,
    join: (l) => listeners.push(l),
    drop(kind, n) {
      dropping.set(kind, n);
    },
    publish(raw) {
      const kind = (JSON.parse(raw) as { t?: string }).t ?? '';
      const left = dropping.get(kind) ?? 0;
      if (left > 0) {
        dropping.set(kind, left - 1);
        return;
      }
      sent.push(raw);
      // A copy per listener: the real transport hands each page its own
      // string, and a shared object would let one page mutate another's.
      for (const l of [...listeners]) l(raw);
    },
  };
}

/**
 * ONE PAGE — the whole of `startWorldSync` that is not a socket.
 *
 * Kept in the same ORDER as src/main.ts on purpose: a drive is handled before
 * the claim bookkeeping (so hearing one never enters a phone into the
 * election), a hatch is honoured only from the host, and everything else is
 * the host describing the world and counts as proof it is alive.
 */
interface Page {
  readonly me: string;
  readonly manager: CreatureManager;
  hosting(): boolean;
  /** This page's own creature, for the stick. */
  mine: string;
  /** Where the stick is, as the drive loop reads it. */
  stick: { x: number; z: number; mag: number };
  /** One tick of everything this page runs on a timer. */
  tick(nowMs: number, dt: number): void;
  /** Force an election right now, as a settle tick does. */
  settle(nowMs: number): void;
  /** Where this page thinks a creature is. */
  at(id: string): { x: number; z: number } | null;
  /** Everything it has said out loud, for the assertions. */
  said: string[];
}

function createPage(bus: Bus, role: HostRole, mine: string, seed: number): Page {
  const scene = new Scene();
  const said: string[] = [];
  const manager = createCreatureManager(phoneWorld(scene), {
    autoHatch: false,
    surface: ROLLING_SURFACE,
    game: 'katamari',
    loose: stubLoose(scene),
    observer: {
      stick: () => {},
      loose: () => {},
      drop: () => {},
      settle: () => {},
      crack: () => {},
      retire: () => {},
      spawn: () => {},
      hatch: () => {},
      emote: () => {},
      pose: () => {},
      shatter: () => {},
    } as never,
  });
  // A deterministic id per page, so the election in a test is the election
  // the reader expects rather than whatever Math.random said.
  const me = makeHostId(role, () => seed);
  const claims = new Map<string, number>();
  const knownRosters = new Map<number, string[]>();
  const driveHeard = new Map<string, number>();
  const uplink = createDriveUplink();
  let hosting = true;
  let hostId = me;
  let rosterRev = 0;
  let roster: string[] = [];
  let rosterSentAt = 0;
  let beatAt = -Infinity;
  let poseAt = -Infinity;
  let expireAt = -Infinity;
  let driveAt = -Infinity;

  const applyDrive = (id: string, vec: { x: number; z: number; mag: number } | null): void => {
    manager.drive(id, vec && vec.mag > 0 ? vec : null);
  };

  const settle = (nowMs: number): void => {
    pruneClaims(claims, nowMs);
    hostId = electHost(me, claims, nowMs);
    const shouldHost = hostId === me;
    if (shouldHost === hosting) return;
    hosting = shouldHost;
    said.push(hosting ? 'promoted' : 'demoted');
    manager.pauseAi(!hosting);
    manager.clearFollow();
    // The 2026-09-17 fix. Without it the page keeps a hand on every creature
    // it was steering: `isDriven` stays true so they stand there, and the
    // moment it hosts again they all set off at once.
    manager.clearDrives();
    if (hosting) {
      rosterRev = Math.floor(nowMs / 1000);
      roster = [];
      manager.clearFollow();
    }
  };

  const receive = (raw: string): void => {
    const msg = readWorldSyncMessage(JSON.parse(raw) as unknown);
    if (!msg || msg.id === me) return;
    if (msg.t === 'host') {
      claims.set(msg.id, nowRef.now);
      return;
    }
    if (msg.t === 'drive') {
      if (!hosting) return;
      driveHeard.set(msg.who, nowRef.now);
      applyDrive(msg.who, { x: msg.x, z: msg.z, mag: msg.mag });
      return;
    }
    if (msg.t === 'hatchall') {
      if (!hosting) return;
      manager.hatchAll();
      return;
    }
    if (msg.t === 'scene') return;
    if (msg.t === 'hatch') {
      if (hosting || msg.id !== hostId) return;
      manager.hatch(msg.who);
      return;
    }
    claims.set(msg.id, nowRef.now);
    settle(nowRef.now);
    if (hosting) return;
    if (msg.t === 'roster') {
      knownRosters.set(msg.rev, msg.ids);
      if (knownRosters.size > 2) knownRosters.delete(Math.min(...knownRosters.keys()));
      return;
    }
    const against = knownRosters.get(msg.rev);
    if (!against) return;
    manager.followPoses(unpackPoses(msg.p, against));
  };

  /** The clock the receive path reads — set by `tick` before anything runs. */
  const nowRef = { now: 0 };
  bus.join(receive);

  const page: Page = {
    me,
    manager,
    said,
    mine,
    stick: { x: 0, z: 0, mag: 0 },
    hosting: () => hosting,
    settle: (nowMs) => {
      nowRef.now = nowMs;
      settle(nowMs);
    },
    at(id) {
      const pose = manager.poses().find((p) => p.id === id);
      return pose ? { x: pose.x, z: pose.z } : null;
    },
    tick(nowMs, dt) {
      nowRef.now = nowMs;
      // The frame first, so a drive applied last tick has been simulated by
      // the time the poses are packed — which is the order a browser runs
      // them in too (rAF, then the interval callbacks).
      manager.update(dt, nowMs);
      if (nowMs - beatAt >= HOST_HEARTBEAT_MS) {
        beatAt = nowMs;
        settle(nowMs);
        bus.publish(JSON.stringify({ t: 'host', id: me, at: nowMs }));
      }
      if (nowMs - driveAt >= DRIVE_INTERVAL_MS) {
        driveAt = nowMs;
        if (hosting) applyDrive(page.mine, page.stick);
        else {
          const out = uplink.offer(page.stick, nowMs);
          if (out) {
            bus.publish(JSON.stringify({ t: 'drive', id: me, who: page.mine, ...out }));
          }
        }
      }
      if (nowMs - poseAt >= POSE_INTERVAL_MS) {
        poseAt = nowMs;
        if (hosting) {
          const live = manager.liveIds();
          const changed = live.length !== roster.length || live.some((id, i) => id !== roster[i]);
          if (changed || nowMs - rosterSentAt > ROSTER_REPEAT_MS) {
            if (changed) rosterRev++;
            roster = live;
            rosterSentAt = nowMs;
            bus.publish(
              JSON.stringify({
                t: 'roster',
                id: me,
                rev: rosterRev,
                ids: roster,
                eggs: manager.eggIds(),
              }),
            );
          }
          if (roster.length > 0) {
            bus.publish(
              JSON.stringify({
                t: 'poses',
                id: me,
                rev: rosterRev,
                p: packPoses(manager.poses(), roster),
              }),
            );
          }
        }
      }
      if (nowMs - expireAt >= DRIVE_STALE_MS) {
        expireAt = nowMs;
        if (!hosting) driveHeard.clear();
        else {
          for (const [who, at] of driveHeard) {
            if (nowMs - at <= DRIVE_STALE_MS) continue;
            driveHeard.delete(who);
            applyDrive(who, null);
          }
        }
      }
    },
  };
  return page;
}

/** A room: a projection pinned as host, and two handsets. */
function room(): { bus: Bus; host: Page; a: Page; b: Page; run(ms: number): void; now(): number } {
  const bus = createBus();
  // The ids the election actually ranks: '!' below every digit, '~' above.
  const host = createPage(bus, 'forced', '', 0.1);
  const a = createPage(bus, 'phone', 'phonea', 0.2);
  const b = createPage(bus, 'phone', 'phoneb', 0.3);
  const pages = [host, a, b];
  let now = 1000;
  return {
    bus,
    host,
    a,
    b,
    now: () => now,
    run(ms) {
      const until = now + ms;
      while (now < until) {
        now += FRAME_MS;
        for (const p of pages) p.tick(now, FRAME_MS);
      }
    },
  };
}

/** Put the same two creatures on every page and open both shells. */
function populate(pages: Page[]): void {
  for (const p of pages) {
    for (const id of ['phonea', 'phoneb']) {
      p.manager.spawn(id, snowman, { hatchMs: 10, grown: true });
    }
    p.manager.update(FRAME_MS, 1000);
  }
}

describe('a viewer steers its own creature across the wire', () => {
  it('moves it on the host AND on the phone holding the stick', () => {
    const r = room();
    populate([r.host, r.a, r.b]);
    // The election: the projection's '!' id is the smallest, so it hosts and
    // both phones stand down.
    r.run(2 * HOST_HEARTBEAT_MS + 200);
    expect(r.host.hosting()).toBe(true);
    expect(r.a.hosting()).toBe(false);
    expect(r.b.hosting()).toBe(false);

    const before = { host: r.host.at('phonea')!, a: r.a.at('phonea')!, b: r.b.at('phonea')! };
    // A thumb, held, on phone A.
    r.a.stick = { x: 1, z: 0, mag: 1 };
    r.run(3000);
    r.a.stick = { x: 0, z: 0, mag: 0 };
    r.run(600);

    const after = { host: r.host.at('phonea')!, a: r.a.at('phonea')!, b: r.b.at('phonea')! };
    const moved = (k: 'host' | 'a' | 'b'): number =>
      Math.hypot(after[k].x - before[k].x, after[k].z - before[k].z);
    // The host simulated it…
    expect(moved('host')).toBeGreaterThan(1);
    // …the phone that pushed sees its own creature there…
    expect(moved('a')).toBeGreaterThan(1);
    // …and so does the OTHER phone, which is what makes it one world.
    expect(moved('b')).toBeGreaterThan(1);
    // Every page within a stride of each other: a viewer eases toward the
    // host and leads it by the host's own speed, never further.
    expect(Math.hypot(after.a.x - after.host.x, after.a.z - after.host.z)).toBeLessThan(2);
    expect(Math.hypot(after.b.x - after.host.x, after.b.z - after.host.z)).toBeLessThan(2);
    // And it went the way the stick pushed.
    expect(after.host.x - before.host.x).toBeGreaterThan(1);
  }, 120_000);

  it('never applies its own drive locally — the host is the only authority', () => {
    const r = room();
    populate([r.host, r.a, r.b]);
    r.run(2 * HOST_HEARTBEAT_MS + 200);
    // The host is not listening: every drive packet is dropped, which is
    // exactly a qos-0 broker on a bad link.
    r.bus.drop('drive', 10_000);
    const before = r.a.at('phonea')!;
    r.a.stick = { x: 1, z: 0, mag: 1 };
    r.run(2000);
    const after = r.a.at('phonea')!;
    // It did not move, and that is RIGHT: a viewer that moved its own
    // creature locally would be overwritten by the next pose 200ms later,
    // which looks correct for exactly that long and is the worst version of
    // this bug. The creature is the host's to move.
    expect(Math.hypot(after.x - before.x, after.z - before.z)).toBeLessThan(0.3);
  }, 120_000);

  it('keeps moving BETWEEN pose frames instead of stuttering at 5hz', () => {
    /*
     * The *"glitch on mobile"* half of the report. Poses land five times a
     * second and the follow ease is tuned to have substantially arrived by
     * the next one — which for a creature that is WALKING means it covered
     * the gap in the first ninety milliseconds and then stood still for a
     * hundred and ten, five times a second, on the screen of the person
     * pushing the stick.
     *
     * With the lead in (`followPoses` derives the host's speed from two
     * poses) the viewer keeps travelling through the gap. So: sample the
     * viewer's creature every frame for a second of steady pushing and count
     * how many frames it did not move at all.
     */
    const r = room();
    populate([r.host, r.a, r.b]);
    r.run(2 * HOST_HEARTBEAT_MS + 200);
    r.a.stick = { x: 1, z: 0, mag: 1 };
    r.run(1500);

    const steps: number[] = [];
    let last = r.a.at('phonea')!;
    let now = r.now();
    for (let i = 0; i < 60; i++) {
      now += FRAME_MS;
      for (const p of [r.host, r.a, r.b]) p.tick(now, FRAME_MS);
      const at = r.a.at('phonea')!;
      steps.push(Math.hypot(at.x - last.x, at.z - last.z));
      last = at;
    }
    const mean = steps.reduce((x, y) => x + y, 0) / steps.length;
    const min = Math.min(...steps);
    expect(mean).toBeGreaterThan(0.05);
    /*
     * THE MEASURE, and it is the whole point of the test: how UNEVEN the
     * travel is. Without the lead the viewer eases toward a point that is
     * 200ms stale, so the per-frame step decays as `e^(-t/FOLLOW_TAU_MS)`
     * across each gap — the last frame before a pose lands covers about a
     * ninth of what the first one did (measured: min/mean 0.16). With it the
     * target moves with the creature and the travel is near-uniform
     * (measured: min/mean 0.80).
     *
     * Half the mean is comfortably between the two, and it is a number a
     * person could feel: a frame that covers less than half the average is
     * the stutter the report is about.
     */
    expect(min).toBeGreaterThan(mean * 0.5);
  }, 120_000);
});

describe('a host handoff leaves the creature where it was', () => {
  it('does not fly the cast across the field when a phone takes over', () => {
    const r = room();
    populate([r.host, r.a, r.b]);
    r.run(2 * HOST_HEARTBEAT_MS + 200);
    // Walk it somewhere that is not its spawn spot, so "where it was" is a
    // real place rather than the place every page would guess.
    r.a.stick = { x: 1, z: 0.4, mag: 1 };
    r.run(3000);
    r.a.stick = { x: 0, z: 0, mag: 0 };
    r.run(600);

    const handover = r.a.at('phonea')!;
    // The projection goes away: it stops heartbeating and its claim goes
    // stale. Everything else keeps running.
    const gone = { tick: () => {} };
    let now = r.now();
    const others = [r.a, r.b];
    for (let i = 0; i < Math.ceil((HOST_STALE_MS + 1500) / FRAME_MS); i++) {
      now += FRAME_MS;
      for (const p of others) p.tick(now, FRAME_MS);
      gone.tick();
    }
    // One of the phones is the host now — the smaller '~' id.
    expect(r.a.hosting() || r.b.hosting()).toBe(true);
    const newHost = r.a.hosting() ? r.a : r.b;
    const viewer = r.a.hosting() ? r.b : r.a;
    expect(newHost.said).toContain('promoted');

    // And the creature is still standing where the old host left it — on
    // both pages. A handoff is not a movement.
    const after = { host: newHost.at('phonea')!, viewer: viewer.at('phonea')! };
    expect(Math.hypot(after.host.x - handover.x, after.host.z - handover.z)).toBeLessThan(2.5);
    expect(Math.hypot(after.viewer.x - handover.x, after.viewer.z - handover.z)).toBeLessThan(2.5);
  }, 120_000);

  it('lets go of every stick it was holding when it stops hosting', () => {
    /*
     * The *"stuck when trying to move"* half. A page that is the host holds
     * `slot.drive` on every creature it is steering — its own stick when it
     * is a phone alone, every phone's over the wire when it is a projection.
     * When it loses the election none of those hands are on anything any
     * more, and leaving them set is two bugs: `isDriven` stays true so those
     * creatures' agents stay stood down and they stand there, and the moment
     * the page wins the election BACK every stale vector takes effect at
     * once.
     */
    const r = room();
    populate([r.host, r.a, r.b]);
    r.run(2 * HOST_HEARTBEAT_MS + 200);
    r.a.stick = { x: 1, z: 0, mag: 1 };
    r.b.stick = { x: -1, z: 0, mag: 1 };
    r.run(1000);
    // The host is holding both phones' creatures.
    expect(r.host.manager.driven().sort()).toEqual(['phonea', 'phoneb']);

    // A page that would win the election arrives — a second projection, or
    // the operator reopening theirs. Hearing a smaller id demotes this one
    // on the spot (src/main.ts: a page hearing a smaller id stands down NOW).
    const now = r.now() + FRAME_MS;
    r.bus.publish(JSON.stringify({ t: 'host', id: '!0aaaaaaa', at: now }));
    r.host.settle(now);
    expect(r.host.hosting()).toBe(false);
    // Both hands let go, and nothing is left `isDriven`.
    expect(r.host.manager.driven()).toEqual([]);
    expect(r.host.manager.isDriven('phonea', now)).toBe(false);
    expect(r.host.manager.isDriven('phoneb', now)).toBe(false);
  }, 120_000);

  it('a page that hosts again starts from no drives at all', () => {
    const r = room();
    populate([r.host, r.a, r.b]);
    r.run(2 * HOST_HEARTBEAT_MS + 200);
    r.a.stick = { x: 1, z: 0, mag: 1 };
    r.run(1000);
    r.a.stick = { x: 0, z: 0, mag: 0 };

    // Down…
    let now = r.now() + FRAME_MS;
    r.bus.publish(JSON.stringify({ t: 'host', id: '!0aaaaaaa', at: now }));
    r.host.settle(now);
    expect(r.host.hosting()).toBe(false);
    // …and back up, once that claim goes stale.
    now += HOST_STALE_MS * 2 + 1;
    r.host.settle(now);
    expect(r.host.hosting()).toBe(true);
    // Nothing set off. Before the fix every creature it had been steering
    // resumed its last vector on this frame.
    expect(r.host.manager.driven()).toEqual([]);
  }, 120_000);
});

describe('a passenger steers its carrier across the wire', () => {
  it('applies a rider’s drive to the ball it is riding', () => {
    const r = room();
    populate([r.host, r.a, r.b]);
    r.run(2 * HOST_HEARTBEAT_MS + 200);

    /*
     * B rides A, on EVERY page — which is how it really happens: the host
     * decides and the `stick` event says so, and a viewer applies the same
     * record through `applyStick` (docs/PLAN.md §7.6).
     */
    for (const p of [r.host, r.a, r.b]) {
      p.manager.applyStick({
        id: 'phonea',
        item: 'creature:phoneb',
        ox: 0,
        oy: 1,
        oz: 0,
        qx: 0,
        qy: 0,
        qz: 0,
        qw: 1,
      });
    }
    r.run(200);

    const before = r.host.at('phonea')!;
    // The PASSENGER's phone pushes. Its creature has no locomotion of its
    // own — it is a seat on a pile — so the push has to reach the carrier
    // (`effectiveDrive`, the 2026-09-16 stuck ruling), and it has to survive
    // the trip over the wire to get there.
    r.b.stick = { x: 1, z: 0, mag: 1 };
    r.run(2500);
    const after = r.host.at('phonea')!;
    expect(after.x - before.x).toBeGreaterThan(0.5);
    // The rider is on the pile, so it went with it.
    const rider = r.host.at('phoneb')!;
    expect(Math.hypot(rider.x - after.x, rider.z - after.z)).toBeLessThan(3);
    // And the carrier's own phone never touched its stick.
    expect(r.a.stick.mag).toBe(0);
  }, 120_000);
});

describe('the drive uplink', () => {
  it('lets through every sample a DRIVE_INTERVAL_MS timer offers', () => {
    /*
     * The bug: the gate was `now - lastSent < DRIVE_INTERVAL_MS` and the
     * loop that feeds it runs on a `setInterval(DRIVE_INTERVAL_MS)`. Browser
     * timers fire early as often as late, so about half of a held thumb's
     * samples were refused and the intended 12hz went out at six, unevenly
     * — a creature that answers sometimes.
     */
    const uplink = createDriveUplink();
    const held = { x: 1, z: 0, mag: 1 };
    let sent = 0;
    // A timer with the jitter a real one has: a millisecond either side.
    let now = 0;
    for (let i = 0; i < 24; i++) {
      now += DRIVE_INTERVAL_MS + (i % 2 === 0 ? -1.4 : 1.1);
      if (uplink.offer(held, now)) sent++;
    }
    expect(sent).toBe(24);
    expect(DRIVE_PACE_MS).toBeLessThan(DRIVE_INTERVAL_MS);
  }, 120_000);

  it('still refuses a caller that reads the stick on every pointermove', () => {
    const uplink = createDriveUplink();
    const held = { x: 0, z: 1, mag: 0.5 };
    let sent = 0;
    for (let i = 0; i < 120; i++) if (uplink.offer(held, i * 4)) sent++;
    // 120 pointermoves over 480ms is at most a handful of packets.
    expect(sent).toBeLessThanOrEqual(1 + Math.ceil(480 / DRIVE_PACE_MS));
    expect(sent).toBeGreaterThan(2);
  }, 120_000);

  it('never drops the RELEASE, whatever the pacing says', () => {
    // A release eaten by the rate cap leaves the creature walking until the
    // host's DRIVE_STALE_MS expiry notices — up to 600ms of a creature going
    // somewhere nobody asked.
    const uplink = createDriveUplink();
    expect(uplink.offer({ x: 1, z: 0, mag: 1 }, 1000)).not.toBeNull();
    // One millisecond later, which no pacing would allow for a held sample.
    const release = uplink.offer({ x: 0, z: 0, mag: 0 }, 1001);
    expect(release).not.toBeNull();
    expect(release!.mag).toBe(0);
    // …and then it falls silent rather than repeating a thumb that is gone.
    expect(uplink.offer({ x: 0, z: 0, mag: 0 }, 2000)).toBeNull();
    expect(uplink.holding()).toBe(false);
  }, 120_000);

  it('rounds to the wire’s own precision, in one place', () => {
    const uplink = createDriveUplink();
    const out = uplink.offer({ x: 0.123456789, z: -0.987654321, mag: 0.55555 }, 0)!;
    expect(out.x).toBe(0.123);
    expect(out.z).toBe(-0.988);
    expect(out.mag).toBe(0.556);
  }, 120_000);

  it('survives the round trip through the codec unchanged', () => {
    const uplink = createDriveUplink();
    const out = uplink.offer({ x: 0.5, z: -0.25, mag: 0.75 }, 0)!;
    const msg = readWorldSyncMessage(
      JSON.parse(JSON.stringify({ t: 'drive', id: '~abc', who: 'me', ...out })),
    );
    expect(msg).toEqual({ t: 'drive', id: '~abc', who: 'me', x: 0.5, z: -0.25, mag: 0.75 });
  }, 120_000);
});

describe('and the page really is wired that way', () => {
  /*
   * The harness above mirrors `startWorldSync`; these four lines are what
   * make the mirror honest. Without them the test could keep passing while
   * src/main.ts stopped doing any of it — which is exactly how the
   * single-page tests went on passing through the 2026-09-17 report.
   */
  it('lets go of every drive on a role change, beside clearFollow', () => {
    const src = mainSrc();
    expect(src).toMatch(/creatures\.clearFollow\(\);\s*\n(?:\s*(?:\/\*|\*|\*\/|\/\/).*\n)*\s*creatures\.clearDrives\(\);/);
  });

  it('publishes the stick through the pure uplink, not an inline rate cap', () => {
    const src = mainSrc();
    expect(src).toMatch(/const uplinkDrive = createDriveUplink\(\);/);
    expect(src).toMatch(/const out = uplinkDrive\.offer\(v, Date\.now\(\)\);/);
    // The inline version is gone: it dropped half a held thumb's samples to
    // timer jitter and had its own idea of the wire's precision.
    expect(src).not.toMatch(/lastDriveMag/);
    expect(src).not.toMatch(/v\.mag\.toFixed\(3\)/);
  });

  it('reads the stick at DRIVE_INTERVAL_MS and applies or publishes by ROLE', () => {
    const src = mainSrc();
    expect(src).toMatch(/if \(isHostNow\(\)\) applyDrive\(myDrawerId, v\);\s*\n\s*else publishDrive\(v\);/);
    expect(src).toMatch(/\}, DRIVE_INTERVAL_MS\);/);
  });

  it('gives every socket the page opens the same broker override', () => {
    // A handset's world view opens two — the world feed and its own emote
    // uplink — and the uplink used to be built before the override was read,
    // so a self-hosted room's emotes still crossed the public broker.
    const src = mainSrc();
    expect(src).toMatch(/createPhoneLink\(room, myDrawerId, brokerOverride \? \{ broker: brokerOverride \} : \{\}\)/);
    const brokerAt = src.indexOf('const brokerOverride =');
    const uplinkAt = src.indexOf('const uplink = myDrawerId');
    expect(brokerAt).toBeGreaterThan(0);
    expect(brokerAt).toBeLessThan(uplinkAt);
  });
});

describe('sticking, as the viewer sees it', () => {
  /*
   * > User report, 2026-09-17: *"some users are having issues sticking to
   * > objects."*
   *
   * The DECISION is the host's and travels as a `stick` event — that part was
   * already right. What did not travel was the item's RADIUS, and growth is
   * derived on every page from the radii of what the pile is carrying. A
   * viewer read the radius off the scatter's own instance row; the host hid
   * that placement the moment it took it, so by the time a phone applied the
   * event there was no row, and the radius fell back to the instance SCALE —
   * about 1 for everything on the map. A tree that added 1.73 to the host's
   * pile added 1.00 to the phone's.
   *
   * So the same ball was two sizes in the same room: the phone drew it
   * smaller, its own size readout under-reported it, and the circle that the
   * person could see rolling over things was not the circle the host was
   * deciding with.
   */
  function pageWithRows(colliders: Collider[], rows: boolean): CreatureManager {
    const scene = new Scene();
    return createCreatureManager(phoneWorld(scene, colliders, rows), {
      autoHatch: false,
      surface: ROLLING_SURFACE,
      game: 'katamari',
      loose: stubLoose(scene),
      observer: {
        stick: () => {},
        loose: () => {},
        drop: () => {},
        settle: () => {},
        crack: () => {},
        retire: () => {},
        spawn: () => {},
        hatch: () => {},
        emote: () => {},
        pose: () => {},
        shatter: () => {},
      } as never,
    });
  }

  it('grows the ball to the same size on a page with no instance row left', () => {
    // A tree-sized prop: radius well over the instance scale, which is the
    // whole difference the report was made of.
    const tree: Collider = {
      x: 0,
      z: 0,
      r: 1.2,
      hard: true,
      kind: 'tree',
      key: 'tree:0:0.00:0.00',
    } as Collider;

    const host = pageWithRows([tree], true);
    const viewer = pageWithRows([tree], false);
    for (const m of [host, viewer]) {
      m.spawn('mine', snowman, { hatchMs: 10, grown: true });
      m.update(FRAME_MS, 1000);
    }
    viewer.pauseAi(true);
    const base = host.ballDiameter('mine') / 2;
    expect(base).toBeGreaterThan(0);

    // The host's own record, built the way `uprootOntoPile` builds one —
    // including the radius it measured off its instance row.
    host.applyStick({
      id: 'mine',
      item: tree.key!,
      kind: 'tree',
      variant: 0,
      scale: 1,
      r: tree.r,
      ox: base,
      oy: 0,
      oz: 0,
      qx: 0,
      qy: 0,
      qz: 0,
      qw: 1,
    });
    // …and the same record, over the wire, on a page that never had the row.
    viewer.applyStick({
      id: 'mine',
      item: tree.key!,
      kind: 'tree',
      variant: 0,
      scale: 1,
      r: tree.r,
      ox: base,
      oy: 0,
      oz: 0,
      qx: 0,
      qy: 0,
      qz: 0,
      qw: 1,
    });
    for (let i = 0; i < 60; i++) {
      host.update(FRAME_MS, 1000 + i * FRAME_MS);
      viewer.update(FRAME_MS, 1000 + i * FRAME_MS);
    }
    const grown = host.ballDiameter('mine');
    expect(grown).toBeGreaterThan(2 * base);
    // ONE ball, ONE size, on both pages.
    expect(viewer.ballDiameter('mine')).toBeCloseTo(grown, 6);
    host.clearAll();
    viewer.clearAll();
  }, 120_000);

  it('under-reports on the viewer when the radius does NOT travel', () => {
    // The bug, kept as a test so the field cannot quietly stop being sent:
    // the same record with `r` left off falls back to the instance scale and
    // the two pages disagree.
    const tree: Collider = {
      x: 0,
      z: 0,
      r: 1.2,
      hard: true,
      kind: 'tree',
      key: 'tree:0:0.00:0.00',
    } as Collider;
    const host = pageWithRows([tree], true);
    const viewer = pageWithRows([tree], false);
    for (const m of [host, viewer]) {
      m.spawn('mine', snowman, { hatchMs: 10, grown: true });
      m.update(FRAME_MS, 1000);
    }
    viewer.pauseAi(true);
    const record = {
      id: 'mine',
      item: tree.key!,
      kind: 'tree',
      variant: 0,
      scale: 1,
      ox: 1,
      oy: 0,
      oz: 0,
      qx: 0,
      qy: 0,
      qz: 0,
      qw: 1,
    };
    host.applyStick(record);
    viewer.applyStick(record);
    for (let i = 0; i < 60; i++) {
      host.update(FRAME_MS, 1000 + i * FRAME_MS);
      viewer.update(FRAME_MS, 1000 + i * FRAME_MS);
    }
    // The host still has its row, so it is right; the viewer is not.
    expect(viewer.ballDiameter('mine')).toBeLessThan(host.ballDiameter('mine') * 0.9);
    host.clearAll();
    viewer.clearAll();
  }, 120_000);

  /*
   * ── AND THE VIEWER DRAWS THE SAME PILE, at the same size ───────────────
   *
   * > User report, 2026-09-17, from a phone in the room while the projection
   * > hosted: *"currently there is a bug where the characters are floating in
   * > space."* Then, off the live room: *"we are rendering a ball and the
   * > character is growing with the size of the ball."*
   *
   * The page those came from is a VIEWER, which decides nothing and draws
   * everything — so what has to be pinned on it is the two numbers a viewer
   * derives for itself from the `stick` events: the CREATURE's world scale,
   * which must be its DRAWN size however big the pile is (`growPass` divides
   * the root's growth back out on the rider), and where the items sit, which
   * is the packing the host decided and sent.
   *
   * A LATE JOINER is the same claim one step harder: a page that opens after
   * the ball is grown gets the whole pile in one batch (a restore, or the
   * stored scene on arrival) rather than one event at a time.
   */
  function drawn(page: CreatureManager, id: string): {
    charScale: number;
    rootScale: number;
    seats: number[];
    bodyR: number;
  } {
    const root = page.hoverTargets()[0]!.object;
    root.updateWorldMatrix(true, true);
    const rider = root.getObjectByName('rider')!;
    const clump = root.getObjectByName('clump')!;
    const middle = clump.getWorldPosition(new Vector3());
    const character = rider.children[0]!;
    return {
      // THE NUMBER THE REPORT IS ABOUT: 1 means the creature is drawn at the
      // size it was drawn at, whatever the pile has become.
      charScale: character.getWorldScale(new Vector3()).x,
      rootScale: root.scale.x,
      seats: clump.children.map((item) =>
        Number(item.getWorldPosition(new Vector3()).distanceTo(middle).toFixed(4)),
      ),
      bodyR: page.ballDiameter(id) / 2,
    };
  }

  it('draws the same pile on the viewer, with the creature at its drawn size', () => {
    const tree: Collider = {
      x: 0,
      z: 0,
      r: 1.2,
      hard: true,
      kind: 'tree',
      key: 'tree:0:0.00:0.00',
    } as Collider;
    const host = pageWithRows([tree], true);
    const viewer = pageWithRows([tree], false);
    const late = pageWithRows([tree], false);
    for (const m of [host, viewer]) {
      m.spawn('mine', snowman, { hatchMs: 10, grown: true });
      m.update(FRAME_MS, 1000);
    }
    viewer.pauseAi(true);
    const baseR = host.ballDiameter('mine') / 2;
    expect(baseR).toBeGreaterThan(0);

    /*
     * Six of them, each from a different side, seated the way the deciding
     * page seats them: the offset is computed against the growth the pile has
     * BEFORE the item joins and divided by it (src/creatures/sticky.ts
     * `clumpLocalOffset`), which is what makes the same three floats land in
     * the same place on every page.
     */
    const records = [];
    for (let i = 0; i < 6; i++) {
      const th = (i / 6) * Math.PI * 2;
      const g = Math.cbrt(1 + (4 * i * tree.r ** 3) / baseR ** 3);
      const local = (baseR + tree.r * 0.7) / g;
      records.push({
        id: 'mine',
        item: `${tree.key!}:${i}`,
        kind: 'tree' as const,
        variant: 0,
        scale: 1,
        r: tree.r,
        ox: Math.cos(th) * local,
        oy: 0,
        oz: Math.sin(th) * local,
        qx: 0,
        qy: 0,
        qz: 0,
        qw: 1,
      });
    }
    for (const record of records) {
      host.applyStick(record);
      viewer.applyStick(record);
    }
    for (let i = 0; i < 120; i++) {
      host.update(FRAME_MS, 2000 + i * FRAME_MS);
      viewer.update(FRAME_MS, 2000 + i * FRAME_MS);
    }

    /*
     * THE LATE JOINER: it opens now, spawns the creature from the drawing it
     * is told about, and gets the whole pile at once. The `rider` is built in
     * `becomeAlive` before any of it, and the growth is written every frame by
     * `growPass` on every page — so the creature must be its drawn size here
     * too, which is the case where "the rider was created after the root was
     * scaled" would show up.
     */
    late.spawn('mine', snowman, { hatchMs: 10, grown: true });
    late.update(FRAME_MS, 5000);
    late.pauseAi(true);
    for (const record of records) late.applyStick(record);
    for (let i = 0; i < 120; i++) late.update(FRAME_MS, 5000 + i * FRAME_MS);

    const pages = [
      ['host', host],
      ['viewer', viewer],
      ['late joiner', late],
    ] as const;
    const read = pages.map(([name, page]) => [name, drawn(page, 'mine')] as const);
    for (const [name, seen] of read) {
      // A real ball: the root carries the growth…
      expect(seen.rootScale, name).toBeGreaterThan(3);
      expect(seen.bodyR, name).toBeGreaterThan(baseR * 3);
      // …and the creature inside it is EXACTLY its drawn size.
      expect(seen.charScale, name).toBeCloseTo(1, 6);
      // Six items, each packed on the creature at the same distance.
      expect(seen.seats.length, name).toBe(6);
      for (const seat of seen.seats) {
        expect(seat, name).toBeCloseTo(baseR + tree.r * 0.7, 3);
      }
    }
    // ONE pile, ONE size, on all three pages — derived, never sent.
    const host0 = read[0]![1];
    for (const [name, seen] of read.slice(1)) {
      expect(seen.bodyR, name).toBeCloseTo(host0.bodyR, 6);
      expect(seen.rootScale, name).toBeCloseTo(host0.rootScale, 6);
      expect(seen.seats, name).toEqual(host0.seats);
    }
    host.clearAll();
    viewer.clearAll();
    late.clearAll();
  }, 120_000);
});

describe('an item keeps its own size on every page', () => {
  /*
   * > User report, 2026-09-17: *"right now objects shrink when they stick to
   * > the character, they should remain the same size."*
   *
   * The chain is two multiplications that have to cancel. The pile hangs on the
   * creature root and the root's uniform scale IS the growth (`growPass`), so
   * `localScaleOf` divides the item's own scale back out — world scale =
   * `growth × (scale / growth)` = `scale`. Which is right exactly as long as
   * `scale` is the scale the scatter DREW the placement at.
   *
   * On the host it is: `placementDrawn` reads the instance row, which is still
   * there because nothing has hidden the placement yet. On a VIEWER the row is
   * gone — the host hid it the moment it took it — so the only source is the
   * event, and anything the event does not carry falls back to 1. A library
   * model stands at 1.5–3, so falling back to 1 is a prop drawn at a third of
   * its size, on every screen but the one that decided.
   */
  function page(colliders: Collider[], rows: boolean): {
    manager: CreatureManager;
    loose: LooseMeshes;
    /** The scatter this page is drawing — for reading its own instance row. */
    scatter: {
      instanceRefs(kind: string): { key: string; scale: number; radius: number }[];
    };
  } {
    const scene = new Scene();
    const loose = stubLoose(scene);
    const world = phoneWorld(scene, colliders, rows);
    const manager = createCreatureManager(world, {
      autoHatch: false,
      surface: ROLLING_SURFACE,
      game: 'katamari',
      loose,
      observer: {
        stick: () => {},
        loose: () => {},
        drop: () => {},
        settle: () => {},
        crack: () => {},
        retire: () => {},
        spawn: () => {},
        hatch: () => {},
        emote: () => {},
        pose: () => {},
        shatter: () => {},
      } as never,
    });
    return {
      manager,
      loose,
      scatter: (world as unknown as { scatter: { instanceRefs(kind: string): never } })
        .scatter as never,
    };
  }

  /**
   * THE SIZE THE SCATTER IS DRAWING THIS PROP AT — read off the instance row,
   * not off a constant in this file.
   *
   * > Coordinator, 2026-09-17, with the user's own screenshot: *"measure a
   * > stuck prop's world scale on the viewer against the same prop's scale in
   * > the scatter."*
   *
   * Which is the whole claim: a prop that has been rolled up is drawn at the
   * size it stood at, and the page that DECIDED nothing is not allowed to
   * have a different opinion about it than the page that decided.
   */
  function scatterScale(
    p: { scatter: { instanceRefs(kind: string): { key: string; scale: number }[] } },
    kind: string,
    key: string,
  ): number {
    const row = p.scatter.instanceRefs(kind).find((r) => r.key === key);
    if (!row) throw new Error(`no instance row for ${key}`);
    return row.scale;
  }

  const prop = (): Collider =>
    ({ x: 0, z: 0, r: 0.6, hard: true, kind: 'small', key: 'small:0:0.00:0.00' }) as Collider;

  /** The item's scale IN THE WORLD — every factor between it and the scene. */
  function worldScale(loose: LooseMeshes, key: string): number {
    const object = loose.get(key);
    if (!object) throw new Error(`no loose mesh for ${key}`);
    const out = new Vector3();
    object.updateWorldMatrix(true, false);
    object.getWorldScale(out);
    return out.x;
  }

  it('draws it at its ground scale on the host AND on the viewer', () => {
    const stone = prop();
    const host = page([stone], true);
    const viewer = page([stone], false);
    for (const p of [host, viewer]) {
      p.manager.spawn('mine', snowman, { hatchMs: 10, grown: true });
      p.manager.update(FRAME_MS, 1000);
    }
    viewer.manager.pauseAi(true);

    // Enough pile under it that the growth is nowhere near 1 — the whole
    // point is that two multiplications cancel, and at growth 1 they cancel
    // whether or not either of them is right.
    for (let i = 0; i < 3; i++) {
      host.manager.spawn(`filler-${i}`, snowman, { hatchMs: 10, grown: true });
      viewer.manager.spawn(`filler-${i}`, snowman, { hatchMs: 10, grown: true });
      for (const p of [host, viewer]) {
        p.manager.applyStick({
          id: 'mine',
          item: `creature:filler-${i}`,
          ox: 0,
          oy: 1,
          oz: i * 0.1,
          qx: 0,
          qy: 0,
          qz: 0,
          qw: 1,
        });
      }
    }
    for (let i = 0; i < 40; i++) {
      host.manager.update(FRAME_MS, 1100 + i * FRAME_MS);
      viewer.manager.update(FRAME_MS, 1100 + i * FRAME_MS);
    }
    const growth = host.manager.ballDiameter('mine') / 2 / 0.9;
    expect(growth).toBeGreaterThan(1.3);

    /*
     * The record the host makes for itself — `scale` off its own instance row
     * — and the same record over the wire. This is exactly what
     * `uprootOntoPile` builds and what `readStickScene` carries.
     */
    /*
     * Read the row BEFORE the pickup, because taking the prop is what loses
     * it — on the host too. That is the whole shape of this bug: the number
     * only exists while the thing is still standing, so it has to be said
     * out loud at the moment of the decision or it is gone for good.
     */
    const standing = scatterScale(host, 'small', stone.key!);
    expect(standing).toBeCloseTo(LIBRARY_SCALE, 6);

    const record = {
      id: 'mine',
      item: stone.key!,
      kind: 'small',
      variant: 0,
      scale: LIBRARY_SCALE,
      r: stone.r,
      ox: 1,
      oy: 0,
      oz: 0,
      qx: 0,
      qy: 0,
      qz: 0,
      qw: 1,
    };
    expect(host.manager.applyStick(record)).not.toBe(false);
    viewer.manager.applyStick(record);
    for (let i = 0; i < 40; i++) {
      host.manager.update(FRAME_MS, 3000 + i * FRAME_MS);
      viewer.manager.update(FRAME_MS, 3000 + i * FRAME_MS);
    }

    /*
     * The stone is the size the SCATTER is drawing that placement at, on both
     * pages — read off the host's own instance row, which is the only thing
     * in the world that knows it and the thing a viewer has lost.
     */
    expect(worldScale(host.loose, stone.key!)).toBeCloseTo(standing, 6);
    expect(worldScale(viewer.loose, stone.key!)).toBeCloseTo(standing, 6);
    // And not merely equal to each other: a pair of pages that both drew it
    // at 1 would pass an equality and be wrong together. `growth` is well
    // over 1 here, so the two multiplications had to cancel to land on it.
    expect(worldScale(viewer.loose, stone.key!)).not.toBeCloseTo(1, 2);
    host.manager.clearAll();
    viewer.manager.clearAll();
  }, 120_000);

  it('draws a KNOCKED-LOOSE prop at its ground scale on the viewer', () => {
    /*
     * The other half, and the one the report is actually about: a `loose`
     * event said only WHERE the prop landed. On the host `loosen` knows the
     * scale — it has the instance row and the body it just made — but a
     * viewer has neither (`hideTaken` has taken the placement out of the
     * scatter by the time it applies the event), so `showLoose` fell back to
     * 1 and the prop shrank the instant it came out of the ground.
     *
     * Worse than a cosmetic: the mesh is created ONCE and
     * `LooseMeshes.show` is idempotent, so a prop that was drawn at 1 while
     * it lay on the ground carried that into the `settle` that follows it.
     */
    const stone = prop();
    const viewer = page([stone], false);
    viewer.manager.spawn('mine', snowman, { hatchMs: 10, grown: true });
    viewer.manager.update(FRAME_MS, 1000);
    viewer.manager.pauseAi(true);
    viewer.manager.applyLoose(stone.key!, 3, 4, LIBRARY_SCALE);
    expect(worldScale(viewer.loose, stone.key!)).toBeCloseTo(LIBRARY_SCALE, 6);
    // Nowhere near the fallback, in either direction: the instance scale is
    // the placement's times the kind's dial, so a fallback of 1 draws a prop
    // whose dial is under 1 far too BIG and one whose dial is over 1 too
    // small. Which way it goes is not the point; that it is not the scale the
    // scatter drew is.
    expect(worldScale(viewer.loose, stone.key!)).not.toBeCloseTo(1, 2);
    viewer.manager.clearAll();
  }, 120_000);

  it('keeps that scale when the loose prop is then picked up', () => {
    // `show` returns the mesh it already made rather than re-scaling it, so
    // the loose scale has to be right for the stick that follows to be.
    const stone = prop();
    const viewer = page([stone], false);
    viewer.manager.spawn('mine', snowman, { hatchMs: 10, grown: true });
    viewer.manager.update(FRAME_MS, 1000);
    viewer.manager.pauseAi(true);
    viewer.manager.applyLoose(stone.key!, 0.5, 0, LIBRARY_SCALE);
    viewer.manager.applyStick({
      id: 'mine',
      item: stone.key!,
      kind: 'small',
      variant: 0,
      scale: LIBRARY_SCALE,
      r: stone.r,
      ox: 1,
      oy: 0,
      oz: 0,
      qx: 0,
      qy: 0,
      qz: 0,
      qw: 1,
    });
    for (let i = 0; i < 20; i++) viewer.manager.update(FRAME_MS, 1100 + i * FRAME_MS);
    expect(worldScale(viewer.loose, stone.key!)).toBeCloseTo(LIBRARY_SCALE, 6);
    viewer.manager.clearAll();
  }, 120_000);

  it('shrinks on the viewer when the scale does NOT travel', () => {
    // The bug, kept so the field cannot quietly stop being sent: with no
    // `scale` on the record a viewer has nothing to read and draws it at 1.
    const stone = prop();
    const viewer = page([stone], false);
    viewer.manager.spawn('mine', snowman, { hatchMs: 10, grown: true });
    viewer.manager.update(FRAME_MS, 1000);
    viewer.manager.pauseAi(true);
    viewer.manager.applyStick({
      id: 'mine',
      item: stone.key!,
      kind: 'small',
      variant: 0,
      r: stone.r,
      ox: 1,
      oy: 0,
      oz: 0,
      qx: 0,
      qy: 0,
      qz: 0,
      qw: 1,
    });
    for (let i = 0; i < 20; i++) viewer.manager.update(FRAME_MS, 1100 + i * FRAME_MS);
    expect(worldScale(viewer.loose, stone.key!)).toBeLessThan(LIBRARY_SCALE * 0.6);
    viewer.manager.clearAll();
  }, 120_000);
});
