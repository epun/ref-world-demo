/**
 * BehaviorAgent (src/behavior/agent.ts) — deterministic runtime tests.
 *
 * No renderer, no clock: the agent is stepped with fed dt and positions are
 * integrated here exactly as the manager does (pos += v · dt/1000). The
 * load-bearing checks: determinism, dispersal (two adjacent agents drift
 * apart), the ζ≥1 heading spring never overshooting a step target, stand-off
 * respect around peers, stillness at the output level, and sparse emotes.
 */

import { describe, expect, it } from 'vitest';
import {
  BehaviorAgent,
  MAX_SPEED,
  type AgentHold,
  type AgentTick,
} from '../../src/behavior/agent';
import type { Personality } from '../../src/behavior/personality';
import { makeRand } from '../../src/behavior/states';
import { Spring } from '../../src/motion/spring';
import {
  buildColliderGrid,
  type Collider,
  type ColliderGrid,
} from '../../src/physics/colliders';
import { MOTION } from '../../src/taste/tokens';

const NEUTRAL: Personality = {
  energy: 0.5,
  curiosity: 0.5,
  social: 0.5,
  playfulness: 0.5,
  sleepiness: 0.5,
};

/** Roamer profile: moves a lot, ignores company — the dispersal case. */
const ROAMER: Personality = {
  energy: 0.95,
  curiosity: 0.6,
  social: 0.05,
  playfulness: 0.5,
  sleepiness: 0.05,
};

const DT = 100; // ms per step

interface Sim {
  agent: BehaviorAgent;
  x: number;
  z: number;
}

function step(
  sim: Sim,
  now: number,
  peers: Sim[],
  props: null,
  colliders: ColliderGrid | null = null,
): AgentTick {
  const tick = sim.agent.update(
    DT,
    now,
    { x: sim.x, z: sim.z },
    peers.map((p, i) => ({ x: p.x, z: p.z, id: `peer-${i}` })),
    props,
    colliders,
  );
  sim.x += (tick.vx * DT) / 1000;
  sim.z += (tick.vz * DT) / 1000;
  return tick;
}

describe('BehaviorAgent', () => {
  it('same seed + personality → identical trajectory (5000 steps)', () => {
    const a: Sim = { agent: new BehaviorAgent(321, NEUTRAL), x: 0, z: 0 };
    const b: Sim = { agent: new BehaviorAgent(321, NEUTRAL), x: 0, z: 0 };
    for (let i = 0; i < 5000; i++) {
      const now = i * DT;
      const ta = step(a, now, [], null);
      const tb = step(b, now, [], null);
      expect(ta).toEqual(tb);
    }
    expect(a.x).toBe(b.x);
    expect(a.z).toBe(b.z);
    a.agent.dispose();
    b.agent.dispose();
  });

  it('never asks for more than peak speed, and never emits a vertical component', () => {
    const sim: Sim = { agent: new BehaviorAgent(55, ROAMER), x: 0, z: 0 };
    for (let i = 0; i < 6000; i++) {
      const tick = step(sim, i * DT, [], null);
      expect(Math.hypot(tick.vx, tick.vz)).toBeLessThanOrEqual(MAX_SPEED + 1e-6);
      expect('vy' in tick).toBe(false);
    }
    sim.agent.dispose();
  });

  it('disperses: two adjacent roamers end farther apart after wandering', () => {
    const a: Sim = { agent: new BehaviorAgent(1001, ROAMER), x: 0, z: 0 };
    const b: Sim = { agent: new BehaviorAgent(2002, ROAMER), x: 0.8, z: 0 };
    const start = Math.hypot(a.x - b.x, a.z - b.z);
    const steps = (10 * 60 * 1000) / DT; // ten simulated minutes
    for (let i = 0; i < steps; i++) {
      const now = i * DT;
      step(a, now, [b], null);
      step(b, now, [a], null);
    }
    const end = Math.hypot(a.x - b.x, a.z - b.z);
    expect(end).toBeGreaterThan(start * 2);
    expect(end).toBeGreaterThan(3);
    a.agent.dispose();
    b.agent.dispose();
  });

  it('respects the stand-off: never comes closer than ~1.2 to a parked peer', () => {
    // A very social creature circling a stationary peer must sit beside it,
    // never on top of it. Start outside the stand-off; the approach target
    // construction keeps every stop short of the peer.
    const social: Personality = { ...NEUTRAL, social: 0.95, energy: 0.6 };
    const sim: Sim = { agent: new BehaviorAgent(808, social), x: 5, z: 0 };
    const peer: Sim = { agent: new BehaviorAgent(1, NEUTRAL), x: 0, z: 0 };
    let minGap = Infinity;
    for (let i = 0; i < 12000; i++) {
      step(sim, i * DT, [peer], null);
      minGap = Math.min(minGap, Math.hypot(sim.x - peer.x, sim.z - peer.z));
    }
    expect(minGap).toBeGreaterThanOrEqual(1.2);
    sim.agent.dispose();
    peer.agent.dispose();
  });

  it('is mostly still at the output level (neutral, 10 simulated minutes)', () => {
    const sim: Sim = { agent: new BehaviorAgent(7, NEUTRAL), x: 0, z: 0 };
    let still = 0;
    const steps = (10 * 60 * 1000) / DT;
    for (let i = 0; i < steps; i++) {
      const tick = step(sim, i * DT, [], null);
      if (Math.hypot(tick.vx, tick.vz) < 0.05) still++;
    }
    expect(still / steps).toBeGreaterThanOrEqual(0.55);
    sim.agent.dispose();
  });

  it('sleeps with the sleepy pose and announces it sparsely', () => {
    const dozy: Personality = { ...NEUTRAL, sleepiness: 0.95, energy: 0.15 };
    const sim: Sim = { agent: new BehaviorAgent(99, dozy), x: 0, z: 0 };
    let sleepTicks = 0;
    let emotes = 0;
    let stateEntries = 0;
    let lastState = sim.agent.currentState;
    const steps = (20 * 60 * 1000) / DT;
    for (let i = 0; i < steps; i++) {
      const tick = step(sim, i * DT, [], null);
      if (tick.pose === 'sleep') {
        sleepTicks++;
        expect(Math.hypot(tick.vx, tick.vz)).toBeLessThan(0.2); // asleep = parked
      }
      if (tick.emote) emotes++;
      if (sim.agent.currentState !== lastState) {
        lastState = sim.agent.currentState;
        stateEntries++;
      }
    }
    expect(sleepTicks).toBeGreaterThan(0);
    // Sparse: at most one emote per state entry, and far fewer in practice.
    expect(emotes).toBeLessThanOrEqual(stateEntries);
    sim.agent.dispose();
  });

  it('heading spring never overshoots a step target (ζ≥1)', () => {
    // The agent's heading channel is a Spring at the secondary settle; a step
    // response must approach monotonically and never cross the target.
    const spring = new Spring(0, { settleMs: MOTION.secondaryMs });
    const target = Math.PI * 0.75;
    spring.retarget(target);
    let max = 0;
    for (let t = 0; t < 10000; t += 16) {
      max = Math.max(max, spring.update(16));
    }
    expect(max).toBeLessThanOrEqual(target + 1e-6);
    expect(spring.value).toBeCloseTo(target, 3);
    spring.dispose();
  });

  it('same seed + same collider grid → identical trajectory (colliders draw no rand)', () => {
    const rand = makeRand(64);
    const forest: Collider[] = [];
    for (let i = 0; i < 40; i++) {
      forest.push({
        x: (rand() - 0.5) * 40,
        z: (rand() - 0.5) * 40,
        r: 0.5 + rand(),
        hard: rand() < 0.8,
      });
    }
    const grid = buildColliderGrid(forest);
    const a: Sim = { agent: new BehaviorAgent(321, ROAMER), x: 0, z: 0 };
    const b: Sim = { agent: new BehaviorAgent(321, ROAMER), x: 0, z: 0 };
    for (let i = 0; i < 3000; i++) {
      const now = i * DT;
      expect(step(a, now, [], null, grid)).toEqual(step(b, now, [], null, grid));
    }
    expect(a.x).toBe(b.x);
    expect(a.z).toBe(b.z);
    a.agent.dispose();
    b.agent.dispose();
  });

  it('steers around a wall of hard colliders instead of pushing into it', () => {
    // A roamer wandering with a dense picket to its east. Steering is not
    // the collision system — the manager's positional resolve is — but the
    // avoidance bend must keep the agent flowing around the circles, so any
    // incursion stays a shallow graze the resolve would erase, never a
    // plow-through.
    const picket: Collider[] = [];
    for (let z = -30; z <= 30; z += 2.2) {
      picket.push({ x: 8, z, r: 1, hard: true });
    }
    const grid = buildColliderGrid(picket);
    const sim: Sim = { agent: new BehaviorAgent(909, ROAMER), x: 0, z: 0 };
    let worst = Infinity;
    let insideTicks = 0;
    for (let i = 0; i < 12000; i++) {
      step(sim, i * DT, [], null, grid);
      for (const c of picket) {
        const gap = Math.hypot(sim.x - c.x, sim.z - c.z) - c.r;
        worst = Math.min(worst, gap);
        if (gap < 0) insideTicks++;
      }
    }
    expect(worst).toBeGreaterThan(-0.2); // grazes only, never deep
    expect(insideTicks / 12000).toBeLessThan(0.02); // and rare
    sim.agent.dispose();
  });

  it('setSpeedMultiplier(0) parks the agent without a snap', () => {
    const sim: Sim = { agent: new BehaviorAgent(404, ROAMER), x: 0, z: 0 };
    // Let it get moving first.
    let moving = 0;
    for (let i = 0; i < 4000; i++) {
      const tick = step(sim, i * DT, [], null);
      moving = Math.hypot(tick.vx, tick.vz);
    }
    sim.agent.setSpeedMultiplier(0);
    let prev = moving;
    for (let i = 0; i < 200; i++) {
      const tick = step(sim, (4000 + i) * DT, [], null);
      const speed = Math.hypot(tick.vx, tick.vz);
      // Drift down: no step larger than what one dt of spring decay allows.
      expect(speed).toBeLessThanOrEqual(prev + 1e-9);
      prev = speed;
    }
    expect(prev).toBeLessThan(0.05);
    sim.agent.dispose();
  });
});

describe('BehaviorAgent — held while somebody is steering', () => {
  /**
   * The hold (src/creatures/manager.ts, DRIVE_IDLE_MS): while a person has
   * the stick, and for a moment after they let go, the agent contributes
   * nothing. Pure here — no manager, no scene, just what the agent emits
   * and what it remembers.
   */

  /** Step until the agent is walking somewhere of its own, so the hold has
   * an actual thought to interrupt. */
  function walking(): { agent: BehaviorAgent; sim: Sim } {
    const sim: Sim = { agent: new BehaviorAgent(9182, ROAMER), x: 0, z: 0 };
    for (let i = 0; i < 4000; i++) {
      step(sim, i * DT, [], null);
      if (sim.agent.currentState === 'wander' && sim.agent.currentTarget) break;
    }
    expect(sim.agent.currentState).toBe('wander');
    expect(sim.agent.currentTarget).not.toBeNull();
    return { agent: sim.agent, sim };
  }

  it('drops the target it had chosen, so nothing lurches back to it after', () => {
    const { agent, sim } = walking();
    const stale = agent.currentTarget!;
    agent.update(DT, 0, { x: sim.x, z: sim.z }, [], null, null, { speed: 1.4, heading: 0.4 });
    expect(agent.currentTarget).toBeNull();
    // And the target really was somewhere else — otherwise this asserts
    // nothing about lurching.
    expect(Math.hypot(stale.x - sim.x, stale.z - sim.z)).toBeGreaterThan(1);
    agent.dispose();
  });

  it('emits no steering of its own and does not advance its state', () => {
    const { agent, sim } = walking();
    const before = agent.currentState;
    const hold: AgentHold = { speed: 0, heading: 0.75 };

    // One frame of an actual push first, as the manager always does — the
    // window is only ever opened by somebody steering.
    agent.update(DT, 0, { x: sim.x, z: sim.z }, [], null, null, { speed: 1.5, heading: 0.75 });

    // Ten seconds — longer than any state's drawn duration, so an agent
    // whose machine was still running would certainly have moved on.
    let last = Infinity;
    for (let i = 0; i < 100; i++) {
      const tick = agent.update(DT, i * DT, { x: sim.x, z: sim.z }, [], null, null, hold);
      // Facing is the one it was handed: the agent turns it nowhere.
      expect(tick.heading).toBeCloseTo(0.75, 12);
      expect(tick.emote).toBeUndefined();
      const speed = Math.hypot(tick.vx, tick.vz);
      // A drift-stop, never a brake: monotone down to nothing.
      expect(speed).toBeLessThanOrEqual(last + 1e-9);
      last = speed;
      expect(agent.currentState).toBe(before);
      expect(agent.currentTarget).toBeNull();
    }
    expect(last).toBeLessThan(1e-3);
    agent.dispose();
  });

  it('rides the speed the hand is asking for, so letting go starts from it', () => {
    const { agent, sim } = walking();
    const at = { x: sim.x, z: sim.z };
    // Pushed hard for a moment...
    for (let i = 0; i < 10; i++) {
      agent.update(DT, i * DT, at, [], null, null, { speed: 1.7, heading: 0.2 });
    }
    // ...then the stick rests inside the window. The first frame of the
    // release carries the speed the hand left it at, not a zero and not
    // whatever the agent had been imagining underneath.
    const first = agent.update(DT, 2000, at, [], null, null, { speed: 0, heading: 0.2 });
    const speed = Math.hypot(first.vx, first.vz);
    expect(speed).toBeGreaterThan(1.2);
    expect(speed).toBeLessThan(1.7);
    agent.dispose();
  });

  it('takes the world back when the hold is gone', () => {
    const { agent, sim } = walking();
    for (let i = 0; i < 30; i++) {
      agent.update(DT, i * DT, { x: sim.x, z: sim.z }, [], null, null, { speed: 0, heading: 0 });
    }
    // Unheld again: it is living from where it stands — the first decision
    // after a hold is a fresh one.
    let moved = 0;
    for (let i = 0; i < 600; i++) {
      const tick = step(sim, 10_000 + i * DT, [], null);
      moved = Math.max(moved, Math.hypot(tick.vx, tick.vz));
    }
    expect(moved).toBeGreaterThan(0);
    agent.dispose();
  });
});
