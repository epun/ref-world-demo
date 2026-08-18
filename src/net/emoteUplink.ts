/**
 * Phone → world emotes over the room's own mqtt topic.
 *
 * The relay this project also carries (worker/relay.ts + src/net/client.ts)
 * is written but not deployed, so on the live demo every phone session falls
 * back to SameDeviceSession and `sendEmote` never leaves the handset — the
 * tap animated the button and nothing happened in the world (user report).
 *
 * Drawings, meanwhile, DO arrive: the vendored draw-to-3d feed publishes
 * them on `drawto3d/v1/{room}` and the world subscribes to exactly that.
 * So emotes ride the transport that demonstrably works, as one more message
 * shape on the same topic. When the relay is eventually deployed this stays
 * harmless: the world ignores an emote for a creature it does not hold.
 *
 * Wire shape (same topic as drawings, distinguished by `type`):
 *   { id: "<unique per message>", type: "emote", from: "<drawer id>",
 *     emote: "happy", ts: 1234 }
 *
 * `id` MUST be unique per message: the vendored feed de-dupes by `id`, so a
 * stable one would silently swallow every emote after the first. The drawer
 * identity travels in `from` instead.
 */

import type { EmoteName } from './protocol';

/** Topic prefix — the vendored kit's, so we share the room with drawings. */
const TOPIC_PREFIX = 'drawto3d/v1/';
/** The kit's public broker (same default the draw page connects to). */
const BROKER = 'wss://broker.emqx.io:8084/mqtt';

/** Minimal shape we use from the mqtt client script tag. */
interface MqttLike {
  connect(
    url: string,
    opts?: Record<string, unknown>,
  ): { publish(topic: string, payload: string, opts?: Record<string, unknown>): void; end(force?: boolean): void };
}

export interface EmoteUplink {
  send(emote: EmoteName): void;
  dispose(): void;
}

/** Message id: unique per emote, so the feed's de-dupe never eats one. */
function messageId(from: string, seq: number, rand: () => number): string {
  return `${from}-e${seq}-${Math.floor(rand() * 0x100000).toString(36)}`;
}

/**
 * Open the uplink for one room. Returns null when there is no mqtt client on
 * the page (the vendored script tag is absent, or this is a test) — callers
 * treat that as "no network" and carry on with the local echo.
 */
export function createEmoteUplink(
  room: string,
  from: string,
  deps: { mqtt?: unknown; broker?: string; random?: () => number } = {},
): EmoteUplink | null {
  const mqtt = (deps.mqtt ?? (globalThis as { mqtt?: unknown }).mqtt) as MqttLike | undefined;
  if (!mqtt || typeof mqtt.connect !== 'function') return null;
  const rand = deps.random ?? Math.random;
  const topic = TOPIC_PREFIX + room;
  let seq = 0;
  let client: ReturnType<MqttLike['connect']> | null = null;
  try {
    client = mqtt.connect(deps.broker ?? BROKER, {
      clientId: 'emote_' + Math.floor(rand() * 0x100000000).toString(16),
      keepalive: 30,
      reconnectPeriod: 2000,
    });
  } catch {
    return null;
  }
  return {
    send(emote: EmoteName): void {
      if (!client) return;
      const payload = JSON.stringify({
        id: messageId(from, seq++, rand),
        type: 'emote',
        from,
        emote,
        ts: Date.now(),
      });
      // qos 0: an emote is a moment, not a record — a dropped one is a
      // dropped wave, and retrying it late would be worse than losing it.
      try {
        client.publish(topic, payload, { qos: 0 });
      } catch {
        /* offline — the local echo already played on the phone */
      }
    },
    dispose(): void {
      try {
        client?.end(true);
      } catch {
        /* already gone */
      }
      client = null;
    },
  };
}

/** Parse an inbound feed message as an emote, or null if it is not one.
 * Pure — the world's ingest routes with this. */
export function readEmoteMessage(
  msg: unknown,
  isEmoteName: (v: string) => boolean,
): { from: string; emote: EmoteName } | null {
  if (typeof msg !== 'object' || msg === null) return null;
  const rec = msg as Record<string, unknown>;
  if (rec['type'] !== 'emote') return null;
  const from = rec['from'];
  const emote = rec['emote'];
  if (typeof from !== 'string' || from.length === 0) return null;
  if (typeof emote !== 'string' || !isEmoteName(emote)) return null;
  return { from, emote: emote as EmoteName };
}
