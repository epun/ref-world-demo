/**
 * The stage's pure half (docs/PHONE-STAGE.md §2/§3): flow order, the core
 * measures both sides of the seam agree on, and the swap timeline.
 *
 * The DOM half of states.ts (slots, layers, the ambient floor) is exercised
 * in a real browser by the swap probe — these tests stay node-only per the
 * phone test discipline.
 */

import { describe, expect, it } from 'vitest';
import { MOTION } from '../../src/taste/tokens';
import {
  CORE_SIDE,
  PHONE_STATES,
  SATELLITE_SLOTS,
  SATELLITE_TRAVEL_PX,
  SLOT_NAMES,
  STAGGER_MS,
  stateIndex,
  swapDurationMs,
  swapTimeline,
  type PhoneState,
  type SlotName,
} from '../../src/phone/states';

describe('phone stage', () => {
  it('orders the flow draw → wait → alive', () => {
    expect(PHONE_STATES).toEqual(['draw', 'wait', 'alive']);
    expect(stateIndex('draw')).toBeLessThan(stateIndex('wait'));
    expect(stateIndex('wait')).toBeLessThan(stateIndex('alive'));
  });

  it('keeps four persistent slots, of which three are satellites', () => {
    expect(SLOT_NAMES).toEqual(['brow', 'core', 'tools', 'corner']);
    // The core is the fixed point, never a satellite.
    expect(SATELLITE_SLOTS).not.toContain('core');
    // Reading order — the stagger order of both moves.
    expect(SATELLITE_SLOTS).toEqual(['brow', 'tools', 'corner']);
  });

  it('names a core measure for every state, as a share of the well WIDTH', () => {
    // docs/DEVICE.md §3: the measures are shares of the WELL's width now,
    // not of the viewport — the stage lives inside the device, the well is
    // taller than it is wide, and the core is square, so width bounds it.
    for (const state of PHONE_STATES) {
      expect(CORE_SIDE[state]).toMatch(/^\d+cqw$/);
    }
    // Binding across the /draw/ → /phone.html seam (PHONE-STAGE §2/§4,
    // DEVICE §3). Both pages place against the same well.
    expect(CORE_SIDE.draw).toBe('95cqw');
    expect(CORE_SIDE.wait).toBe('75cqw');
    expect(CORE_SIDE.alive).toBe('100cqw');
  });

  it('preserves the ratios the swap has always travelled', () => {
    // The old measures were 76 / 60 / 80 vmin. The device restates them
    // against the well, and the RATIOS are what carry the choreography:
    // normalising the old scale by its largest term reproduces the new one
    // exactly, so the core still travels the same relative distances.
    const share = (measure: string): number => Number(measure.replace('cqw', ''));
    const old = { draw: 76, wait: 60, alive: 80 };
    for (const state of PHONE_STATES) {
      expect(share(CORE_SIDE[state])).toBeCloseTo((old[state] / old.alive) * 100, 6);
    }
  });

  it('derives the stagger from the token scale rather than picking it', () => {
    expect(STAGGER_MS).toBe(MOTION.tertiaryMs / 4);
    expect(STAGGER_MS).toBe(114);
  });
});

describe('swap timeline', () => {
  const steps = swapTimeline();
  const find = (slot: SlotName, role: 'out' | 'in'): { delayMs: number; durationMs: number } => {
    const step = steps.find((s) => s.slot === slot && s.role === role);
    if (!step) throw new Error(`no ${role} step for ${slot}`);
    return { delayMs: step.delayMs, durationMs: step.durationMs };
  };

  it('takes every duration from MOTION — no literals', () => {
    const allowed = new Set<number>([MOTION.tertiaryMs, MOTION.secondaryMs]);
    for (const step of steps) expect(allowed.has(step.durationMs)).toBe(true);
  });

  it('cross-fades the core in place over t.secondary, from zero', () => {
    for (const role of ['out', 'in'] as const) {
      expect(find('core', role)).toEqual({
        delayMs: 0,
        durationMs: MOTION.secondaryMs,
      });
    }
  });

  it('leaves on t.tertiary and arrives on t.secondary, staggered in reading order', () => {
    SATELLITE_SLOTS.forEach((slot, index) => {
      expect(find(slot, 'out')).toEqual({
        delayMs: index * STAGGER_MS,
        durationMs: MOTION.tertiaryMs,
      });
      expect(find(slot, 'in')).toEqual({
        delayMs: (index + 1) * STAGGER_MS,
        durationMs: MOTION.secondaryMs,
      });
    });
  });

  it('never leaves a slot empty — the incoming move starts before the outgoing ends', () => {
    // The empty-frame test, stated as arithmetic. This is the cut the whole
    // stage model exists to prevent (PHONE-STAGE §3, §6d).
    for (const slot of SLOT_NAMES) {
      const out = find(slot, 'out');
      const inn = find(slot, 'in');
      expect(inn.delayMs).toBeLessThan(out.delayMs + out.durationMs);
    }
  });

  it('has every satellite home before the swap is declared over', () => {
    for (const step of steps) {
      expect(step.delayMs + step.durationMs).toBeLessThanOrEqual(swapDurationMs());
    }
    expect(swapDurationMs()).toBe(3 * STAGGER_MS + MOTION.secondaryMs);
  });

  it('slides satellites a short distance — it never pops them', () => {
    expect(SATELLITE_TRAVEL_PX).toBeGreaterThan(0);
    expect(SATELLITE_TRAVEL_PX).toBeLessThan(24);
  });
});

describe('no screen slider survives', () => {
  it('has no notion of a direction to slide a whole screen in from', () => {
    const mod = { CORE_SIDE, PHONE_STATES } as Record<string, unknown>;
    expect('slideDelta' in mod).toBe(false);
    // Every state is an occupancy of one stage, not a position on a strip.
    const states: PhoneState[] = [...PHONE_STATES];
    expect(new Set(states.map((s) => CORE_SIDE[s])).size).toBe(states.length);
  });
});
