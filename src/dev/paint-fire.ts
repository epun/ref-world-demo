/**
 * The fire brush's DRIVER — the one stateful thing between the painted layers
 * and the world (2026-09-10, user ask: *"the brushes should have real world
 * physics as well just in the style of ref world"*).
 *
 * It holds three things and no model at all:
 *
 *   - `fireAt`, one session-ms per texel: WHEN the brush lit that texel. This
 *     is the whole reason every screen agrees without a clock of its own — the
 *     stamp's own `t` is recorded in the session event, so a phone that joins
 *     late replays the same number and computes the same fire (docs/SESSION.md
 *     §paint, src/world/fire.ts).
 *   - the scorch texture the ground reads, uploaded when it moves.
 *   - a throttle, so the pure `burnState` runs a few times a second rather
 *     than per frame.
 *
 * Everything that decides anything is in `src/world/fire.ts` and is pure.
 * This module is a cache and a clock, which is why it lives in `src/dev/`
 * with the rest of the brush and leaves the demo build with it.
 */

import { DataTexture, RedFormat, type Texture } from 'three';
import { MOTION } from '../taste/tokens';
import { burnState, FIRE_MIN, type BurnField } from '../world/fire';
import type { PaintedFire } from '../world/landscape';

/**
 * [D] Shortest gap between two evaluations of the fire field, ms — about
 * four a second (`t.tertiary` halved).
 *
 * The field is a Dijkstra over the painted fuel texels and a pass over the
 * layer, so it is cheap but not free, and nothing in it moves faster than the
 * front: at `SPREAD_TEXELS_PER_S` a texel takes the better part of a second
 * to catch, so re-asking more often than this would return the same answer.
 * The marks are only re-rolled when the burning SET changes, which is rarer
 * still.
 */
export const FIRE_TICK_MS = MOTION.tertiaryMs / 2;

export interface FireDriverOptions {
  /** The fire brush's weight layer — the paint layer's own buffer. */
  fire: Float32Array;
  /** The grass brush's weight layer. The fuel, and the same deal. */
  grass: Float32Array;
  /** Texels a side for both. */
  res: number;
  /** World units the layers span, centred on the origin. */
  size: number;
  /** Session-ms now: the clock `fireAt` and the recorded stamps are in. */
  sessionNowMs(): number;
  /** The world's live wind heading at a session time, radians. */
  windAzimuth(sessionMs: number): number;
  /** Called when the set of burning texels has CHANGED and the scatter marks
   * have to be re-rolled. Never called for a change that only moves the
   * envelope inside a texel that was already alight. */
  onBurningChanged(): void;
}

export interface FireDriver {
  /** The fire at a world point — the sampler `setPaintedFire` installs. */
  sampler(x: number, z: number): PaintedFire;
  /** The scorch texture the ground inks itself from. */
  texture: Texture;
  /**
   * Record when a dab lit its texels.
   *
   * Called after the layer has been stamped, over the rect the stamp touched:
   * a texel that has just come alight takes `tMs`, and one the eraser took
   * back below the threshold forgets its time entirely. A texel that was
   * ALREADY alight keeps the time it had — re-painting over a burning patch
   * must not restart it, or a held brush would keep a fire alight for ever.
   */
  noteStamp(rect: { x0: number; y0: number; x1: number; y1: number } | null, tMs: number): void;
  /** Everything unlit and unburnt — what `clear map` means for this layer. */
  clear(): void;
  /** Re-evaluate on the throttle. Called from the world frame. */
  update(): void;
  dispose(): void;
}

export function createFireDriver(opts: FireDriverOptions): FireDriver {
  const { fire, grass, res, size } = opts;
  const count = res * res;
  const fireAt = new Float32Array(count);
  /** The scorch the ground reads: one byte a texel, the same square. */
  const bytes = new Uint8Array(count);
  const texture = new DataTexture(bytes, res, res, RedFormat);
  texture.name = 'layer:scorch';
  texture.flipY = false;
  texture.needsUpdate = true;

  let field: BurnField | null = null;
  let lastTickMs = -Infinity;
  /** Membership hash of the burning set — what `onBurningChanged` watches. */
  let burningKey = 0;

  const evaluate = (nowMs: number): void => {
    const next = burnState({
      fire,
      fireAt,
      grass,
      res,
      nowMs,
      windAzimuth: opts.windAzimuth(nowMs),
    });
    let key = 0;
    for (let i = 0; i < count; i++) {
      // Membership only: the envelope rising inside a texel that is already
      // alight is not a reason to re-roll thousands of instances.
      if ((next.burning[i] as number) > 0) key = (key * 31 + i + 1) | 0;
      const s = next.scorch[i] as number;
      bytes[i] = s <= 0 ? 0 : s >= 1 ? 255 : Math.round(s * 255);
    }
    texture.needsUpdate = true;
    field = next;
    if (key !== burningKey) {
      burningKey = key;
      opts.onBurningChanged();
    }
  };

  /** Bilinear read of one of the field's arrays — the same texel-centre
   * recipe (and the same exactly-0-outside rule) as every other painted
   * sampler in this world. */
  const read = (data: Float32Array, x: number, z: number): number => {
    const u = x / size + 0.5;
    const v = z / size + 0.5;
    if (u < 0 || u > 1 || v < 0 || v > 1) return 0;
    const fx = u * res - 0.5;
    const fy = v * res - 0.5;
    const x0 = Math.floor(fx);
    const y0 = Math.floor(fy);
    const tx = fx - x0;
    const ty = fy - y0;
    const at = (tex: number, tey: number): number => {
      if (tex < 0 || tex >= res || tey < 0 || tey >= res) return 0;
      return data[tey * res + tex] ?? 0;
    };
    const top = at(x0, y0) + (at(x0 + 1, y0) - at(x0, y0)) * tx;
    const bot = at(x0, y0 + 1) + (at(x0 + 1, y0 + 1) - at(x0, y0 + 1)) * tx;
    return top + (bot - top) * ty;
  };

  return {
    texture,
    sampler: (x: number, z: number): PaintedFire => {
      if (!field) return { burning: 0, scorch: 0 };
      return { burning: read(field.burning, x, z), scorch: read(field.scorch, x, z) };
    },
    noteStamp: (rect, tMs): void => {
      if (!rect) return;
      for (let y = rect.y0; y <= rect.y1; y++) {
        if (y < 0 || y >= res) continue;
        const row = y * res;
        for (let x = rect.x0; x <= rect.x1; x++) {
          if (x < 0 || x >= res) continue;
          const i = row + x;
          const lit = (fire[i] ?? 0) > FIRE_MIN;
          if (!lit) fireAt[i] = 0;
          else if (fireAt[i] === 0) fireAt[i] = tMs;
        }
      }
      // A new source is the one change worth answering immediately: an
      // operator who paints fire and watches nothing happen for a quarter of a
      // second has been told the tool is broken.
      lastTickMs = -Infinity;
    },
    clear: (): void => {
      fireAt.fill(0);
      bytes.fill(0);
      texture.needsUpdate = true;
      field = null;
      lastTickMs = -Infinity;
      if (burningKey !== 0) {
        burningKey = 0;
        opts.onBurningChanged();
      }
    },
    update: (): void => {
      const now = opts.sessionNowMs();
      // Nothing painted, nothing evaluated: an unlit world costs one compare
      // a frame. `field` stays null and the sampler answers zero.
      if (field === null && !hasSource(fire)) return;
      if (now - lastTickMs < FIRE_TICK_MS) return;
      lastTickMs = now;
      evaluate(now);
      // Out, and every texel already scorched: stop re-evaluating until
      // something is painted again. The scorch that is left is in the texture
      // and in `field`, so nothing on screen changes.
      if (field && !field.active) lastTickMs = Infinity;
    },
    dispose: (): void => {
      texture.dispose();
    },
  };
}

/** Is anything at all painted into the fire layer? */
function hasSource(fire: Float32Array): boolean {
  for (let i = 0; i < fire.length; i++) if ((fire[i] as number) > FIRE_MIN) return true;
  return false;
}
