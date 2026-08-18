/**
 * The ingest gate: the authoritative seam between a drawing arriving and a
 * creature existing. These tests pin the behaviour the installation is run
 * on — a refused drawing never spawns, a blocked drawer never comes back,
 * and holding an event's arrivals is one switch.
 */

import { describe, expect, it, vi } from 'vitest';
import { createIngestGate } from '../../src/moderation/gate';
import { circleBlob } from '../fixtures/strokes';
import { INNOCENT_SET, PHALLUS_SET } from '../fixtures/moderation';

const innocent = INNOCENT_SET.find((f) => f.name === 'cat')!.strokes;
const offensive = PHALLUS_SET[0]!.strokes;

function harness(): {
  spawned: string[];
  cleared: string[];
  gate: ReturnType<typeof createIngestGate>;
} {
  const spawned: string[] = [];
  const cleared: string[] = [];
  const live = new Set<string>();
  const gate = createIngestGate({
    spawn: (d) => {
      spawned.push(d.id);
      live.add(d.id);
      return true;
    },
    clear: (id) => {
      cleared.push(id);
      live.delete(id);
    },
    live: (id) => live.has(id),
  });
  return { spawned, cleared, gate };
}

describe('ingest gate', () => {
  it('spawns an allowed drawing', () => {
    const { spawned, gate } = harness();
    const entry = gate.offer({ id: 'a', name: 'ana', strokes: innocent });
    expect(entry.disposition).toBe('admitted');
    expect(spawned).toEqual(['a']);
    expect(gate.admitted().map((e) => e.id)).toEqual(['a']);
  });

  it('never spawns a refused drawing, and says nothing back', () => {
    const { spawned, gate } = harness();
    const entry = gate.offer({ id: 'b', name: 'bo', strokes: offensive });
    expect(entry.disposition).toBe('refused');
    expect(entry.verdict).toBe('refuse');
    expect(spawned).toEqual([]);
    expect(gate.admitted()).toEqual([]);
    // The refusal exists only in the operator log.
    expect(gate.log()[0]?.id).toBe('b');
  });

  it('queues everything while hold-all is on, then spawns on approval', () => {
    const { spawned, gate } = harness();
    gate.setHoldAll(true);
    gate.offer({ id: 'a', name: 'ana', strokes: innocent });
    gate.offer({ id: 'c', name: 'cy', strokes: innocent });
    expect(spawned).toEqual([]);
    expect(gate.pending().map((e) => e.id)).toEqual(['a', 'c']);

    expect(gate.approve('a')).toBe(true);
    expect(spawned).toEqual(['a']);
    expect(gate.discard('c')).toBe(true);
    expect(spawned).toEqual(['a']);
    expect(gate.pending()).toEqual([]);
  });

  it('still refuses under hold-all — a refusal is not a queue item', () => {
    const { gate } = harness();
    gate.setHoldAll(true);
    expect(gate.offer({ id: 'b', strokes: offensive }).disposition).toBe('refused');
    expect(gate.pending()).toEqual([]);
  });

  it('replaces a drawer’s queued drawing rather than queueing two', () => {
    const { gate } = harness();
    gate.setHoldAll(true);
    gate.offer({ id: 'a', name: 'first', strokes: innocent });
    gate.offer({ id: 'a', name: 'second', strokes: circleBlob });
    expect(gate.pending().map((e) => e.name)).toEqual(['second']);
  });

  it('approve all / discard all work the whole queue', () => {
    const { spawned, gate } = harness();
    gate.setHoldAll(true);
    gate.offer({ id: 'a', strokes: innocent });
    gate.offer({ id: 'c', strokes: innocent });
    expect(gate.approveAll()).toBe(2);
    expect(spawned).toEqual(['a', 'c']);
    gate.offer({ id: 'd', strokes: innocent });
    expect(gate.discardAll()).toBe(1);
    expect(spawned).toEqual(['a', 'c']);
  });

  it('removes one creature in one call', () => {
    const { cleared, gate } = harness();
    gate.offer({ id: 'a', strokes: innocent });
    expect(gate.remove('a')).toBe(true);
    expect(cleared).toEqual(['a']);
    expect(gate.admitted()).toEqual([]);
  });

  it('blocks a drawer: clears what they made and refuses what comes next', () => {
    const { spawned, cleared, gate } = harness();
    gate.offer({ id: 'a', name: 'ana', strokes: innocent });
    gate.block('a');
    expect(cleared).toEqual(['a']);
    const again = gate.offer({ id: 'a', name: 'ana', strokes: innocent });
    expect(again.disposition).toBe('blocked');
    expect(spawned).toEqual(['a']); // the first spawn only
    expect(gate.blocked()).toEqual(['a']);
    expect(gate.unblock('a')).toBe(true);
    expect(gate.offer({ id: 'a', strokes: innocent }).disposition).toBe('admitted');
  });

  it('blocking also drops that drawer from the approval queue', () => {
    const { spawned, gate } = harness();
    gate.setHoldAll(true);
    gate.offer({ id: 'a', strokes: innocent });
    gate.block('a');
    expect(gate.pending()).toEqual([]);
    expect(spawned).toEqual([]);
  });

  it('hides creatures the world no longer holds', () => {
    const { gate } = harness();
    gate.offer({ id: 'a', strokes: innocent });
    expect(gate.admitted()).toHaveLength(1);
    gate.remove('a');
    expect(gate.admitted()).toHaveLength(0);
  });

  it('reports unusable ink separately from a refusal', () => {
    const gate = createIngestGate({ spawn: () => false });
    const entry = gate.offer({ id: 'a', strokes: innocent });
    expect(entry.disposition).toBe('unusable');
    expect(entry.verdict).toBe('allow');
    expect(gate.admitted()).toEqual([]);
  });

  it('notifies listeners on every decision', () => {
    const { gate } = harness();
    const seen = vi.fn();
    const off = gate.onChange(seen);
    gate.offer({ id: 'a', strokes: innocent });
    gate.offer({ id: 'b', strokes: offensive });
    expect(seen).toHaveBeenCalledTimes(2);
    off();
    gate.offer({ id: 'c', strokes: innocent });
    expect(seen).toHaveBeenCalledTimes(2);
  });

  it('keeps the newest decisions first and caps the log', () => {
    const gate = createIngestGate({ spawn: () => true, logLimit: 3 });
    for (const id of ['a', 'b', 'c', 'd']) gate.offer({ id, strokes: innocent });
    expect(gate.log()).toHaveLength(3);
    expect(gate.log()[0]?.id).toBe('d');
  });
});
