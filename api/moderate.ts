/**
 * The moderator's endpoint. One person, three verbs.
 *
 * GET  — everything in the world, including what is held and what was
 *        refused, with the screen's reason. The room's ghost panel shows
 *        this to an operator standing at the projection; a public world has
 *        no such person standing there, so it has to be reachable.
 * POST — set one drawing's disposition: admitted | held | refused.
 *
 * Gated on a shared secret in `x-moderator`. An unset secret REFUSES: a
 * moderation endpoint that opens itself when misconfigured is worse than
 * one that never works, and this is the exact endpoint where a
 * fail-open default would be discovered by the wrong person first.
 *
 * Refusal stays silent to the drawer. Nothing here notifies anyone, and
 * that is deliberate — TASTE's rule that the shared screen never rewards
 * the attempt applies to the api too.
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import {
  hasStore,
  isModerator,
  readConfig,
  readDrawings,
  setDisposition,
  worldKey,
  writeConfig,
  type StoredDrawing,
} from './_store.js';

const DISPOSITIONS: StoredDrawing['disposition'][] = ['admitted', 'held', 'refused'];

export default async function handler(
  req: VercelRequest,
  res: VercelResponse,
): Promise<void> {
  if (!isModerator(req.headers['x-moderator'])) {
    // 404, not 403: an endpoint that confirms it exists to an unauthorised
    // caller has told them something.
    res.status(404).json({ error: 'not found' });
    return;
  }
  if (!hasStore()) {
    res.status(503).json({ error: 'no store configured for this deployment' });
    return;
  }

  const world = worldKey(req.query['world']);

  if (req.method === 'GET') {
    const rows = await readDrawings(world);
    const config = await readConfig(world);
    res.setHeader('cache-control', 'no-store');
    res.status(200).json({
      world,
      config,
      counts: {
        admitted: rows.filter((r) => r.disposition === 'admitted').length,
        held: rows.filter((r) => r.disposition === 'held').length,
        refused: rows.filter((r) => r.disposition === 'refused').length,
      },
      // Strokes ride along ONLY for what needs deciding on. A moderator has
      // to see the drawing to judge it, and the held queue is small; sending
      // every admitted creature's strokes would make this megabytes on a
      // phone, for artwork nobody is being asked about.
      drawings: rows.map(({ strokes, ...rest }) =>
        rest.disposition === 'admitted'
          ? { ...rest, strokeCount: Array.isArray(strokes) ? strokes.length : 0 }
          : { ...rest, strokeCount: Array.isArray(strokes) ? strokes.length : 0, strokes },
      ),
    });
    return;
  }

  if (req.method !== 'POST') {
    res.setHeader('allow', 'GET, POST');
    res.status(405).json({ error: 'method not allowed' });
    return;
  }

  const body =
    typeof req.body === 'string'
      ? (JSON.parse(req.body) as Record<string, unknown>)
      : ((req.body ?? {}) as Record<string, unknown>);
  // Two shapes of POST: one rules on a drawing, one sets the world's own
  // switches. Both are the moderator's, so they share the gate above.
  if (body['closed'] !== undefined || body['ipPerHour'] !== undefined) {
    const next: { closed?: boolean; ipPerHour?: number } = {};
    if (body['closed'] !== undefined) next.closed = body['closed'] === true;
    if (typeof body['ipPerHour'] === 'number' && body['ipPerHour'] >= 0) {
      next.ipPerHour = Math.floor(body['ipPerHour']);
    }
    res.status(200).json({ world, config: await writeConfig(world, next) });
    return;
  }

  const id = typeof body['id'] === 'string' ? body['id'] : '';
  const disposition = body['disposition'] as StoredDrawing['disposition'];

  if (!id || !DISPOSITIONS.includes(disposition)) {
    res.status(400).json({ error: 'need id and a disposition', allowed: DISPOSITIONS });
    return;
  }

  const ok = await setDisposition(world, id, disposition);
  res.status(ok ? 200 : 404).json(ok ? { id, disposition } : { error: 'no such drawing' });
}
