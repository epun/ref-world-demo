/**
 * The pile a creature is wearing.
 *
 * One `Group`, hung on the creature ROOT — never on `character.group`, and
 * that is the load-bearing detail in this file. The character's mesh is
 * deformed in a vertex shader from a handful of uniforms (docs/PLAN.md §3.5),
 * its group's local transform is rewritten every frame by the gait, and
 * anything parented under it would be squashed and bobbed along with the
 * body. The root is the two-level rig's stable half — it owns the world
 * position and nothing else writes it — so the pile hangs there, at the
 * middle of the CREATURE: local `(0, baseR / growth, 0)`, which is `baseR`
 * in the world at every pile size, because the root's uniform scale is the
 * growth and the creature is drawn at its own size inside it. It was a flat
 * `baseR` — `bodyR` in the world — while the pile was a sphere of radius
 * `bodyR` with the root as its underside; with the items packed onto the
 * character instead (2026-09-17) that put the whole mass a grown radius up in
 * the air, which is the floating the packing exists to end.
 *
 * WHAT THE CLUMP OWNS: where each stuck thing sits, at what rotation, how
 * far the pile has rolled, and how big the accumulated volume has made its
 * carrier. WHAT IT DOES NOT: deciding that anything sticks (that is
 * `src/creatures/sticky.ts`, and only on the page that simulates), moving the
 * creature, or knowing what a rapier body is.
 *
 * THE PILE ROLLS. A creature carrying stones is a ball with stones in it, and
 * a ball that slid across the field without turning would read as a decal. So
 * the group accumulates a world rotation from the carrier's own resolved
 * displacement at the no-slip rate (`rollAxis`/`rollDelta`) — arc length over
 * radius, which means a bigger pile turns more slowly for the same distance,
 * exactly as a bigger ball does.
 *
 * THE SEATS ARE HELD IN WORLD UNITS *(2026-09-17, user direction: "the
 * character should be the object that the items stick to")*. An item's seat
 * arrives clump-local — that is what the `stick` event carries — but the pile
 * is PACKED now (`packSeatDistance`, src/creatures/sticky.ts): each thing
 * rests against the character and against its neighbours, at its own size.
 * Clump-local offsets ride the root's uniform scale, so holding them would
 * inflate the packing every time the growth rose and open a gap between every
 * pair of objects — the pile would loosen into the cloud that the drawn shell
 * used to hide. So the seat is converted ONCE, on arrival, using the growth
 * the pile had BEFORE the item joined it (the same number the deciding page
 * packed against), and the per-frame write divides the live growth back out.
 * The springs animate in world units for the same reason.
 */

import { Group, Quaternion, Vector3, type Object3D } from 'three';
import { Spring } from '../motion/spring';
import { MOTION } from '../taste/tokens';
import type { PropKind } from '../world/props';
import { growth as growthOf, rollAxis, rollDelta } from './sticky';

/** One thing stuck to a carrier. */
export interface StuckItem {
  /**
   * What it is, in the addressing the `stick`/`drop` events use: a placement
   * key (`rock:2:11.50:-8.25`), a dev-dropped rock (`spawn:3`), or another
   * creature (`creature:<id>`).
   */
  key: string;
  /** The thing itself. Re-parented into the clump group by `add`. */
  object: Object3D;
  /** Its footprint radius, which is what it contributes to the pile's growth
   * and what seats it on the surface. */
  r: number;
  /** Absent for a creature passenger, which is not a prop. */
  kind?: PropKind;
  /** Which variant of that kind, and the uniform scale it is drawn at. Both
   * absent for a passenger. Carried so a DROP can hand the thing back to the
   * world as the same object it was picked up as — the placement it came from
   * may have been rebuilt away by then, and the pile is the only thing that
   * still knows what it was. */
  variant?: number;
  scale?: number;
  /**
   * The WORLD scale the object should keep while it rides — a passenger's
   * own growth, read live, since it is not a prop and has no `scale`. Absent
   * for a prop, whose `scale` is the answer.
   */
  worldScale?: () => number;
  /**
   * Its seat, in CLUMP-LOCAL space (`clumpLocalOffset`) — the units the
   * `stick` event carries, which are world units divided by the growth the
   * pile had when the item arrived. `add` converts it to world once and the
   * frame divides the live growth back out (see the module header).
   */
  offset: { x: number; y: number; z: number };
  /** Its attitude there (`clumpLocalRotation`). A fallen tree keeps lying the
   * way it fell. */
  rotation: { x: number; y: number; z: number; w: number };
  /**
   * Where it slides IN from, clump-local. Normally the point it was actually
   * struck at, which is a little outside its seat.
   *
   * Entrances slide, they never pop (TASTE §2.1, confidence 1.00): there is
   * no `scale: 0 → 1` path in this project and a stone that appeared at full
   * size on a pile would be exactly the hard cut the motion law forbids.
   * Omitted means "already there" — which is what a viewer applying a
   * restored log wants, since nothing arrived, the world simply is like this.
   */
  from?: { x: number; y: number; z: number };
  /**
   * A nested volume source, for a passenger that is carrying its own pile.
   *
   * The transitive case, and the reason it is a callback rather than a
   * number: a creature riding on another creature goes on collecting, and
   * the carrier has to keep growing as its passenger does. The clump does
   * not know what a creature is — the manager hands it this.
   */
  nested?: () => readonly number[];
}

/** A live entry: the item plus the three springs sliding it into its seat. */
interface Entry {
  item: StuckItem;
  /** The seat in WORLD units — `offset × the growth on arrival` (see the
   * module header). What the springs chase, and what the packing of the next
   * item is measured against. */
  seat: { x: number; y: number; z: number };
  /**
   * One spring per axis. Three, not one — a slide is a translation in space
   * and the three components settle independently; every one of them is
   * ζ ≥ 1 by construction, so no axis can overshoot its seat.
   */
  x: Spring;
  y: Spring;
  z: Spring;
}

export interface Clump {
  /** Parent this to the creature root. Already offset to `(0, baseR, 0)`. */
  group: Group;
  /** How far the pile has rolled, in WORLD space — independent of which way
   * the creature happens to be facing, because a ball's roll is not. */
  worldQ: Quaternion;
  items: Map<string, StuckItem>;
  /** Every stuck thing's volume (`r³`), including a passenger's own pile. */
  volumes(): number[];
  /** Uniform scale the carrier should be drawn at (`sticky.growth`). */
  growth(): number;
  /** The pile's world radius: `baseR × growth()`. */
  R(): number;
  add(item: StuckItem): void;
  remove(key: string): StuckItem | undefined;
  /**
   * Roll by one frame's ground displacement.
   *
   * `blend` is how much of that travel turns into roll: the katamari's
   * walk→roll blend (docs/PLAN.md §7.6), 0 for a creature that is still
   * walking and 1 for a ball. It scales the ANGLE and not the travel, so the
   * axis is unchanged and a half-blended creature turns half as far for the
   * same distance rather than turning about a different point. Defaults to 1
   * — a caller that has no blend is a pile that simply rolls.
   */
  roll(dx: number, dz: number, blend?: number): void;
  /**
   * What is already on the pile, in WORLD units from its centre, with each
   * thing's own radius — the list `packSeatDistance` packs the next item
   * against (src/creatures/sticky.ts). A fresh array; the caller is the
   * deciding page's one pickup, not a frame.
   */
  seats(): { x: number; y: number; z: number; r: number }[];
  /**
   * HOW FAR THE DRAWN MASS REACHES from the pile's centre, world units — the
   * furthest `|seat| + itemR` over everything on it, and 0 for an empty pile.
   *
   * This is the pile's own silhouette, and it is NOT `bodyR`: `bodyR` is the
   * accumulated volume (the game's size — the readout, the pickup reach, the
   * resolve circle) while the packed pile is tighter than that and the two
   * drift apart as it grows. The frame's ground pass reads THIS, because what
   * has to rest on the paper is what a person can see (`groundClearance`,
   * src/creatures/manager.ts).
   *
   * One walk of the pile per creature per frame, which is the same walk
   * `volumes()` already does for the growth.
   */
  reach(): number;
  /**
   * THE PILE'S LOWEST POINT, in the CREATURE'S own frame — world units above
   * the creature's feet, so 0 is the paper it stands on and a negative answer
   * is mass below its feet. 0 for an empty pile.
   *
   * > User report, 2026-09-17: *"now the characters are floating. their origin
   * > should match the ground plane; they should not be floating in mid air."*
   *
   * This is what the ground pass sits the creature on, and the radial
   * `reach()` is NOT: the items pack along the directions they were struck
   * from, so a creature with three benches beside it and nothing under it has
   * a reach of several units and a lowest point at its own feet — sitting it
   * up by the reach held it in the air over the gap. A pile only lifts a
   * creature by what is genuinely UNDER it.
   */
  floor(): number;
  /**
   * …and HOW WIDE it is — the furthest `|seat.xz| + itemR`, world units from
   * the creature's axis. The footprint the ground under it is sampled over
   * (`groundClearance`), which is a horizontal question and so takes a
   * horizontal answer. 0 for an empty pile.
   */
  footprint(): number;
  /** …and ONE of them, by key: where that thing is sitting in world units
   * from the pile's centre. What the rigid-body stand-in reads, since the
   * collider has to be where the item is DRAWN. */
  seatOf(key: string): { x: number; y: number; z: number } | undefined;
  /** The thing furthest out, which is the one that gets knocked off. */
  outermost(): StuckItem | undefined;
  /** Advance the entrance slides. Not in any spec of the geometry — the
   * springs have to be ticked by somebody and the manager's loop is the only
   * clock in reach. */
  update(dtMs: number): void;
  dispose(): void;
}

export function createClump(baseR: number): Clump {
  const group = new Group();
  group.name = 'clump';
  // The creature's middle, in world units — rewritten every frame by `update`
  // as the growth moves (see the module header).
  group.position.set(0, baseR, 0);
  const worldQ = new Quaternion();
  const items = new Map<string, StuckItem>();
  const entries = new Map<string, Entry>();

  // Scratch. This runs per carrier per frame.
  const axis = new Vector3();
  const delta = new Quaternion();
  const inverseRoot = new Quaternion();

  const volumes = (): number[] => {
    const out: number[] = [];
    for (const item of items.values()) {
      out.push(item.r * item.r * item.r);
      if (item.nested) for (const v of item.nested()) out.push(v);
    }
    return out;
  };

  const growth = (): number => growthOf(baseR, volumes());
  const R = (): number => baseR * growth();
  /**
   * A STUCK THING KEEPS ITS OWN SIZE (user report, 2026-09-16: "some items
   * get larger after you pick them up in your ball"). The pile hangs on the
   * creature root and the root's uniform scale IS the growth (manager
   * `growPass`), so an object seated at its prop scale was drawn `growth`
   * times too big — a stone picked up by a ball at 1.5 arrived half again
   * its size, and everything on the pile swelled with every pickup after.
   * The seat offsets already divide by the growth (`clumpLocalOffset`); the
   * object's own scale has to as well. The body itself is the ball and
   * grows with the root; only what is STUCK to it is countered.
   */
  const localScaleOf = (it: StuckItem): number =>
    (it.worldScale?.() ?? it.scale ?? 1) / Math.max(1e-6, growth());
  const item = (entry: Entry): StuckItem => entry.item;

  return {
    group,
    worldQ,
    items,
    volumes,
    growth,
    R,

    add(item): void {
      // Re-seat, never duplicate: the same key arriving twice is a replayed
      // log or a resent batch, and the second one is the truth.
      const previous = entries.get(item.key);
      previous?.x.dispose();
      previous?.y.dispose();
      previous?.z.dispose();
      /*
       * THE GROWTH BEFORE THIS ITEM JOINED, which is the number the seat was
       * packed against: the deciding page computes the offset and only then
       * seats the item (src/creatures/manager.ts), so a viewer applying the
       * event has to read the same pre-arrival growth or the two pages would
       * place the same three floats a few centimetres apart. Read BEFORE the
       * insert below, and that ordering is the whole of it.
       */
      const arrived = growth();
      items.set(item.key, item);
      const from = item.from ?? item.offset;
      const config = { settleMs: MOTION.secondaryMs };
      const entry: Entry = {
        item,
        seat: {
          x: item.offset.x * arrived,
          y: item.offset.y * arrived,
          z: item.offset.z * arrived,
        },
        x: new Spring(from.x * arrived, config),
        y: new Spring(from.y * arrived, config),
        z: new Spring(from.z * arrived, config),
      };
      entry.x.retarget(entry.seat.x);
      entry.y.retarget(entry.seat.y);
      entry.z.retarget(entry.seat.z);
      entries.set(item.key, entry);
      // In world units, divided back out by the growth the pile is at NOW —
      // which is the one the root is scaled by this frame.
      const now = Math.max(1e-6, growth());
      item.object.position.set(
        (from.x * arrived) / now,
        (from.y * arrived) / now,
        (from.z * arrived) / now,
      );
      item.object.quaternion.set(
        item.rotation.x,
        item.rotation.y,
        item.rotation.z,
        item.rotation.w,
      );
      item.object.scale.setScalar(localScaleOf(item));
      group.add(item.object);
    },

    remove(key): StuckItem | undefined {
      const item = items.get(key);
      if (!item) return undefined;
      const entry = entries.get(key);
      entry?.x.dispose();
      entry?.y.dispose();
      entry?.z.dispose();
      entries.delete(key);
      items.delete(key);
      // The object is NOT detached here. Whoever is taking it wants it at its
      // world transform — `Object3D.attach` / `scene.attach` on the caller's
      // side is what preserves that, and it does the removal itself.
      return item;
    },

    roll(dx, dz, blend = 1): void {
      const unit = rollAxis(dx, dz);
      if (!unit) return;
      const scale = Math.min(1, Math.max(0, blend));
      const theta = rollDelta(Math.hypot(dx, dz), R()) * scale;
      if (!(Math.abs(theta) > 1e-9)) return;
      axis.set(unit.x, unit.y, unit.z);
      delta.setFromAxisAngle(axis, theta);
      // Pre-multiplied: this frame's turn happens in WORLD space, on top of
      // everywhere the pile has already rolled.
      worldQ.premultiply(delta);
      // And expressed under whichever way the creature is now facing, so the
      // roll survives the root turning underneath it.
      const root = group.parent;
      if (root) {
        inverseRoot.copy(root.quaternion).invert();
        group.quaternion.copy(inverseRoot).multiply(worldQ);
      } else {
        group.quaternion.copy(worldQ);
      }
    },

    seats(): { x: number; y: number; z: number; r: number }[] {
      const out: { x: number; y: number; z: number; r: number }[] = [];
      for (const entry of entries.values()) {
        out.push({ x: entry.seat.x, y: entry.seat.y, z: entry.seat.z, r: entry.item.r });
      }
      return out;
    },

    reach(): number {
      let far = 0;
      for (const entry of entries.values()) {
        const seat = entry.seat;
        const out = Math.hypot(seat.x, seat.y, seat.z) + entry.item.r;
        if (out > far) far = out;
      }
      return far;
    },

    floor(): number {
      let low = 0;
      for (const entry of entries.values()) {
        // The seat is measured from the pile's centre and the centre is
        // `baseR` above the creature's feet, so this is in the creature's
        // frame — which is the frame the ground pass writes in.
        const bottom = baseR + entry.seat.y - entry.item.r;
        if (bottom < low) low = bottom;
      }
      return low;
    },

    footprint(): number {
      let wide = 0;
      for (const entry of entries.values()) {
        const seat = entry.seat;
        const out = Math.hypot(seat.x, seat.z) + entry.item.r;
        if (out > wide) wide = out;
      }
      return wide;
    },

    seatOf(key): { x: number; y: number; z: number } | undefined {
      return entries.get(key)?.seat;
    },

    outermost(): StuckItem | undefined {
      let best: StuckItem | undefined;
      let bestD = -1;
      for (const item of items.values()) {
        const o = entries.get(item.key)?.seat ?? item.offset;
        const d = o.x * o.x + o.y * o.y + o.z * o.z;
        // Ties broken by insertion order — `Map` iterates in it, and `>`
        // keeps the first. Deterministic, so two pages agree.
        if (d > bestD) {
          bestD = d;
          best = item;
        }
      }
      return best;
    },

    update(dtMs): void {
      // One read a frame for the whole pile: the growth the root is scaled by,
      // which every seat below is divided by (see the module header).
      const now = Math.max(1e-6, growth());
      // …and the pile's own origin with it: the CREATURE's middle, `baseR` in
      // the world however big the pile has become.
      group.position.y = baseR / now;
      for (const entry of entries.values()) {
        // Nothing fully arrests (TASTE §3): the springs keep running after
        // they have settled, which is the ambient floor rather than a freeze.
        entry.item.object.position.set(
          entry.x.update(dtMs) / now,
          entry.y.update(dtMs) / now,
          entry.z.update(dtMs) / now,
        );
        // Every frame, not only at the seat: the growth is a spring, so the
        // root's scale is different on each frame of a pickup.
        entry.item.object.scale.setScalar(localScaleOf(item(entry)));
      }
    },

    dispose(): void {
      for (const entry of entries.values()) {
        entry.x.dispose();
        entry.y.dispose();
        entry.z.dispose();
      }
      entries.clear();
      items.clear();
      group.removeFromParent();
    },
  };
}
