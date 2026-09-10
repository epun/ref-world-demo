/**
 * The world's own ground, kept.
 *
 * 2026-09-09, the demo plan: *"update the url without resetting the scene and
 * losing everyone's eggs… then I'll start painting and manipulating the
 * scene."* The eggs already survive a redeploy — the drawings are in the
 * store and come back grown (docs/PUBLIC.md). The scene did not: the
 * landscape switch, the terrain dials and every dab of the brush lived in the
 * page that made them. This is where they live now.
 *
 * GET  — every scene change this world has kept, oldest first. NO AUTH, on
 *        purpose: the scene is what everyone standing in the world is already
 *        looking at, and a phone has to be able to read it before it can draw
 *        the ground its creature is walking on. Refusing it would only mean a
 *        room where the projection has hills and the handsets do not.
 * POST  — the moderator appends changes, or resets. Gated on the same shared
 *        secret as api/moderate.ts and 404 without it, for the same reason:
 *        an endpoint that confirms it exists to an unauthorised caller has
 *        told them something. Writing here re-shapes the world for everybody,
 *        which is exactly the operator's job and nobody else's.
 *
 * Every event goes through `readSceneEvent` on the way in and on the way out
 * (src/session/scene.ts): it clamps, so nothing stored here can hand a world
 * a brush the size of the map, whatever wrote it.
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import {
  MAX_SCENE_BATCH,
  readSceneEvent,
  type SceneEvent,
} from '../src/session/scene.js';
import {
  appendScene,
  clearScene,
  hasStore,
  isModerator,
  readScene,
  worldKey,
} from './_store.js';

export default async function handler(
  req: VercelRequest,
  res: VercelResponse,
): Promise<void> {
  const world = worldKey(req.query['world']);

  if (req.method === 'GET') {
    const events = await readScene(world);
    // never cached: a scene one poll behind is a room where the ground moved
    // and one screen did not.
    res.setHeader('cache-control', 'no-store');
    res.status(200).json({
      world,
      store: hasStore() ? 'live' : 'none',
      count: events.length,
      events,
    });
    return;
  }

  if (req.method !== 'POST') {
    res.setHeader('allow', 'GET, POST');
    res.status(405).json({ error: 'method not allowed' });
    return;
  }

  if (!isModerator(req.headers['x-moderator'])) {
    res.status(404).json({ error: 'not found' });
    return;
  }
  if (!hasStore()) {
    res.status(503).json({ error: 'no store configured for this deployment' });
    return;
  }

  const body =
    typeof req.body === 'string'
      ? (JSON.parse(req.body) as Record<string, unknown>)
      : ((req.body ?? {}) as Record<string, unknown>);

  if (body['reset'] === true) {
    await clearScene(world);
    res.status(200).json({ world, count: 0 });
    return;
  }

  const raw = body['events'];
  if (!Array.isArray(raw)) {
    res.status(400).json({ error: 'need events or reset' });
    return;
  }
  if (raw.length > MAX_SCENE_BATCH) {
    res.status(413).json({ error: 'too many events in one write', max: MAX_SCENE_BATCH });
    return;
  }

  const events: SceneEvent[] = [];
  for (const value of raw) {
    const event = readSceneEvent(value);
    if (event) events.push(event);
  }
  // A batch where nothing read is not a partial write, it is a caller talking
  // a language this world does not — say so rather than answering 200 to a
  // write that stored nothing.
  if (events.length === 0) {
    res.status(400).json({ error: 'no readable scene events' });
    return;
  }

  const written = await appendScene(world, events);
  if (!written.ok) {
    res.status(500).json({ error: written.reason ?? 'could not store' });
    return;
  }
  res.status(200).json({ world, count: written.count, wrote: events.length });
}
