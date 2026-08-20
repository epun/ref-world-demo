/**
 * Generate public/device/shell.svg.
 *
 * The first version was authored by hand and had three containment faults
 * (bezel wider than the body, motifs inside the screen well, button rings
 * straddling the body edge). Generating it means containment is correct BY
 * CONSTRUCTION: the body's half-width is a function of y, and every other
 * part is placed by asking that function how much room there is.
 */
import { writeFileSync } from 'node:fs';

// ── the binding numbers (docs/DEVICE.md §3) ─────────────────────────────────
const VB = { w: 100, h: 168 };
const BEZEL = { x0: 11.4, x1: 89.0, y0: 33.8, y1: 128.0 }; // outer edge of the drawn bezel
const KEYS = { y: 145, xs: [30.5, 50, 70], r: 7.2 };
const WORDMARK_Y = 24.6;

/** Deterministic wobble — a fixed seed, so the device is the same object for
 * everyone. No Math.random: this file must regenerate byte-identically. */
let seed = 20260818;
const rnd = () => {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
  return seed / 4294967296 - 0.5;
};

/**
 * The body's half-width as a function of y. Every clearance below is checked
 * against this, so the body cannot end up narrower than what it must contain.
 * Not an ellipse — an organic form that is widest through the screen and
 * tapers at both ends (TASTE §2.5: no rectilinear, no engineered geometry).
 */
const PROFILE = [
  [8, 14], [14, 24], [20, 33], [27, 40.5], [34, 44.6], [46, 46.6],
  [66, 47.6], [90, 48], [112, 47.6], [126, 46.4], [136, 44], [147, 39.5],
  [156, 33], [162, 24], [166, 13],
];
function halfWidth(y) {
  if (y <= PROFILE[0][0]) return PROFILE[0][1];
  if (y >= PROFILE[PROFILE.length - 1][0]) return PROFILE[PROFILE.length - 1][1];
  for (let i = 1; i < PROFILE.length; i++) {
    const [y1, w1] = PROFILE[i];
    if (y <= y1) {
      const [y0, w0] = PROFILE[i - 1];
      // smoothstep between control points so there are no corners
      const t = (y - y0) / (y1 - y0);
      const s = t * t * (3 - 2 * t);
      return w0 + (w1 - w0) * s;
    }
  }
  return 0;
}

// ── clearance checks: fail loudly rather than shipping a bad shape ──────────
const problems = [];
function needs(label, y, halfSpan, minMargin) {
  const have = halfWidth(y) - halfSpan;
  if (have < minMargin) {
    problems.push(`${label} at y=${y}: ${have.toFixed(2)} units of body, need ${minMargin}`);
  }
  return have;
}
const bezelHalf = Math.max(50 - BEZEL.x0, BEZEL.x1 - 50);
const marginTop = needs('bezel top', BEZEL.y0, bezelHalf, 5);
const marginBottom = needs('bezel bottom', BEZEL.y1, bezelHalf, 5);
const marginMid = needs('bezel middle', (BEZEL.y0 + BEZEL.y1) / 2, bezelHalf, 5);
const keyHalf = Math.max(...KEYS.xs.map((x) => Math.abs(x - 50))) + KEYS.r;
needs('key row', KEYS.y, keyHalf, 4);
if (problems.length) {
  console.error('GEOMETRY FAILS:\n  ' + problems.join('\n  '));
  process.exit(1);
}

// ── path builders ───────────────────────────────────────────────────────────
const n = (v) => (Math.round(v * 100) / 100).toString();

/** Closed body contour, sampled off the profile with a little pen wobble. */
function bodyPath(wobble = 0.55) {
  const pts = [];
  const STEPS = 26;
  for (let i = 0; i <= STEPS; i++) {
    const y = 8 + (166 - 8) * (i / STEPS);
    // right side runs a touch fuller, left a touch flatter — hand asymmetry
    const lean = 1 + 0.028 * Math.sin((y - 8) / 158 * Math.PI);
    pts.push([50 + halfWidth(y) * lean + rnd() * wobble, y + rnd() * wobble * 0.6]);
  }
  for (let i = STEPS; i >= 0; i--) {
    const y = 8 + (166 - 8) * (i / STEPS);
    const lean = 1 - 0.022 * Math.sin((y - 8) / 158 * Math.PI);
    pts.push([50 - halfWidth(y) * lean + rnd() * wobble, y + rnd() * wobble * 0.6]);
  }
  return closedSmooth(pts);
}

/** Catmull-Rom → cubic bezier, closed. Gives soft edges with no corners. */
function closedSmooth(pts) {
  const N = pts.length;
  const at = (i) => pts[((i % N) + N) % N];
  let d = `M${n(at(0)[0])} ${n(at(0)[1])}`;
  for (let i = 0; i < N; i++) {
    const p0 = at(i - 1), p1 = at(i), p2 = at(i + 1), p3 = at(i + 2);
    const c1 = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6];
    const c2 = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
    d += `C${n(c1[0])} ${n(c1[1])} ${n(c2[0])} ${n(c2[1])} ${n(p2[0])} ${n(p2[1])}`;
  }
  return d + 'z';
}

/** The bezel: a bowed, unequal-cornered frame. Never a rectangle. */
function bezelPath(inset = 0, wobble = 0.4) {
  const x0 = BEZEL.x0 + inset, x1 = BEZEL.x1 - inset;
  const y0 = BEZEL.y0 + inset, y1 = BEZEL.y1 - inset;
  const pts = [];
  // corners eat 34% of the shorter side — this is a soft lozenge, not a rect
  const R = Math.min(x1 - x0, y1 - y0) * 0.34;
  const corner = (cx, cy, a0, a1, steps, rx, ry) => {
    for (let i = 0; i < steps; i++) {
      const a = a0 + (a1 - a0) * (i / steps);
      pts.push([cx + Math.cos(a) * rx + rnd() * wobble, cy + Math.sin(a) * ry + rnd() * wobble]);
    }
  };
  const edge = (ax, ay, bx, by, steps, bow) => {
    for (let i = 0; i < steps; i++) {
      const t = i / steps;
      const nx = -(by - ay), ny = bx - ax;
      const len = Math.hypot(nx, ny) || 1;
      const b = Math.sin(t * Math.PI) * bow;
      pts.push([
        ax + (bx - ax) * t + (nx / len) * b + rnd() * wobble,
        ay + (by - ay) * t + (ny / len) * b + rnd() * wobble,
      ]);
    }
  };
  // each edge bows a different amount — a frame that was drawn, not ruled
  // every corner a slightly different radius — drawn, not constructed
  const rA = R * 1.0, rB = R * 0.86, rC = R * 1.08, rD = R * 0.93;
  edge(x0 + rA, y0, x1 - rB, y0, 5, -0.8);
  corner(x1 - rB, y0 + rB, -Math.PI / 2, 0, 5, rB, rB);
  edge(x1, y0 + rB, x1, y1 - rC, 6, -0.6);
  corner(x1 - rC, y1 - rC, 0, Math.PI / 2, 5, rC, rC);
  edge(x1 - rC, y1, x0 + rD, y1, 5, -1.0);
  corner(x0 + rD, y1 - rD, Math.PI / 2, Math.PI, 5, rD, rD);
  edge(x0, y1 - rD, x0, y0 + rA, 6, -0.5);
  corner(x0 + rA, y0 + rA, Math.PI, Math.PI * 1.5, 5, rA, rA);
  return closedSmooth(pts);
}

function ring(cx, cy, r, wobble = 0.28) {
  const pts = [];
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2;
    const rr = r + rnd() * wobble;
    pts.push([cx + Math.cos(a) * rr, cy + Math.sin(a) * rr]);
  }
  return closedSmooth(pts);
}

// ── motifs live in the body margin, never over the screen ──────────────────
const bandY = [52, 74, 96, 116];
const motifs = [];
for (let i = 0; i < bandY.length; i++) {
  const y = bandY[i];
  const left = i % 2 === 0;
  // centre of the free band between the bezel edge and the body edge
  const inner = left ? BEZEL.x0 : BEZEL.x1;
  const outer = left ? 50 - halfWidth(y) : 50 + halfWidth(y);
  const cx = (inner + outer) / 2;
  const room = Math.abs(inner - outer);
  const r = Math.min(2.6, room / 2 - 1.1);
  if (r < 1.2) continue;
  motifs.push({ cx, cy: y, r: r * (i % 2 === 0 ? 1 : 0.72) });
}

function star(cx, cy, r) {
  // a four-point ink sparkle, drawn in one stroke
  return `M${n(cx - r)} ${n(cy)}c${n(r * 0.55)} ${n(-r * 0.12)} ${n(r * 0.88)} ${n(-r * 0.45)} ${n(r)} ${n(-r)}` +
    `c${n(r * 0.12)} ${n(r * 0.55)} ${n(r * 0.45)} ${n(r * 0.88)} ${n(r)} ${n(r)}` +
    `c${n(-r * 0.55)} ${n(r * 0.12)} ${n(-r * 0.88)} ${n(r * 0.45)} ${n(-r)} ${n(r)}` +
    `c${n(-r * 0.12)} ${n(-r * 0.55)} ${n(-r * 0.45)} ${n(-r * 0.88)} ${n(-r)} ${n(-r)}z`;
}
function curl(cx, cy, r) {
  return `M${n(cx + r)} ${n(cy)}a${n(r)} ${n(r)} 0 1 1 ${n(-r * 0.7)} ${n(-r * 0.72)}`;
}

// hatch ticks, also in the left margin band
const hatch = [];
for (let i = 0; i < 4; i++) {
  const y = 132 + i * 4.4;
  const outer = 50 - halfWidth(y);
  const inner = Math.min(BEZEL.x0, outer + 9);
  if (inner - outer < 3) continue;
  hatch.push([outer + 1.6, y, inner - 1.2, y + 2.6]);
}

// The glass: one flat hard-edged crescent following the bezel's top-left
// corner arc, inset so it never touches the frame. A reflection on curved
// plastic, cut sharp — no gradient (DEVICE §1e, TASTE §2.4).
const bezelR = Math.min(BEZEL.x1 - BEZEL.x0, BEZEL.y1 - BEZEL.y0) * 0.34;
const glassCx = BEZEL.x0 + bezelR;
const glassCy = BEZEL.y0 + bezelR;
function crescent(cx, cy, rOuter, rInner, a0, a1) {
  const pt = (r, a) => [n(cx + Math.cos(a) * r), n(cy + Math.sin(a) * r)];
  const steps = 14;
  let d = `M${pt(rOuter, a0)[0]} ${pt(rOuter, a0)[1]}`;
  for (let i = 1; i <= steps; i++) {
    const [x, y] = pt(rOuter, a0 + (a1 - a0) * (i / steps));
    d += `L${x} ${y}`;
  }
  for (let i = steps; i >= 0; i--) {
    const [x, y] = pt(rInner, a0 + (a1 - a0) * (i / steps));
    d += `L${x} ${y}`;
  }
  return d + 'z';
}
const glass = crescent(glassCx, glassCy, bezelR - 3.4, bezelR - 8.2, Math.PI * 1.02, Math.PI * 1.52);

const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${VB.w} ${VB.h}" width="${VB.w}" height="${VB.h}" role="img" aria-label="a hand drawn handheld creature device">
  <!--
    GENERATED — do not hand-edit. Source: scripts/gen-device-shell.mjs — regenerate with
    node scripts/gen-device-shell.mjs

    The device shell is a PROP in the illustrated world, not a ui panel.
    TASTE §4 bans filled panels and cards in the ui; GENERATOR's ink section
    describes every form in the world as a "light, paper-filled shape"
    carried by "rough, wobbly dark ink outlines". Built to that rule, the
    device belongs to the same world as the trees instead of sitting on top
    of it as chrome. docs/DEVICE.md §1d.

    Containment is correct by construction: the body's half-width is a
    function of y (PROFILE in the generator) and every other part is placed
    by asking that function how much room there is. Measured clearances —
    bezel top ${marginTop.toFixed(2)}, middle ${marginMid.toFixed(2)}, bottom ${marginBottom.toFixed(2)} units of body
    outside the frame on each side. Motifs and hatching sit in that margin,
    never over the screen.

    Black and white by user ruling. No gradients, no drop shadows, no
    rounding beyond the organic contour itself.

    Static by ruling (DEVICE §1a): nothing here moves. The screen's CONTENTS
    keep the world's motion; the object holding them does not.
  -->
  <g fill="none" stroke="#353534" stroke-linecap="round" stroke-linejoin="round">

    <!-- the lug: the nub a keyring would go through -->
    <path d="M44.8 11.6c-.7-3.5.6-7.1 3.5-8.4 3.2-1.5 7.1.4 8.2 3.7.5 1.6.4 3.3-.2 4.8" fill="#e9ebe9" stroke-width="1.5"/>
    <path d="M48.1 9.6c-.2-1.4.5-2.7 1.8-3 1.3-.4 2.8.5 3 2" stroke-width="1.1"/>

    <!-- the body: three passes of one pen, unequal weight, slightly apart -->
    <path d="${bodyPath(0.5)}" fill="#e9ebe9" stroke-width="2.1"/>
    <path d="${bodyPath(1.05)}" stroke-width="1.05" opacity="0.65"/>
    <path d="${bodyPath(1.5)}" stroke-width="0.6" opacity="0.4"/>
    <!-- a second pen pass that breaks rather than traces -->
    <path d="M${n(50 - halfWidth(30))} 30c-2.6 6.1-4 12.7-4.4 19.3" stroke-width="0.75" opacity="0.5"/>
    <path d="M${n(50 + halfWidth(134))} 134c-2.9 6.6-7.2 12.5-12.6 17.1" stroke-width="0.75" opacity="0.5"/>

    <!-- the screen well. bowed, unequal corners — never a rectangle. -->
    <path d="${bezelPath(0, 0.45)}" fill="#dfdfdf" stroke-width="3.1"/>
    <path d="${bezelPath(0, 0.95)}" stroke-width="1.2" opacity="0.5"/>
    <path d="${bezelPath(3.1, 0.5)}" stroke-width="0.8" opacity="0.4"/>

    <!-- the glass: ONE flat hard-edged highlight, no gradient (DEVICE §1e) -->
    <path d="${glass}" fill="#efecec" stroke="none" opacity="0.85"/>

    <!-- hatching on the lower-left shoulder: line density does the shading -->
    <g stroke-width="0.7" opacity="0.55">
${hatch.map(([x0, y0, x1, y1]) => `      <path d="M${n(x0)} ${n(y0)}c${n((x1 - x0) * 0.45)} ${n((y1 - y0) * 0.3)} ${n((x1 - x0) * 0.8)} ${n((y1 - y0) * 0.65)} ${n(x1 - x0)} ${n(y1 - y0)}"/>`).join('\n')}
    </g>
  </g>
</svg>
`;

writeFileSync('/home/user/ref-world-demo/public/device/shell.svg', svg);
console.log('clearances — bezel top %s mid %s bottom %s', marginTop.toFixed(2), marginMid.toFixed(2), marginBottom.toFixed(2));
console.log('key row body half-width %s vs needed %s', halfWidth(KEYS.y).toFixed(2), keyHalf.toFixed(2));
console.log('motifs %d, hatch %d', motifs.length, hatch.length);
