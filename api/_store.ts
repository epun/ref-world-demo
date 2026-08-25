/**
 * Where a public world's population actually lives.
 *
 * The installation world is ephemeral by design — drawings travel
 * phone → mqtt → projection and exist only in the browser that is showing
 * them. That is right for a room you can see, and wrong for a link anyone
 * can open: a public world has to still be there when nobody is watching.
 *
 * So this is the one piece of server the project has. It is deliberately
 * thin: a list of drawings per world, plus a per-device marker for the
 * one-creature rule. Nothing about generation moves here — `src/shape/` and
 * `src/inflate/` stay pure and stay on the client, so the world is still
 * rebuilt from strokes on every device rather than served as geometry.
 *
 * ABSENT BY DEFAULT. With no store configured every call returns null or
 * empty and the pages fall back to exactly the behaviour they have today.
 * A public world without a database is a private world, not a broken one —
 * which is what lets this ship before the store exists.
 */

import { Redis } from '@upstash/redis';

/** A drawing as it is stored, and as the world reads it back. */
export interface StoredDrawing {
  /** The identity the creature is spawned under — the drawer's device id. */
  id: string;
  name: string | null;
  /** The kit's wire strokes, exactly as published. */
  strokes: unknown[];
  /** Wall clock, for ordering. The only clock in the record. */
  ts: number;
  /** admitted → in the world. held → waiting on the moderator. */
  disposition: 'admitted' | 'held' | 'refused';
  /** What the automatic screen said, kept for the moderator's readout. */
  verdict?: string;
  reason?: string | null;
}

/**
 * Vercel's KV integration and the newer Upstash one set differently-named
 * variables for the same Redis. Read both rather than making the operator
 * rename anything — the failure this avoids is a store that is connected
 * and silently unused.
 */
function credentials(): { url: string; token: string } | null {
  const env = process.env;
  const url = env['KV_REST_API_URL'] ?? env['UPSTASH_REDIS_REST_URL'] ?? '';
  const token = env['KV_REST_API_TOKEN'] ?? env['UPSTASH_REDIS_REST_TOKEN'] ?? '';
  if (!url || !token) return null;
  return { url, token };
}

let cached: Redis | null | undefined;

/** The store, or null when none is configured. Never throws. */
export function store(): Redis | null {
  if (cached !== undefined) return cached;
  const creds = credentials();
  if (!creds) {
    cached = null;
    return null;
  }
  try {
    cached = new Redis({ url: creds.url, token: creds.token });
  } catch {
    cached = null;
  }
  return cached;
}

export const hasStore = (): boolean => store() !== null;

/** A world id is a name in a url. Keep it to what a name can be. */
export function worldKey(raw: unknown): string {
  const s = String(raw ?? '').toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 24);
  return s.length > 0 ? s : 'public';
}

const listKey = (world: string): string => `refworld:${world}:drawings`;
const deviceKey = (world: string, device: string): string =>
  `refworld:${world}:device:${device}`;

/** Every drawing in a world, oldest first. */
export async function readDrawings(world: string): Promise<StoredDrawing[]> {
  const db = store();
  if (!db) return [];
  try {
    const rows = await db.lrange<StoredDrawing | string>(listKey(world), 0, -1);
    const out: StoredDrawing[] = [];
    for (const row of rows) {
      // Upstash parses json for us when it can; older writes may be strings.
      const rec = typeof row === 'string' ? (JSON.parse(row) as StoredDrawing) : row;
      if (rec && typeof rec.id === 'string' && Array.isArray(rec.strokes)) out.push(rec);
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * Has this device already made a creature in this world?
 *
 * The device marker is the server half of the one-creature rule. The client
 * half is localStorage, which a person can clear in two taps — fine for a
 * room where you can see everyone, not enough for a public link. Neither
 * half is identity: this is a courtesy rail, not an access control, and it
 * should not pretend otherwise.
 */
export async function deviceDrawing(
  world: string,
  device: string,
): Promise<string | null> {
  const db = store();
  if (!db || !device) return null;
  try {
    return await db.get<string>(deviceKey(world, device));
  } catch {
    return null;
  }
}

/**
 * Record a drawing and claim the device slot, atomically enough.
 *
 * `set` with `nx` is the claim: two taps racing from one handset cannot
 * both win it. The drawing is appended only after the claim succeeds, so a
 * lost race leaves no orphan in the list.
 */
export async function addDrawing(
  world: string,
  drawing: StoredDrawing,
): Promise<{ ok: boolean; reason?: string }> {
  const db = store();
  if (!db) return { ok: false, reason: 'no store configured' };
  try {
    const claimed = await db.set(deviceKey(world, drawing.id), drawing.id, { nx: true });
    if (claimed === null) return { ok: false, reason: 'this device already drew' };
    await db.rpush(listKey(world), JSON.stringify(drawing));
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : 'store write failed' };
  }
}

/**
 * Change one drawing's disposition — the moderator's whole vocabulary.
 *
 * Read-modify-write on the list, because the alternative (a hash keyed by
 * id) loses the order the world spawns in, and order is what makes the
 * population reproducible. The list is small and moderation is rare.
 */
export async function setDisposition(
  world: string,
  id: string,
  disposition: StoredDrawing['disposition'],
): Promise<boolean> {
  const db = store();
  if (!db) return false;
  try {
    const rows = await readDrawings(world);
    const index = rows.findIndex((r) => r.id === id);
    if (index === -1) return false;
    const next: StoredDrawing = { ...rows[index]!, disposition };
    await db.lset(listKey(world), index, JSON.stringify(next));
    return true;
  } catch {
    return false;
  }
}

/**
 * Is this request the moderator's?
 *
 * A shared secret in a header, checked in constant time. Not a login: there
 * is one moderator and the surface is three endpoints. What matters is that
 * an unset secret REFUSES rather than allows — a moderation endpoint that
 * opens itself when misconfigured is worse than one that never works.
 */
export function isModerator(header: string | string[] | undefined): boolean {
  const secret = process.env['MODERATOR_SECRET'] ?? '';
  if (secret.length < 8) return false;
  const given = Array.isArray(header) ? (header[0] ?? '') : (header ?? '');
  if (given.length !== secret.length) return false;
  let diff = 0;
  for (let i = 0; i < secret.length; i++) diff |= secret.charCodeAt(i) ^ given.charCodeAt(i);
  return diff === 0;
}
