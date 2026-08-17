/**
 * The hatch sequence (PLAN §4).
 *
 * Two phases, one continuous motion — nothing cuts, nothing pops:
 *
 * 1. crack — the crack uniform springs to 1 over t.secondary while the
 *    wobble ramps to full. The egg keeps rocking; main.ts keeps updating it.
 * 2. exit — the shell splits into three slice geometries (cap + two lower
 *    halves) that inherit the egg's exact pose mid-wobble, then SLIDE apart
 *    and drift down/away while fading over t.primary (transparent material
 *    during exit only), and are disposed. The character rises from the egg
 *    position — scale 0.6→1 and a rise to rest, both on ζ≥1 springs over
 *    t.primary (scale-from-zero is forbidden). The one accent element on
 *    screen — a thin CHARACTER.accent ring — slides up from the hatch point
 *    and drifts out over t.primary (TASTE §6: at most one accent at a time).
 *
 * No particles, no flash, no texture swap. All durations from MOTION tokens;
 * every ease is a ζ≥1 Spring.
 */

import { Group, Mesh, MeshBasicMaterial, MeshPhysicalMaterial, TorusGeometry } from 'three';
import type { Scene } from 'three';
import type { Character } from '../character/character';
import { Spring } from '../motion/spring';
import { CHARACTER, MOTION } from '../taste/tokens';
import { applyCrackShader } from './crack';
import { buildShellGeometry, EGG_HEIGHT, type Egg, type ShellSlice } from './egg';

/** Where the character starts its rise from, relative to the ground. */
const RISE_FROM = -0.7;
/** Character entrance scale — never from zero (TASTE §2.1). */
const SCALE_FROM = 0.6;
/** Springs are asymptotic; past this fraction the exit is over. */
const SETTLE_EPS = 0.985;

const TAU = Math.PI * 2;
/** Polar angle where the cap breaks off the lower shell. */
const CAP_THETA = Math.PI * 0.45;

interface PieceSpec {
  slice: ShellSlice;
  /** Local slide target — outward and slightly down (drift down/away). */
  out: [number, number, number];
  /** Tilt target [rx, rz] as the piece slides. */
  tilt: [number, number];
}

const PIECE_SPECS: PieceSpec[] = [
  {
    slice: { phiStart: 0, phiLength: TAU, thetaStart: 0, thetaLength: CAP_THETA },
    out: [1.5, -0.35, 0.5],
    tilt: [0.35, -0.8],
  },
  {
    slice: {
      phiStart: 0,
      phiLength: Math.PI,
      thetaStart: CAP_THETA,
      thetaLength: Math.PI - CAP_THETA,
    },
    out: [0.25, -0.5, 1.7],
    tilt: [0.55, 0.1],
  },
  {
    slice: {
      phiStart: Math.PI,
      phiLength: Math.PI,
      thetaStart: CAP_THETA,
      thetaLength: Math.PI - CAP_THETA,
    },
    out: [-0.3, -0.5, -1.7],
    tilt: [-0.5, -0.15],
  },
];

export interface HatchCallbacks {
  /**
   * The shell has burst: the character (wrapped in `characterRoot`, which
   * owns the rise/scale entrance) is now in the scene. Ownership of the
   * root passes to the caller — add the character shadow, reframe the
   * camera, stop updating the egg.
   */
  onBurst(characterRoot: Group): void;
  /** Shell pieces and the accent have faded and been disposed. */
  onDone(): void;
}

export interface HatchHandle {
  /** Advance the sequence. Call once per frame while the handle lives. */
  update(dt: number, nowMs: number): void;
  /**
   * Tear down mid-flight (a redraw replaced the creature): removes and
   * disposes everything this sequence owns — shell pieces, accent, the
   * egg's resources. The character and its root belong to the caller.
   */
  dispose(): void;
}

interface Piece {
  mesh: Mesh;
  material: MeshPhysicalMaterial;
  spec: PieceSpec;
}

export function startHatch(
  scene: Scene,
  egg: Egg,
  character: Character,
  callbacks: HatchCallbacks,
): HatchHandle {
  let phase: 'crack' | 'exit' | 'done' = 'crack';

  // Phase 1 springs: pick up the crack and wobble wherever they are —
  // manual and timed hatches run the identical, continuous sequence.
  const crackSpring = new Spring(egg.crackValue(), { settleMs: MOTION.secondaryMs });
  crackSpring.retarget(1);
  const wobbleSpring = new Spring(egg.hatchProgress(), { settleMs: MOTION.secondaryMs });
  wobbleSpring.retarget(1);

  // Phase 2 springs, all 0→1 over t.primary. Separate solvers so the shell,
  // the accent, and the character each carry their own velocity.
  const pieceSpring = new Spring(0, { settleMs: MOTION.primaryMs });
  const ringSpring = new Spring(0, { settleMs: MOTION.primaryMs });
  const charSpring = new Spring(0, { settleMs: MOTION.primaryMs });

  let pieceRoot: Group | null = null;
  let pieces: Piece[] = [];
  let ring: Mesh | null = null;
  let ringMaterial: MeshBasicMaterial | null = null;
  let ringBaseY = 0;
  let ringX = 0;
  let ringZ = 0;
  let charRoot: Group | null = null;

  const allSprings = [crackSpring, wobbleSpring, pieceSpring, ringSpring, charSpring];

  function burst(): void {
    phase = 'exit';
    const pose = egg.group;

    // Shell pieces inherit the egg's exact mid-wobble pose — the swap is
    // invisible, then the pieces drift from there.
    pieceRoot = new Group();
    pieceRoot.position.copy(pose.position);
    pieceRoot.rotation.copy(pose.rotation);
    pieces = PIECE_SPECS.map((spec) => {
      const geometry = buildShellGeometry(egg.seed, spec.slice);
      const material = new MeshPhysicalMaterial({
        map: egg.texture,
        roughness: 0.4,
        metalness: 0,
        clearcoat: 0.6,
        clearcoatRoughness: 0.25,
        transparent: true,
        depthWrite: false,
      });
      // Same seed, same pattern, same compiled program: the cracks stay on
      // the departing shell instead of vanishing at the swap.
      applyCrackShader(material, egg.seed).setCrack(1);
      const mesh = new Mesh(geometry, material);
      mesh.renderOrder = 2;
      pieceRoot?.add(mesh);
      return { mesh, material, spec };
    });
    scene.remove(egg.group);
    scene.add(pieceRoot);

    // The one accent element: a thin ring sliding up from the hatch point.
    const point = egg.hatchPoint();
    ringX = point.x;
    ringZ = point.z;
    ringBaseY = point.y;
    const ringGeometry = new TorusGeometry(1.15, 0.03, 10, 72);
    ringGeometry.rotateX(Math.PI / 2);
    ringMaterial = new MeshBasicMaterial({
      color: CHARACTER.accent,
      transparent: true,
      depthWrite: false,
    });
    ring = new Mesh(ringGeometry, ringMaterial);
    ring.renderOrder = 3;
    ring.position.set(ringX, ringBaseY, ringZ);
    scene.add(ring);

    // The character rises from the egg position. The wrapper owns the
    // entrance so character.update() keeps owning its own group transform.
    charRoot = new Group();
    charRoot.position.set(pose.position.x, RISE_FROM, pose.position.z);
    charRoot.scale.setScalar(SCALE_FROM);
    charRoot.add(character.group);
    scene.add(charRoot);

    pieceSpring.retarget(1);
    ringSpring.retarget(1);
    charSpring.retarget(1);

    callbacks.onBurst(charRoot);
  }

  function disposePieces(): void {
    if (pieceRoot) {
      scene.remove(pieceRoot);
      for (const piece of pieces) {
        piece.mesh.geometry.dispose();
        piece.material.dispose();
      }
      pieces = [];
      pieceRoot = null;
    }
    if (ring) {
      scene.remove(ring);
      ring.geometry.dispose();
      ringMaterial?.dispose();
      ring = null;
      ringMaterial = null;
    }
  }

  function finish(): void {
    phase = 'done';
    disposePieces();
    egg.dispose();
    for (const spring of allSprings) spring.dispose();
    callbacks.onDone();
  }

  return {
    update(dt: number): void {
      if (phase === 'crack') {
        egg.crack(crackSpring.update(dt));
        egg.setHatchProgress(wobbleSpring.update(dt));
        if (crackSpring.value >= SETTLE_EPS) burst();
        return;
      }
      if (phase !== 'exit') return;

      const s = pieceSpring.update(dt);
      for (const piece of pieces) {
        const [ox, oy, oz] = piece.spec.out;
        piece.mesh.position.set(ox * s, oy * s, oz * s);
        const [rx, rz] = piece.spec.tilt;
        piece.mesh.rotation.set(rx * s, 0, rz * s);
        piece.material.opacity = 1 - s;
      }

      const r = ringSpring.update(dt);
      if (ring && ringMaterial) {
        ring.position.set(ringX, ringBaseY + r * (EGG_HEIGHT + 1.6 - ringBaseY), ringZ);
        const scale = 1 + 0.55 * r;
        ring.scale.set(scale, 1, scale);
        ringMaterial.opacity = 1 - r;
      }

      const c = charSpring.update(dt);
      if (charRoot) {
        charRoot.position.y = RISE_FROM * (1 - c);
        charRoot.scale.setScalar(SCALE_FROM + (1 - SCALE_FROM) * c);
      }

      if (s >= SETTLE_EPS && r >= SETTLE_EPS && c >= SETTLE_EPS) finish();
    },

    dispose(): void {
      if (phase === 'done') return;
      phase = 'done';
      disposePieces();
      egg.dispose();
      for (const spring of allSprings) spring.dispose();
    },
  };
}
