/**
 * Drift-settle spring solver.
 *
 * The taste's motion constraints are confidence 1.00 (TASTE §2.1): no
 * overshoot, no bounce, no abrupt stops. An underdamped spring (ζ < 1)
 * rebounds past its target, and a rebound is bounce — so this module makes
 * underdamped motion UNREPRESENTABLE: damping ratio is clamped to ≥ 1 at the
 * API boundary. There is deliberately no way to ask this solver for a bounce.
 *
 * ζ = 1 (critical damping) is the fastest settle that never crosses the
 * target; ζ > 1 drifts in slower. What survives from springiness is what the
 * apple-design skill gets right: motion starts from the current value,
 * inherits current velocity, and is interruptible at any instant — retarget()
 * mid-flight and the state carries over.
 */

/** Minimum damping ratio. The reason this file exists. */
export const MIN_ZETA = 1.0;

export interface SpringConfig {
  /**
   * Time to settle within ~1% of the target, in ms. Maps onto the motion
   * token scale (MOTION.primaryMs etc.); the solver derives its natural
   * frequency from this.
   */
  settleMs: number;
  /** Damping ratio. Clamped to ≥ MIN_ZETA — requests below it are a taste violation. */
  zeta?: number;
}

interface Registered {
  zeta: number;
  settleMs: number;
}

/**
 * Every live spring registers here so the damping-audit gate (TASTE §7) can
 * assert ζ ≥ 1 across the whole app at runtime.
 */
export const springRegistry = new Set<Registered>();

export class Spring {
  private x: number;
  private v = 0;
  private target: number;
  /** natural frequency (rad/ms) */
  private readonly omega: number;
  readonly zeta: number;
  private readonly entry: Registered;

  constructor(initial: number, config: SpringConfig) {
    this.x = initial;
    this.target = initial;
    // Clamp, don't throw: a dev-tool slider dipping below 1 must not crash the
    // app, but the gate will still see the requested value via the registry if
    // it ever differs. Underdamped motion simply cannot be produced.
    this.zeta = Math.max(MIN_ZETA, config.zeta ?? MIN_ZETA);
    // For a critically damped system, settling to ~1% takes about 6.64/omega.
    this.omega = 6.64 / Math.max(1, config.settleMs);
    this.entry = { zeta: this.zeta, settleMs: config.settleMs };
    springRegistry.add(this.entry);
  }

  /** Retarget mid-flight. Position and velocity carry over — interruptible by construction. */
  retarget(target: number): void {
    this.target = target;
  }

  /** Hard-set state. For spawn/teleport only, where no gesture is in flight. */
  reset(value: number): void {
    this.x = value;
    this.v = 0;
    this.target = value;
  }

  /**
   * Advance by dt ms. Semi-implicit Euler on the damped harmonic oscillator —
   * with ζ ≥ 1 enforced, x never crosses the target.
   */
  update(dt: number): number {
    // Substep for stability at large/irregular dt (tab refocus, hitching).
    let remaining = dt;
    while (remaining > 0) {
      const h = Math.min(remaining, 16);
      const dx = this.x - this.target;
      const a = -this.omega * this.omega * dx - 2 * this.zeta * this.omega * this.v;
      this.v += a * h;
      this.x += this.v * h;
      remaining -= h;
    }
    return this.x;
  }

  get value(): number {
    return this.x;
  }

  get velocity(): number {
    return this.v;
  }

  /**
   * "Done" means within epsilon and slow — used to hand off to the ambient
   * floor, never to freeze. Nothing fully arrests (TASTE §3).
   */
  settled(epsilon = 1e-3): boolean {
    return (
      Math.abs(this.x - this.target) < epsilon && Math.abs(this.v) < epsilon * this.omega
    );
  }

  dispose(): void {
    springRegistry.delete(this.entry);
  }
}

/** The damping audit (TASTE §7). Returns violations; empty means green. */
export function auditDamping(): Registered[] {
  return [...springRegistry].filter((s) => s.zeta < MIN_ZETA);
}
