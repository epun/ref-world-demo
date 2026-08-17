# ref-world — build plan

An isometric WebGL world where a drawing you make on your phone becomes an egg, hatches,
and walks around as a character.

Everything here sits inside [`docs/TASTE.md`](./TASTE.md). Read that first — it is not
decoration, it drives real technical choices below.

---

## 1. The load-bearing insight

The taste is **flat single-color silhouettes with eyes as the only interior detail**.

A person drawing with a black brush on a white canvas is *already producing art in the
target style*. That collapses the hardest part of the brief.

So "infer a character from that drawing" does **not** need a generative 3D model in the
critical path. It needs a **silhouette-inflation pipeline**: take the drawn shape, puff it
into a rounded volume, find its extremities, and drive it procedurally.

Consequences, all good:

- **Head-on, the character is pixel-exact the user's drawing.** No "the AI changed my
  drawing" disappointment — the single worst failure mode of this kind of demo.
- Runs **on-device in well under a second**. No API round-trip between "done drawing" and
  "egg appears".
- **Deterministic and testable.** The pipeline is pure functions over a bitmap.
- **Free.** No per-generation cost, no rate limit, works offline.
- Automatically **on-taste** — a puffed silhouette with a clearcoat is exactly the
  "gloss sheen on a flat mark" the brief asks for.

A vision model still has a job, just not that one. See §5.

---

## 2. Architecture at a glance

```
┌─ phone ───────────────┐        ┌─ big screen ──────────────────────────────┐
│  /draw?room=XKCD      │        │  /                                        │
│                       │        │                                           │
│  stroke capture       │ ─ws─▶  │  ingest ─▶ inflate ─▶ rig ─▶ spawn        │
│  emote wheel          │ ─ws─▶  │                                           │
│  hatch button         │ ─ws─▶  │  ortho iso world · egg · character        │
└───────────────────────┘        └───────────────────────────────────────────┘
                                          ▲
                                   Ghost Panel (dev only, Shift+D)
```

Packages:

| Path | Contents |
|---|---|
| `src/draw/` | Stroke capture, pressure/velocity width, canvas rasterizer |
| `src/shape/` | **Pure geometry.** Mask → contour → distance transform → skeleton → features |
| `src/inflate/` | Silhouette → `BufferGeometry`. The Teddy-style puff |
| `src/character/` | Archetype, gait, locomotion, emotes, eye SDF |
| `src/egg/` | Egg mesh, drawing wrap, wobble, crack shader, hatch sequence |
| `src/world/` | Camera rig, ground, props, spawn management, surface abstraction |
| `src/net/` | Room codes, WebSocket client |
| `src/ui/` | HUD, emote wheel, room code display |
| `src/dev/` | Ghost Panel skills, gated behind `isDev` |
| `worker/` | Cloudflare Worker + Durable Object (one per room) |

---

## 3. The drawing → character pipeline

This is the technical core and the thing to build first, because it is the only part with
real risk.

### 3.1 Capture (`src/draw/`)

- Pointer Events on a 2D canvas. Coalesced events (`getCoalescedEvents`) so fast strokes
  on a phone don't go polygonal.
- **Velocity-modulated stroke width** — slow strokes thicken, fast strokes thin. This is
  what produces the folk-woodcut, hand-carved edge quality the brief calls for. A constant
  round brush reads as clip-art and fails the 22/100 structure score.
- Store as a **stroke list** (`{points: [x,y,pressure][], width}[]`), not a bitmap. Small
  enough to send over the wire, and it lets the world replay the drawing as an animation.
- Undo/clear. Nothing else — no colors, no shapes, no fill tool. The palette is one black
  brush, which is the constraint that keeps every user's output on-taste.

### 3.2 Shape analysis (`src/shape/`) — pure, unit-tested

1. **Rasterize** strokes to a 512² binary mask.
2. **Largest connected component.** Discard components under ~0.5% of total ink — kills
   stray dots and lets people scribble without breaking the result.
3. **Euclidean distance transform** (two-pass Felzenszwalb). Gives interior "thickness" at
   every pixel. This one array drives inflation, skeletonization, and eye placement.
4. **Contour trace** the boundary (marching squares) → **Ramer–Douglas–Peucker** simplify to
   ~120 points → resample uniformly → **Chaikin smoothing** pass. The smoothing pass is
   the hard constraint "no rectilinear geometry with hard edges" enforced in code.
5. **Medial axis** from DT local maxima, pruned into a skeleton graph.
6. **Feature extraction** from skeleton leaves:
   - Leaves in the top 35% of the bbox → head / ears / antennae
   - Leaves in the bottom 30% → **feet** (locomotion attach points)
   - Lateral mid-height leaves → **arms / wings** (emote attach points)
   - Largest DT maximum in the upper region → **head lobe**, the eye anchor
7. **Archetype classification** from foot count, aspect ratio, and symmetry:
   `blob` (0 feet, hops) · `biped` (2) · `quadruped` (4) · `bird` (2 feet + lateral leaves + tall)

Golden tests: a fixture set of hand-made drawings with asserted archetype and feature counts.
This is where regressions will hide, so it gets the test coverage.

### 3.3 Inflation (`src/inflate/`)

Simplified [Teddy (Igarashi '99)](https://dl.acm.org/doi/10.1145/311535.311602) inflation:

- Triangulate the simplified contour (earcut), then subdivide for enough vertices to deform.
- Displace each vertex on **both** front and back by `z = ±k · sqrt(dt / dtMax)`.
  The `sqrt` matters — it gives a pillowy spherical cross-section. Linear gives a cone-tent,
  which reads as origami and violates the "organic, softened" constraint.
- Weld the rim, recompute smooth normals, light rim bevel.
- Result is a closed manifold whose head-on silhouette is exactly the drawing.

Material: `MeshPhysicalMaterial`, `color #080808`, `roughness ~0.35`, `clearcoat 1`,
`clearcoatRoughness ~0.15`, with a small studio env map. That is the brief's "quiet gloss
or reflective highlight on the black fill" — 38/100 material realism, not a chrome ball.

### 3.4 Eyes

Not geometry-heavy. Two small caps sitting just proud of the body surface at the head
anchor, with the **eye shape evaluated as a 2D SDF in the fragment shader**. One set of
uniforms morphs dot ↔ crescent ↔ wide oval ↔ closed line ↔ angry wedge.

That single shader is the entire emotional range of the character, which is exactly what
the brief mandates: *"Eyes are always the expressive anchor... never fully rendered features."*

Fill `#f4f3ef` so they read as **knockout** — negative space punched through the mark.

### 3.5 Locomotion — no skeleton, no bones

Because the body is a generated blob, we skip skeletal rigging entirely and deform the
whole mesh in a vertex shader from a handful of uniforms (bend, twist, squash, lean).

| Archetype | Gait |
|---|---|
| `blob` | Sinusoidal hop; squash on land, stretch at apex |
| `biped` | Two foot IK targets on a cycloid path; body bobs at 2× step frequency; **roll toward the planted foot** — that roll is the Chao/penguin waddle |
| `quadruped` | Four targets, diagonal gait |
| `bird` | Biped gait + lateral leaves flap on turns and emotes |

One `phase` scalar drives everything. Turning is a spring on heading, so direction changes
overshoot slightly and settle — interruptible and velocity-aware, per the `apple-design`
skill's posture on fluid motion.

---

## 4. Egg and hatching

- **Mesh**: ellipsoid, base `#f4f3ef`.
- **Pattern**: the user's drawing wrapped onto the shell — the raw mark centered on the
  front face, plus a rotated, scaled repeat band around the sides so it reads as a
  *painted* egg rather than a sticker. Rendered from the stroke list to a texture, so it
  stays crisp at any egg scale.
- **Reveal**: on spawn, replay the strokes onto the egg texture over ~1.2s. The egg
  visibly gets painted with what you just drew. Cheap to build, disproportionately good.
- **Wobble**: spring-driven rocking on the base. Amplitude and frequency ramp up as the
  hatch timer approaches zero, so the world telegraphs what's about to happen.
- **Cracks**: animated crack SDF in the shell fragment shader, growing in `#080808`.
  Progress is a single 0→1 uniform, so it's scrubbable in Ghost Panel.
- **Hatch**: shell splits into 2–3 pieces, they arc away and dissolve. Character pops out
  with an overshoot spring and does a `surprised` emote. This is the one moment `#fb5429`
  is allowed a flash.
- **Trigger**: auto after a configurable timer (default ~90s for demo pacing), plus a
  manual hatch from the phone or a dev key. Both paths run the identical sequence.

---

## 5. Where a vision model *does* earn its place

Geometry gives us the mesh and the rig. It cannot give us **character**. That's the model's job:

Send the drawing to Claude (vision) → get back a small structured descriptor:

```jsonc
{
  "name": "Pebble",              // shown once, in restrained type
  "archetypeHint": "bird",       // corroborates or overrides geometric guess
  "personality": "skittish",     // biases idle behavior + emote frequency
  "idleBias": ["look-around", "preen"],
  "emoteBias": { "surprised": 1.4, "sleepy": 0.6 },
  "walkSpeed": 1.15
}
```

Design rules for this:

- **Off the critical path.** The egg spawns immediately from geometry. The descriptor
  arrives whenever it arrives and enriches the character in place.
- **Never touches the mesh.** The user's drawn silhouette is inviolable.
- **Degrades to nothing.** No key, no network, rate-limited → geometric defaults, and the
  demo is still complete.

This split is the honest one: deterministic geometry for the thing that must be exact,
a model for the thing that benefits from taste and surprise.

---

## 6. The world

- **Camera**: orthographic, locked at true isometric (35.264° elevation, 45° azimuth).
  It does not shake, dolly, or hand-hold. The world moves under a still frame — that is
  how a game keeps the corpus's stillness.
- **Ground**: `#f4f3ef`. The "field of white". Near-white, never pure `#fff`.
- **Shadows**: soft blurred contact discs in `#bcbab7` under each entity. **No cast
  shadows from a directional light** — cast shadows smear midtones across the ground and
  would drop the 88/100 contrast score.
- **Props**: rocks, arches, trees — all authored as silhouettes and run through the *same*
  inflater. The world and the characters are consistent by construction, and props cost
  almost nothing to add.
- **Density**: the taste says 18–22/100. The world stays sparse. A handful of props and a
  lot of open ground. Resist filling it.

### Flat map vs sphere planet

Build the flat isometric map first, but write locomotion against a **surface abstraction**
from day one:

```ts
interface Surface {
  sampleHeight(p: Vec2): number
  normalAt(p: Vec2): Vec3
  project(p: Vec3): { pos: Vec3; up: Vec3 }
}
```

`FlatSurface` and `SphereSurface` both implement it. Then the planet is a swap, not a
rewrite. A curved horizon suits the taste well — but it is a Phase 5 upgrade, not a
Phase 0 commitment.

---

## 7. Cross-device

Room-code pairing:

1. Big screen opens `/`, gets a 4-character room code, displays it in restrained type.
2. Phone opens `/draw?room=XXXX` (QR code on screen).
3. Cloudflare Worker + **one Durable Object per room**, WebSocket both directions.

| Direction | Messages |
|---|---|
| phone → world | `drawing` (stroke list), `emote`, `hatch` |
| world → phone | `state` (`egg` / `hatching` / `alive`), `name`, `ack` |

Sending the **stroke list** rather than a PNG keeps payloads tiny and is what enables the
paint-on-reveal in §4.

Fallback path: a same-device drawing modal that bypasses the network entirely. Worth
keeping permanently — it's the offline demo and the dev loop.

---

## 8. Ghost Panel as the dev surface

[`epun/ghost-panel`](https://github.com/epun/ghost-panel) drops into the Three.js scene and
auto-mounts. We extend it with project skills via `ui.skills.register`:

| Skill | Controls |
|---|---|
| `refworld.inflater` | Puff depth, contour simplify tolerance, smoothing passes, live re-inflate |
| `refworld.character` | Archetype override, gait, step length, waddle amount, body scale |
| `refworld.eyes` | Eye SDF params, spacing, size, live emote preview |
| `refworld.egg` | Hatch timer, wobble amplitude, **crack progress scrub**, force hatch |
| `refworld.taste` | Palette swatches + a **grayscale-test toggle** that desaturates the frame so we can verify nothing but `#fb5429` depends on hue |

That last one turns a taste constraint into a button, which is the only way a constraint
actually survives a build.

Ghost Panel's graph editor authors the emote curves; we export them as data and ship the
data, not the panel. All of `src/dev/` is gated on `isDev` and tree-shaken from the
demo build.

---

## 9. Stack

| Choice | Why |
|---|---|
| Vite + TypeScript | Fast, and the geometry pipeline genuinely benefits from types |
| `three` (pinned) | Direct, no R3F — we own the render loop and Ghost Panel drops in clean |
| `motion` (vanilla) | DOM/UI transitions without pulling in React |
| Custom spring solver | 3D motion must be interruptible and velocity-aware; tweens aren't |
| Vitest | The `src/shape/` pipeline is pure functions — high-value test surface |
| Cloudflare Workers + DO | Room state, WebSockets, no server to run |

Deliberately **not** using: React (the UI is a canvas, a HUD, and an emote wheel), a physics
engine (locomotion is kinematic), skeletal animation (there is no skeleton), a 3D-generation
API (§1).

---

## 10. Phasing

| Phase | Deliverable | Done when |
|---|---|---|
| **P0** Scaffold | Vite + TS + Three, iso camera, ground, taste tokens, Ghost Panel wired | Empty white world renders, panel opens on `Shift+D` |
| **P1** Pipeline ⚠️ | Draw canvas → mask → contour → DT → features → inflated glossy mesh | Draw a blob, see it puffed and glossy in-world, head-on silhouette pixel-matches |
| **P2** Egg | Egg mesh, stroke-replay paint-on, wobble, crack shader, hatch sequence | Draw → egg paints itself → wobbles → cracks → character pops out |
| **P3** Life | Archetypes, gaits, waddle, idle behavior, eye SDF, emote set | Character walks the map, waddles, and emotes on command |
| **P4** Phone | Worker + DO, room codes, QR, phone draw/emote/hatch | Two devices, one world, full loop from a phone |
| **P5** Polish | Props, sphere-planet surface, QA, perf, mobile | 60fps on a mid phone; grayscale test passes |

**P1 is the risk.** Everything downstream assumes silhouette inflation produces something
that reads as a creature. Build it first, standalone, against a fixture set of ~15 real
drawings — including deliberately bad ones (a single line, a scribble, a disconnected
sketch) — before committing to P2.

---

## 11. Open decisions

1. **World topology** — flat iso map first with a `Surface` seam for the planet (recommended),
   or commit to the sphere from P0?
2. **Cross-device** — is phone-as-controller required for the demo (P4 as scoped), or is a
   same-device draw modal enough, with pairing as a stretch?
3. **Vision descriptor** — include the Claude-vision character descriptor (§5), or keep the
   whole thing deterministic and offline?
4. **Hatch pacing** — ~90s auto-hatch is tuned for a live demo. If this is going in front of
   an audience unattended, that number wants to be much shorter.

---

## Appendix — installed skills

Vendored into `.claude/skills/`. See [`.claude/skills/README.md`](../.claude/skills/README.md)
for provenance and licensing.

- **Motion & design engineering** (Emil Kowalski) — `animate`, `animation-vocabulary`,
  `review-animations`, `improve-animations`, `find-animation-opportunities`, `apple-design`,
  `emil-design-eng`, `prototype`
- **Three.js core** (CloudAI-X) — `threejs-fundamentals`, `-geometry`, `-materials`,
  `-textures`, `-lighting`, `-shaders`, `-animation`, `-loaders`, `-interaction`,
  `-postprocessing`
- **Game systems** (Majid Manzarpour) — `threejs-game-director`, `threejs-gameplay-systems`,
  `threejs-game-ui-designer`, `threejs-aaa-graphics-builder`, `threejs-debug-profiler`,
  `threejs-qa-release`, plus the `-3d-generator` / `-image-generator` / `-audio-generator`
  skills (these need third-party API keys; unused by the plan above)
- **3D vocabulary** (from `epun/ghost-panel`) — `3d-vocabulary`
