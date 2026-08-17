/**
 * Per-creature behavior runtime (GENERATOR.md §Behavior).
 *
 * Glues the pure state machine (states.ts) and steering (steering.ts) to a
 * pair of ζ≥1 springs:
 *
 *   - heading spring (secondary settle) with shortest-way unwrap — turns
 *     take the short arc and drift into the new facing, never snap;
 *   - speed spring (primary settle) — starts and stops are long drifts.
 *     A stop is the spring settling toward zero, never a brake (abrupt stop
 *     is forbidden at confidence 1.00, TASTE §2.1).
 *
 * The agent outputs a velocity + heading each tick; it never touches the
 * scene graph. The manager applies vx/vz to the character root's x/z (never
 * world-space Y — the Surface seam belongs elsewhere) and heading to
 * rotation.y. Idle keeps the ambient floor alive through the character's own
 * drift; the agent contributes zero velocity, not a freeze.
 *
 * Movement is slow and measured: peak speed ~1.2 world units/s at energy 1.
 * Social behavior is subtle — notice within ~7 units, approach/follow gated
 * by personality, stop STAND_OFF short (never overlap), at most one sparse
 * emote per state entry.
 *
 * Deterministic: one seeded LCG stream drives every draw. No Math.random,
 * no Three.js.
 */

import { Spring } from '../motion/spring';
import type { EmoteName } from '../net/protocol';
import { MOTION } from '../taste/tokens';
import type { Personality } from './personality';
import {
  makeRand,
  nextState,
  NOTICE_RADIUS,
  type BehaviorContext,
  type BehaviorState,
  type StateChoice,
} from './states';
import {
  approachTarget,
  arrive,
  FOLLOW_STAND_OFF,
  headingTo,
  pickWanderTarget,
  quadrantOf,
  shortestDelta,
  STAND_OFF,
  type Vec2,
} from './steering';

/** Peak ground speed at energy 1, world units per second. Slow — the world
 * reads first, then you notice one creature moving. */
export const MAX_SPEED = 1.2;

/** A wander target closer than this counts as reached. */
const TARGET_REACHED = 0.6;

/** Tally the current quadrant into the visit map this often (ms). */
const VISIT_TALLY_MS = 2000;

/** During look-around, glance toward a new heading about once per ambient
 * period. */
const LOOK_GLANCE_MS = MOTION.ambientMs;

export interface AgentPeer extends Vec2 {
  id: string;
}

export interface AgentProp extends Vec2 {
  kind: string;
}

export interface AgentTick {
  /** Ground velocity, world units per second (caller integrates by dt). */
  vx: number;
  vz: number;
  /** Facing for rotation.y — already spring-smoothed. */
  heading: number;
  /** Sparse emote cue, present at most once per state entry. */
  emote?: EmoteName;
  /** Persistent posture: maps to expression on the character. */
  pose: 'sit' | 'sleep' | null;
}

export class BehaviorAgent {
  private readonly personality: Personality;
  private readonly rand: () => number;

  private state: BehaviorState = 'idle';
  private durationMs: number;
  private timeInState = 0;

  private readonly headingSpring: Spring;
  private readonly speedSpring: Spring;
  private speedMult = 1;

  private wanderTarget: Vec2 | null = null;
  private peerId: string | null = null;
  private pendingEmote: EmoteName | null = null;

  private readonly quadrantVisits: [number, number, number, number] = [0, 0, 0, 0];
  private visitAccum = 0;
  private lookAccum = 0;

  constructor(seed: number, personality: Personality) {
    this.personality = personality;
    this.rand = makeRand(seed);
    // First stretch of life is a settle-in idle with a seeded length.
    this.durationMs = (2 + 2 * this.rand()) * MOTION.ambientMs;
    this.headingSpring = new Spring(this.rand() * Math.PI * 2 - Math.PI, {
      settleMs: MOTION.secondaryMs,
    });
    this.speedSpring = new Spring(0, { settleMs: MOTION.primaryMs });
  }

  /** Demo-panel wander speed multiplier (scales desired speeds; the spring
   * keeps starts/stops as drifts at any setting). */
  setSpeedMultiplier(mult: number): void {
    this.speedMult = Math.max(0, mult);
  }

  get currentState(): BehaviorState {
    return this.state;
  }

  update(
    dt: number,
    _nowMs: number,
    self: Vec2,
    peers: readonly AgentPeer[],
    props: readonly AgentProp[] | null,
  ): AgentTick {
    this.timeInState += dt;

    // Visit accounting for the dispersal novelty bonus.
    this.visitAccum += dt;
    if (this.visitAccum >= VISIT_TALLY_MS) {
      this.visitAccum -= VISIT_TALLY_MS;
      this.quadrantVisits[quadrantOf(self)] += 1;
    }

    const context = this.contextOf(self, peers, props);
    if (this.timeInState >= this.durationMs) {
      this.enterState(nextState(this.state, this.personality, context, this.rand), self, peers);
    }

    // ── per-state desired steering ──────────────────────────────────────────
    let desiredSpeed = 0;
    let desiredHeading: number | null = null;
    const cruise =
      MAX_SPEED * (0.35 + 0.65 * this.personality.energy) * this.speedMult;

    switch (this.state) {
      case 'wander': {
        if (
          !this.wanderTarget ||
          Math.hypot(this.wanderTarget.x - self.x, this.wanderTarget.z - self.z) <
            TARGET_REACHED
        ) {
          this.wanderTarget = pickWanderTarget(
            self,
            peers,
            this.quadrantVisits,
            this.personality.energy,
            this.rand,
          );
        }
        const steer = arrive(self, this.wanderTarget, cruise, this.headingSpring.value);
        desiredSpeed = steer.speed;
        desiredHeading = steer.heading;
        break;
      }

      case 'approach':
      case 'follow': {
        const peer = this.resolvePeer(peers);
        if (!peer) {
          // Companion gone: let the state run out quietly.
          this.timeInState = this.durationMs;
          break;
        }
        const standOff = this.state === 'follow' ? FOLLOW_STAND_OFF : STAND_OFF;
        const gap = Math.hypot(peer.x - self.x, peer.z - self.z);
        // Face the companion; never push inside the stand-off.
        desiredHeading = headingTo(self, peer);
        if (gap > standOff) {
          const target = approachTarget(self, peer, standOff);
          const speedCap = this.state === 'approach' ? cruise * 0.85 : cruise;
          const steer = arrive(self, target, speedCap, this.headingSpring.value);
          desiredSpeed = steer.speed;
          desiredHeading = steer.heading;
        }
        break;
      }

      case 'observe': {
        const prop = nearest(self, props ?? []);
        if (prop) desiredHeading = headingTo(self, prop);
        break;
      }

      case 'look-around': {
        this.lookAccum += dt;
        if (this.lookAccum >= LOOK_GLANCE_MS) {
          this.lookAccum -= LOOK_GLANCE_MS;
          desiredHeading =
            this.headingSpring.value + (this.rand() * 2 - 1) * 1.1;
        }
        break;
      }

      default:
        // idle / sit / sleep: still. The character's ambient drift floor
        // keeps it alive; the agent asks for nothing.
        break;
    }

    // ── springs ─────────────────────────────────────────────────────────────
    this.speedSpring.retarget(desiredSpeed);
    if (desiredHeading !== null) this.retargetHeading(desiredHeading);

    const speed = Math.max(0, this.speedSpring.update(dt));
    const heading = this.headingSpring.update(dt);

    const tick: AgentTick = {
      vx: Math.sin(heading) * speed,
      vz: Math.cos(heading) * speed,
      heading,
      pose: this.state === 'sit' ? 'sit' : this.state === 'sleep' ? 'sleep' : null,
    };
    if (this.pendingEmote) {
      tick.emote = this.pendingEmote;
      this.pendingEmote = null;
    }
    return tick;
  }

  dispose(): void {
    this.headingSpring.dispose();
    this.speedSpring.dispose();
  }

  // ── internals ─────────────────────────────────────────────────────────────

  private contextOf(
    self: Vec2,
    peers: readonly AgentPeer[],
    props: readonly AgentProp[] | null,
  ): BehaviorContext {
    const peer = nearest(self, peers);
    const prop = props ? nearest(self, props) : null;
    return {
      nearestCreatureDist: peer
        ? Math.hypot(peer.x - self.x, peer.z - self.z)
        : Infinity,
      nearestPropDist: prop ? Math.hypot(prop.x - self.x, prop.z - self.z) : Infinity,
      timeInState: this.timeInState,
    };
  }

  private enterState(choice: StateChoice, self: Vec2, peers: readonly AgentPeer[]): void {
    this.state = choice.state;
    this.durationMs = choice.durationMs;
    this.timeInState = 0;
    this.lookAccum = 0;
    this.wanderTarget = null;

    if (choice.state === 'approach' || choice.state === 'follow') {
      const peer = nearest(self, peers, NOTICE_RADIUS);
      this.peerId = peer?.id ?? null;
    } else {
      this.peerId = null;
    }

    // Sparse emote cues — at most one per state entry, personality-gated.
    // Meeting someone can spark 'happy'; sleep is announced with 'sleepy'.
    const p = this.personality;
    switch (choice.state) {
      case 'approach':
        if (p.social > 0.55 && this.rand() < 0.35) this.pendingEmote = 'happy';
        break;
      case 'follow':
        if (p.playfulness > 0.6 && this.rand() < 0.25) this.pendingEmote = 'happy';
        break;
      case 'sleep':
        if (this.rand() < 0.75) this.pendingEmote = 'sleepy';
        break;
      case 'observe':
        if (p.curiosity > 0.7 && this.rand() < 0.2) this.pendingEmote = 'surprised';
        break;
      default:
        break;
    }
  }

  private resolvePeer(peers: readonly AgentPeer[]): AgentPeer | null {
    if (this.peerId) {
      for (const peer of peers) {
        if (peer.id === this.peerId) return peer;
      }
    }
    return null;
  }

  /** Shortest-way unwrap: retarget to the nearest angular representative of
   * the desired heading, so the spring never takes the long arc. */
  private retargetHeading(desired: number): void {
    const current = this.headingSpring.value;
    this.headingSpring.retarget(current + shortestDelta(current, desired));
  }
}

function nearest<T extends Vec2>(
  self: Vec2,
  items: readonly T[],
  within = Infinity,
): T | null {
  let best: T | null = null;
  let bestDist = within;
  for (const item of items) {
    const d = Math.hypot(item.x - self.x, item.z - self.z);
    if (d <= bestDist) {
      bestDist = d;
      best = item;
    }
  }
  return best;
}
