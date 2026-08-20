/**
 * Alive-screen pure logic: the emote de-dupe.
 *
 * User ask, 2026-08-20: *"once the character hatches and if a user emotes we
 * should have the character show the same emote on mobile as we do in the
 * world."* The portrait is the identical `createCharacter` pipeline, so
 * parity is a wiring job — the tap plays `character.emote()` locally at
 * once AND publishes.
 *
 * The part worth testing is what stops that from playing twice. An emote
 * rides on `PoseMsg.emote` as a transient marker that repeats on every pose
 * frame while it is fresh (SameDeviceSession holds it for 2s at ~10Hz), so
 * a pose emote is only a new event when it differs from the marker last
 * seen — and the tap records itself as the marker on the way out.
 *
 * The DOM half (the portrait, the wheel, the map) is exercised in a real
 * browser by the device probe; these tests stay node-only per the phone
 * test discipline.
 */

import { describe, expect, it } from 'vitest';
import { BUBBLE_EMOJI } from '../../src/character/bubble';
import { EMOTE_NAMES, type EmoteName } from '../../src/net/protocol';
import {
  nextPoseEmote,
  PHONE_EMOTES,
  PHONE_EMOTE_KEYS,
} from '../../src/phone/screens/alive';
import { KEYS_PER_ROW, KEY_COUNT } from '../../src/phone/device';

/** Drive a stream of pose markers through the helper, collecting plays. */
function run(stream: readonly (EmoteName | undefined)[]): (EmoteName | null)[] {
  let marker: EmoteName | null = null;
  const played: (EmoteName | null)[] = [];
  for (const incoming of stream) {
    const next = nextPoseEmote(incoming, marker);
    marker = next.marker;
    if (next.play !== null) played.push(next.play);
  }
  return played;
}

describe('nextPoseEmote', () => {
  const [a, b] = EMOTE_NAMES as readonly EmoteName[];
  if (!a || !b) throw new Error('need at least two emotes');

  it('plays a fresh emote once, however many frames carry it', () => {
    // ~2s of echo at 10Hz is twenty frames of the same marker.
    expect(run(Array.from({ length: 20 }, () => a))).toEqual([a]);
  });

  it('never plays the echo of a tap that already played locally', () => {
    // The tap sets the marker itself before the wire ever answers.
    let marker: EmoteName | null = a;
    const played: EmoteName[] = [];
    for (let i = 0; i < 20; i++) {
      const next = nextPoseEmote(a, marker);
      marker = next.marker;
      if (next.play !== null) played.push(next.play);
    }
    expect(played).toEqual([]);
  });

  it('plays a different emote arriving mid-echo', () => {
    expect(run([a, a, a, b, b, b])).toEqual([a, b]);
  });

  it('lets the same emote fire again once the marker has cleared', () => {
    expect(run([a, a, undefined, undefined, a, a])).toEqual([a, a]);
  });

  it('clears the marker on a pose with no emote', () => {
    expect(nextPoseEmote(undefined, a)).toEqual({ play: null, marker: null });
  });

  it('is pure — the same inputs always give the same answer', () => {
    for (const name of EMOTE_NAMES) {
      expect(nextPoseEmote(name, null)).toEqual({ play: name, marker: name });
      expect(nextPoseEmote(name, name)).toEqual({ play: null, marker: name });
    }
  });
});

/**
 * The phone's emote set (docs/DEVICE.md §2). The wheel is gone: the emotes
 * are keys on the case, three over three — *"it looks like we have seven
 * emotes, so we would need three, and I think it's okay to get rid of the
 * angry emote."*
 */
describe('the emotes the case carries', () => {
  it('fills both rows of the case exactly', () => {
    expect(PHONE_EMOTE_KEYS.top).toHaveLength(KEYS_PER_ROW);
    expect(PHONE_EMOTE_KEYS.bottom).toHaveLength(KEYS_PER_ROW);
    expect(PHONE_EMOTES).toHaveLength(KEY_COUNT);
  });

  it('is the rows the device doc names, in order', () => {
    expect(PHONE_EMOTE_KEYS.top).toEqual(['wave', 'happy', 'surprised']);
    expect(PHONE_EMOTE_KEYS.bottom).toEqual(['dance', 'sleepy', 'sad']);
  });

  it('drops angry from the PHONE, not from the protocol', () => {
    // The world still uses it for autonomous behaviour, so it stays in
    // EMOTE_NAMES. This is the phone's button set, not the protocol.
    expect(PHONE_EMOTES).not.toContain('angry');
    expect(EMOTE_NAMES).toContain('angry');
    expect(PHONE_EMOTES.length).toBe(EMOTE_NAMES.length - 1);
  });

  it('sends nothing the protocol does not know, and repeats nothing', () => {
    for (const name of PHONE_EMOTES) expect(EMOTE_NAMES).toContain(name);
    expect(new Set(PHONE_EMOTES).size).toBe(PHONE_EMOTES.length);
  });

  it('carries the same glyphs the wheel did, and the bubble still does', () => {
    // The key and the speech bubble it triggers must always agree.
    for (const name of PHONE_EMOTES) {
      expect(BUBBLE_EMOJI[name]).toBeTruthy();
    }
  });
});
