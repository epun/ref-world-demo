/**
 * The phone ↔ world link, over the room's own mqtt topic.
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
 * Wire shapes (same topic as drawings, distinguished by `type`):
 *
 *   phone → world, on `drawto3d/v1/{room}`
 *     { id, type: "emote", from: "<drawer id>", emote: "happy", ts }
 *     { id, type: "hello", from: "<drawer id>", ts }
 *
 *   world → phones, on `drawto3d/v1/{room}/up`
 *     { type: "verdict", to: "<drawer id>", disposition, reason, epoch }
 *     { type: "world", epoch: "<world session>" }
 *
 * `id` MUST be unique per message: the vendored feed de-dupes by `id`, so a
 * stable one would silently swallow every message after the first. The
 * drawer identity travels in `from` instead.
 *
 * The downlink exists for two things the phone cannot know on its own: that
 * its drawing was refused (so the person is told, on their own handset,
 * rather than left waiting on an egg that will never appear), and which
 * world session is running (so a world that restarted and lost everyone
 * lets its drawers in again).
 */

import type { EmoteName } from './protocol.js';

/** Topic prefix — the vendored kit's, so we share the room with drawings. */
const TOPIC_PREFIX = 'drawto3d/v1/';
/** The kit's public broker (same default the draw page connects to). */
const BROKER = 'wss://broker.emqx.io:8084/mqtt';

/** Minimal shape we use from the mqtt client script tag. */
interface MqttClientLike {
  publish(topic: string, payload: string, opts?: Record<string, unknown>): void;
  subscribe(topic: string): void;
  on(event: string, handler: (...args: unknown[]) => void): void;
  end(force?: boolean): void;
}
interface MqttLike {
  connect(url: string, opts?: Record<string, unknown>): MqttClientLike;
}

/** What the world says about one drawer's drawing. */
export interface Verdict {
  disposition: string;
  reason: string | null;
  /** The world session that made the call (see readWorldEpoch). */
  epoch: string | null;
}

export interface PhoneLink {
  /** Tap an emote — it plays on this drawer's creature in the world. */
  send(emote: EmoteName): void;
  /** Announce this handset so the world answers with its verdict + epoch.
   * Sent on join; the answer arrives on the downlink. */
  hello(): void;
  /** Verdicts addressed to THIS drawer. */
  onVerdict(handler: (v: Verdict) => void): void;
  /** The running world's session id, whenever it announces one. */
  onWorldEpoch(handler: (epoch: string) => void): void;
  /**
   * The world opened THIS drawer's egg.
   *
   * Without it the handset hatches on its own local timer and the two run
   * independently — the creature appears on the projection and some seconds
   * later, unrelated, on the phone (user report). The hatch is the moment
   * the whole thing is about, so it is the world's to call: it fires this
   * the instant the shell breaks, and the handset plays its own hatch off
   * the same edge.
   */
  onHatched(handler: () => void): void;
  /**
   * The world asked every handset to re-send its drawing.
   *
   * RECOVERY (2026-08-20): the world's session log lives in memory, so a
   * refresh of the projection loses the population — but every handset
   * still holds its own drawing in localStorage, and the pipeline is
   * deterministic, so re-publishing those strokes under the same id
   * rebuilds the exact same creatures. This is the channel that asks.
   */
  onRecall(handler: () => void): void;
  /** Re-publish a drawing this handset already sent, in the kit's own wire
   * shape so the world's feed ingests it exactly as it did the first time. */
  resend(payload: { id: string; name: string | null; strokes: unknown[] }): void;
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
export function createPhoneLink(
  room: string,
  from: string,
  deps: { mqtt?: unknown; broker?: string; random?: () => number } = {},
): PhoneLink | null {
  const mqtt = (deps.mqtt ?? (globalThis as { mqtt?: unknown }).mqtt) as MqttLike | undefined;
  if (!mqtt || typeof mqtt.connect !== 'function') return null;
  const rand = deps.random ?? Math.random;
  const topic = TOPIC_PREFIX + room;
  const downTopic = topic + '/up'; // the kit's name for world → phones
  let seq = 0;
  let client: MqttClientLike | null = null;
  const verdictHandlers: ((v: Verdict) => void)[] = [];
  const hatchedHandlers: (() => void)[] = [];
  const recallHandlers: (() => void)[] = [];
  const epochHandlers: ((epoch: string) => void)[] = [];
  // The world answers a hello within a round trip, while the phone is still
  // mounting its screens (a webgl screen easily takes longer than the
  // answer takes to arrive). An answer that lands before anyone is
  // listening is HELD, not dropped, and replayed to the first handler —
  // otherwise being told your drawing was refused is a race you lose on a
  // slow handset. Only the latest of each is worth keeping.
  let heldVerdict: Verdict | null = null;
  let heldHatched = false;
  let heldRecall = false;
  let heldEpoch: string | null = null;

  try {
    client = mqtt.connect(deps.broker ?? BROKER, {
      clientId: 'phone_' + Math.floor(rand() * 0x100000000).toString(16),
      keepalive: 30,
      reconnectPeriod: 2000,
    });
  } catch {
    return null;
  }

  const publish = (body: Record<string, unknown>): void => {
    if (!client) return;
    // qos 0: these are moments, not records — a dropped wave is a dropped
    // wave, and a late retry would be worse than the loss.
    try {
      client.publish(
        topic,
        JSON.stringify({ id: messageId(from, seq++, rand), from, ts: Date.now(), ...body }),
        { qos: 0 },
      );
    } catch {
      /* offline — the local echo already played on the phone */
    }
  };

  try {
    client.on('connect', () => {
      client?.subscribe(downTopic);
      // Re-announce on every (re)connect: the world answers with this
      // drawer's verdict and its session, which is how a phone that joined
      // late — or after the world restarted — catches up.
      publish({ type: 'hello' });
    });
    client.on('message', (...args: unknown[]) => {
      const [t, payload] = args as [string, { toString(): string }];
      if (t !== downTopic) return;
      let msg: unknown;
      try {
        msg = JSON.parse(payload.toString());
      } catch {
        return;
      }
      // Verdict first: a refusal rides on a message that also carries the
      // world session, and being TOLD must outrank any session bookkeeping
      // the epoch handler would otherwise do with the same message.
      const verdict = readVerdict(msg, from);
      if (verdict) {
        if (verdictHandlers.length === 0) heldVerdict = verdict;
        else for (const h of verdictHandlers) h(verdict);
      }
      const epoch = readWorldEpoch(msg);
      if (epoch !== null) {
        if (epochHandlers.length === 0) heldEpoch = epoch;
        else for (const h of epochHandlers) h(epoch);
      }
      if (readRecall(msg)) {
        // Held like the rest: a recall that arrives before this screen has
        // registered its handler must not be the one that gets away.
        if (recallHandlers.length === 0) heldRecall = true;
        else for (const h of recallHandlers) h();
      }
      if (readHatched(msg, from)) {
        // Held like a verdict: the world can call the hatch before this
        // screen has registered its handler, and a missed hatch would
        // strand the handset on the egg forever.
        if (hatchedHandlers.length === 0) heldHatched = true;
        else for (const h of hatchedHandlers) h();
      }
    });
  } catch {
    /* a client without on/subscribe is a publish-only link — still useful */
  }

  return {
    send(emote: EmoteName): void {
      publish({ type: 'emote', emote });
    },
    hello(): void {
      publish({ type: 'hello' });
    },
    onRecall(handler): void {
      recallHandlers.push(handler);
      if (heldRecall) {
        heldRecall = false;
        handler();
      }
    },
    resend(payload): void {
      if (!client) return;
      // The kit's wire shape, NOT the emote envelope: the world's feed
      // reads {id, name, strokes, ts} and must ingest this exactly as it
      // ingested the original publish from the draw page.
      try {
        client.publish(
          topic,
          JSON.stringify({
            id: payload.id,
            name: payload.name ?? '',
            strokes: payload.strokes,
            ts: Date.now(),
          }),
          { qos: 0 },
        );
      } catch {
        /* offline — nothing to recover from this handset */
      }
    },
    onHatched(handler): void {
      hatchedHandlers.push(handler);
      if (heldHatched) {
        heldHatched = false;
        handler();
      }
    },
    onVerdict(handler): void {
      verdictHandlers.push(handler);
      if (heldVerdict) {
        const held = heldVerdict;
        heldVerdict = null;
        handler(held);
      }
    },
    onWorldEpoch(handler): void {
      epochHandlers.push(handler);
      if (heldEpoch !== null) {
        const held = heldEpoch;
        heldEpoch = null;
        handler(held);
      }
    },
    dispose(): void {
      try {
        client?.end(true);
      } catch {
        /* already gone */
      }
      client = null;
      verdictHandlers.length = 0;
      epochHandlers.length = 0;
    },
  };
}

/** A verdict addressed to `me`, or null. Pure — the phone routes with it. */
export function readVerdict(msg: unknown, me: string): Verdict | null {
  if (typeof msg !== 'object' || msg === null) return null;
  const rec = msg as Record<string, unknown>;
  if (rec['type'] !== 'verdict') return null;
  if (typeof rec['to'] !== 'string' || rec['to'] !== me) return null;
  const disposition = rec['disposition'];
  if (typeof disposition !== 'string' || disposition.length === 0) return null;
  return {
    disposition,
    reason: typeof rec['reason'] === 'string' ? rec['reason'] : null,
    epoch: typeof rec['epoch'] === 'string' ? rec['epoch'] : null,
  };
}

/** The world session id carried by any world → phone message, or null. */
/** A broadcast recall: every handset re-sends what it already drew. */
export function readRecall(msg: unknown): boolean {
  if (typeof msg !== 'object' || msg === null) return false;
  return (msg as { type?: unknown }).type === 'recall';
}

/** A `hatched` message addressed to this drawer. */
export function readHatched(msg: unknown, me: string): boolean {
  if (typeof msg !== 'object' || msg === null) return false;
  const rec = msg as { type?: unknown; to?: unknown };
  return rec.type === 'hatched' && typeof rec.to === 'string' && rec.to === me;
}

export function readWorldEpoch(msg: unknown): string | null {
  if (typeof msg !== 'object' || msg === null) return null;
  const rec = msg as Record<string, unknown>;
  const epoch = rec['epoch'];
  if (typeof epoch !== 'string' || epoch.length === 0) return null;
  if (rec['type'] !== 'world' && rec['type'] !== 'verdict') return null;
  return epoch;
}

/** A hello from a phone, or null — the world answers these. Pure. */
export function readHello(msg: unknown): { from: string } | null {
  if (typeof msg !== 'object' || msg === null) return null;
  const rec = msg as Record<string, unknown>;
  if (rec['type'] !== 'hello') return null;
  const from = rec['from'];
  if (typeof from !== 'string' || from.length === 0) return null;
  return { from };
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
