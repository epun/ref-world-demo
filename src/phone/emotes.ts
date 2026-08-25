/**
 * The person's emote set — the six, in key order.
 *
 * This lives on its own, apart from the screen that first defined it,
 * because it is now read from TWO surfaces: the six keys on the case
 * (screens/alive.ts) and the ring under the mini device in the world view
 * (src/world/tray.ts). The world view importing it from `screens/alive`
 * would drag that whole module — a WebGLRenderer, the ink and grain
 * passes, the portrait camera — into the world bundle for the sake of six
 * strings.
 *
 * One list, one order, one place. The two surfaces show the same person
 * the same six emotes in the same arrangement, and there is nowhere for
 * them to disagree (user report, 2026-08-25: they had).
 */

import type { EmoteName } from '../net/protocol';

/**
 * Six emotes on six keys, in the order the case reads them: the top row
 * left to right, then the bottom row. Six and not seven — `angry` is
 * dropped from the PHONE's set by ruling and stays in `EMOTE_NAMES`,
 * because the world still uses it for autonomous behaviour. Typed as
 * EmoteName, so dropping one from the protocol breaks the build here
 * rather than silently sending an emote nothing understands.
 */
export const PHONE_EMOTE_KEYS: Record<'top' | 'bottom', readonly EmoteName[]> = {
  top: ['wave', 'happy', 'surprised'],
  bottom: ['dance', 'sleepy', 'sad'],
};

/** Every emote the phone can send, in key order. */
export const PHONE_EMOTES: readonly EmoteName[] = [
  ...PHONE_EMOTE_KEYS.top,
  ...PHONE_EMOTE_KEYS.bottom,
];
