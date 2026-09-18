/**
 * The pile a creature is wearing.
 *
 * One `Group`, hung on the creature ROOT — never on `character.group`, and
 * that is the load-bearing detail in this file. The character's mesh is
 * deformed in a vertex shader from a handful of uniforms (docs/PLAN.md §3.5),
 * its group's local transform is rewritten every frame by the gait, and
 * anything parented under it would be squashed and bobbed along with the
 * body. The root is the two-level rig's stable half — it owns the world
 * position and nothing else writes it — so the pile hangs there, at local
 * `(0, baseR, 0)`, which is the middle of the creature.
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
  /** Its seat, in CLUMP-LOCAL space (`clumpLocalOffset`). */
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
  /*
   * THE CREATURE IS AT THE CENTRE OF THE MASS (user direction, 2026-09-18,
   * with a projection shot of a ball hanging over a creature's head:
   * *"currently the mass is sitting above the creature. We actually want to
   * have the creature in the center of the mass, and then the mass's outer
   * bounds be in contact with the floor of the landscape."*).
   *
   * So the pile's origin is the ROOT's own origin — not `baseR` above it,
   * which is what put the sphere over the creature's head. The items are
   * seated on a sphere of radius `bodyR` around the creature itself, and the
   * ground pass lifts the root by that radius so the sphere's underside rests
   * on the paper (`groundClearance`, src/creatures/manager.ts). Between them
   * the creature is inside its own ball, at the middle, with the ball on the
   * ground — which is the reference and the screenshot's ask.
   */
  group.position.set(0, 0, 0);
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
      items.set(item.key, item);
      const from = item.from ?? item.offset;
      const config = { settleMs: MOTION.secondaryMs };
      const entry: Entry = {
        item,
        x: new Spring(from.x, config),
        y: new Spring(from.y, config),
        z: new Spring(from.z, config),
      };
      entry.x.retarget(item.offset.x);
      entry.y.retarget(item.offset.y);
      entry.z.retarget(item.offset.z);
      entries.set(item.key, entry);
      item.object.position.set(from.x, from.y, from.z);
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

    outermost(): StuckItem | undefined {
      let best: StuckItem | undefined;
      let bestD = -1;
      for (const item of items.values()) {
        const o = item.offset;
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
      for (const entry of entries.values()) {
        // Nothing fully arrests (TASTE §3): the springs keep running after
        // they have settled, which is the ambient floor rather than a freeze.
        entry.item.object.position.set(
          entry.x.update(dtMs),
          entry.y.update(dtMs),
          entry.z.update(dtMs),
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
