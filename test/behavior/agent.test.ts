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
import { BehaviorAgent, MAX_SPEED, type AgentTick } from '../../src/behavior/agent';
import type { Personality } from '../../src/behavior/personality';
import { Spring } from '../../src/motion/spring';
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

function step(sim: Sim, now: number, peers: Sim[], props: null): AgentTick {
  const tick = sim.agent.update(
    DT,
    now,
    { x: sim.x, z: sim.z },
    peers.map((p, i) => ({ x: p.x, z: p.z, id: `peer-${i}` })),
    props,
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
