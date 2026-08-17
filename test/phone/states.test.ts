/**
 * Pure state-machine logic: flow order and slide direction. The DOM half of
 * states.ts (sections, transitions) is exercised in the browser — these
 * tests stay node-only per the phone test discipline.
 */

import { describe, expect, it } from 'vitest';
import { PHONE_STATES, slideDelta, stateIndex } from '../../src/phone/states';

describe('phone states', () => {
  it('orders the flow draw → wait → alive', () => {
    expect(PHONE_STATES).toEqual(['draw', 'wait', 'alive']);
    expect(stateIndex('draw')).toBeLessThan(stateIndex('wait'));
    expect(stateIndex('wait')).toBeLessThan(stateIndex('alive'));
  });

  it('slides forward transitions in from the right', () => {
    expect(slideDelta('draw', 'wait')).toBe(1);
    expect(slideDelta('wait', 'alive')).toBe(1);
    expect(slideDelta('draw', 'alive')).toBe(1);
  });

  it('slides backward transitions in from the left', () => {
    expect(slideDelta('alive', 'wait')).toBe(-1);
    expect(slideDelta('wait', 'draw')).toBe(-1);
    expect(slideDelta('alive', 'draw')).toBe(-1);
  });

  it('does not move for a no-op transition', () => {
    for (const state of PHONE_STATES) {
      expect(slideDelta(state, state)).toBe(0);
    }
  });
});
