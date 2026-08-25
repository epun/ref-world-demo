/**
 * The public world's front door.
 *
 * GET  — every admitted drawing, as a session log the world restores.
 * POST — one handset offering a drawing.
 *
 * The AUTOMATIC SCREEN RUNS HERE, not only on the handset. The draw page
 * screens locally so a refusal is instant and private, but a local check is
 * advice from a client we do not control — on a public link it has to be
 * re-run somewhere the submitter cannot reach. It is the same pure function
 * either way (`src/moderation/screen.ts`), so the two never disagree about
 * a drawing, only about who is asking.
 *
 * A held drawing is stored, not dropped: it is waiting on the moderator,
 * and the person who drew it is told nothing (the shared screen must never
 * reward the attempt, and neither must an api response).
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { feedDrawingToStrokes } from '../src/net/drawFeed';
import { screenDrawing } from '../src/moderation/screen';
import {
  addDrawing,
  deviceDrawing,
  hasStore,
  readDrawings,
  worldKey,
  type StoredDrawing,
} from './_store';

/** Mirrors src/main.ts, so a restored public world paces like the room. */
const HATCH_MS = 20000;
/** A drawing is a few dozen strokes. Anything larger is not a drawing. */
const MAX_BODY_STROKES = 400;
const MAX_POINTS_PER_STROKE = 4000;

function readBody(req: VercelRequest): Record<string, unknown> | null {
  const b = req.body;
  if (typeof b === 'string') {
    try {
      return JSON.parse(b) as Record<string, unknown>;
    } catch {
      return null;
    }
  }
  if (b && typeof b === 'object') return b as Record<string, unknown>;
  return null;
}

/** Admitted drawings, shaped as the log `sessionApi.restore` already reads. */
function asSessionLog(world: string, rows: StoredDrawing[]) {
  const events: unknown[] = [];
  let t = 0;
  for (const row of rows) {
    if (row.disposition !== 'admitted') continue;
    const strokes = feedDrawingToStrokes({ strokes: row.strokes as never });
    if (strokes.length === 0) continue;
    events.push({
      t,
      k: 'drawing',
      id: row.id,
      name: row.name,
      personality: null,
      source: 'phone',
      strokes,
      hatchMs: HATCH_MS,
      disposition: 'admitted',
      verdict: 'allow',
      reason: null,
      confidence: 1,
    });
    events.push({ t: t + 1, k: 'hatch', id: row.id, cause: 'forced' });
    t += 40;
  }
  return {
    schema: 'refworld.session',
    version: 1,
    epoch: `public-${world}`,
    room: world,
    startedAt: new Date(0).toISOString(),
    config: { hatchMs: HATCH_MS, maxPopulation: 96, public: true },
    events,
  };
}

export default async function handler(
  req: VercelRequest,
  res: VercelResponse,
): Promise<void> {
  const world = worldKey(req.query['world']);

  if (req.method === 'GET') {
    const rows = await readDrawings(world);
    // A public world is read constantly and changes rarely. A short cache
    // with revalidation keeps a busy projection off the store without ever
    // showing a creature that was removed minutes ago.
    res.setHeader('cache-control', 'public, s-maxage=10, stale-while-revalidate=60');
    res.status(200).json(asSessionLog(world, rows));
    return;
  }

  if (req.method !== 'POST') {
    res.setHeader('allow', 'GET, POST');
    res.status(405).json({ error: 'method not allowed' });
    return;
  }

  if (!hasStore()) {
    // Explicit, because the alternative is a page that appears to work and
    // quietly forgets every drawing.
    res.status(503).json({ error: 'no store configured for this deployment' });
    return;
  }

  const body = readBody(req);
  const id = typeof body?.['id'] === 'string' ? (body['id'] as string).slice(0, 64) : '';
  const rawName = typeof body?.['name'] === 'string' ? (body['name'] as string) : '';
  const strokes = Array.isArray(body?.['strokes']) ? (body['strokes'] as unknown[]) : null;

  if (!id || !strokes || strokes.length === 0) {
    res.status(400).json({ error: 'need id and strokes' });
    return;
  }
  if (strokes.length > MAX_BODY_STROKES) {
    res.status(413).json({ error: 'too many strokes' });
    return;
  }
  for (const s of strokes) {
    const pts = (s as { pts?: unknown })?.pts;
    if (!Array.isArray(pts) || pts.length > MAX_POINTS_PER_STROKE) {
      res.status(413).json({ error: 'stroke too long' });
      return;
    }
  }

  // One creature per handset. Checked before the screen so a second attempt
  // costs nothing, and reported plainly — this is a rule, not a refusal.
  const already = await deviceDrawing(world, id);
  if (already !== null) {
    res.status(409).json({ error: 'this device already has a creature', id: already });
    return;
  }

  const pure = feedDrawingToStrokes({ strokes: strokes as never });
  if (pure.length === 0) {
    res.status(400).json({ error: 'no usable ink' });
    return;
  }
  const screened = screenDrawing(pure);

  const record: StoredDrawing = {
    id,
    name: rawName.replace(/[<>&"]/g, '').trim().slice(0, 16) || null,
    strokes,
    ts: Date.now(),
    disposition:
      screened.verdict === 'refuse' ? 'refused' : screened.verdict === 'hold' ? 'held' : 'admitted',
    verdict: screened.verdict,
    reason: screened.reason,
  };

  const written = await addDrawing(world, record);
  if (!written.ok) {
    res.status(written.reason === 'this device already drew' ? 409 : 500).json({
      error: written.reason ?? 'could not store',
    });
    return;
  }

  // The drawer learns only whether their creature is coming. `held` reads as
  // waiting, exactly as it does in the room: a drawing a person will decide
  // on must not be told it was flagged.
  res.status(201).json({
    id,
    status: record.disposition === 'refused' ? 'refused' : 'accepted',
  });
}
