# ref-world — build plan

A shared isometric WebGL world. You draw on your phone; the drawing becomes the pattern on
an egg in the world; the egg hatches into a character loosely derived from what you drew;
you emote to it and track it on a minimap — all from your phone.

Art direction is governed by [`docs/TASTE.md`](./TASTE.md) and the two briefs under
[`docs/taste/`](./taste/). Read the arbitration first — it drives real technical choices
below, especially §2.1 on motion.

---

## 1. The load-bearing insight

The character taste is **flat single-color silhouettes with eyes as the only interior
detail**. A person drawing with a black brush on a white phone canvas is *already producing
art in the target style*.

That means the drawing→character step needs **no generative 3D model in the critical path**.
It needs a **silhouette-inflation pipeline**: puff the drawn shape into a rounded volume,
find its limbs from the medial axis, and drive it procedurally.

Consequences, all good:

- **Under a second, on-device.** No API round-trip between "done drawing" and "egg appears."
- **Deterministic.** Same strokes → same mesh, every time, on every device. This is what
  lets the phone render the character locally instead of streaming video from the world
  (§6.3). It's a large architectural win that falls out for free.
- **Testable.** The pipeline is pure functions over a bitmap.
- **Free and offline.** No per-generation cost, no rate limit, no failure mode where the
  demo can't start.
- **On-taste by construction** — a puffed silhouette with a clearcoat is exactly the "quiet
  gloss on a flat black mark" both briefs pair with muted saturation.

A vision model still has a job, just not this one. See §5.

### How "loosely based" gets implemented

The character should be *loosely* based on the drawing, not a literal extrusion of it. That
lives in one tunable, `fidelity ∈ [0,1]`:

| `fidelity` | Behavior |
|---|---|
| `0.0` | Pure inflation. Head-on silhouette is pixel-identical to the drawing. |
| `0.4` *(default)* | Silhouette proportions, limb topology, and distinctive protrusions preserved. Stance, eye placement, ground-contact feet, and a light pull toward bilateral symmetry are applied. |
| `1.0` | Archetype dominates — the drawing supplies proportions and features, the character brief's creature anatomy (beak, wing, waddle, perched pose) supplies the rest. |

The tradeoff is real and worth naming: **low fidelity maximizes "that's *my* drawing"
recognition; high fidelity maximizes "that's a real creature."** Both are the point of the
demo and they pull against each other. It ships as a dial, tuned in P1 against real drawings
rather than guessed at now.

Invariant regardless of `fidelity`: **interpretation may reproportion the silhouette, never
replace it.** Nothing generates a new shape.

---

## 2. Architecture

```
┌─ phone · /r/xkcd ────────┐          ┌─ big screen · /r/xkcd/world ───────────┐
│                          │          │                                        │
│  ① draw    stroke pad    │──ws──▶   │  ingest → inflate → rig → spawn egg    │
│  ② wait    egg + timer   │◀─ws──    │                                        │
│  ③ alive   character     │◀─ws──    │  iso world · eggs · characters ·       │
│            emote wheel   │──ws──▶   │  scatter units · hard flat shadows     │
│            minimap       │◀─ws──    │                                        │
└──────────────────────────┘          └────────────────────────────────────────┘
        many phones ──────────────────▶ one shared world
                                                 ▲
                                        Ghost Panel (dev only, shift+d)
```

| Path | Contents |
|---|---|
| `src/draw/` | Pointer capture, velocity-modulated stroke width, rasterizer |
| `src/shape/` | **Pure.** mask → contour → distance transform → skeleton → features |
| `src/inflate/` | Silhouette → `BufferGeometry`. Teddy-style puff. **Pure + deterministic** |
| `src/character/` | Archetype, gait, locomotion, emotes, eye SDF |
| `src/egg/` | Egg mesh, drawing wrap, wobble, crack shader, hatch sequence |
| `src/world/` | Camera rig, ground, `Surface`, scatter placement, shadow pass |
| `src/motion/` | Drift-settle solver, ambient-drift floor, the ζ≥1 spring |
| `src/net/` | Room protocol, WebSocket client, state sync |
| `src/phone/` | The companion app — draw, wait, alive, emote wheel, minimap |
| `src/ui/` | Shared HUD primitives, type scale |
| `src/moderation/` | **Pure.** What may become a creature — the screen, and the ingest gate |
| `src/dev/` | Ghost Panel skills. Gated on `isDev`, tree-shaken from the demo build |
| `worker/` | Cloudflare Worker + Durable Object, one per room |

`src/shape/`, `src/inflate/` and `src/moderation/` import **nothing** from Three.js or the
DOM. That purity is what lets both the phone and the world run them and get byte-identical
results — and, for moderation, what makes a decision reproducible after the event.

Every drawing enters the world through **one** call: the ingest gate
(`src/moderation/gate.ts`). Nothing spawns around it. What it screens, what it cannot, and
what the operator has to do instead is [`MODERATION.md`](./MODERATION.md).

---

## 3. Drawing → character

The technical core, and the only part with real risk. Build it first.

### 3.1 Capture (`src/draw/`)

- Pointer Events with `getCoalescedEvents` so fast phone strokes don't go polygonal.
- **Velocity-modulated stroke width** — slow strokes thicken, fast thin. This produces the
  hand-carved woodcut edge the character brief calls for. A constant round brush reads as
  clip-art and fails the 22/100 structure score.
- Stored as a **stroke list** (`{ pts: [x,y,t][], w }[]`), not a bitmap: tiny on the wire,
  replayable as an animation, and the deterministic input both devices share.
- One black brush. Undo, clear. **No colors, no shapes, no fill tool.** The single-brush
  constraint is what keeps every user's output on-taste without moderating anything.

### 3.2 Shape analysis (`src/shape/`) — pure, unit-tested

1. **Rasterize** to a 512² binary mask.
2. **Largest connected component.** Drop components under ~0.5% of ink — kills stray dots,
   lets people scribble without wrecking the result.
3. **Euclidean distance transform** (two-pass Felzenszwalb). Interior thickness at every
   pixel. This one array drives inflation, skeletonization, and eye placement.
4. **Contour trace** (marching squares) → **Ramer–Douglas–Peucker** to ~120 points →
   uniform resample → **Chaikin smoothing**. That smoothing pass is the hard constraint
   *"no rectilinear geometry with hard edges"* enforced in code rather than in review.
5. **Medial axis** from DT ridges, pruned to a skeleton graph.
6. **Feature extraction** from skeleton leaves:
   - top 35% of bbox → head / ears / antennae
   - bottom 30% → **feet** (locomotion attach points)
   - lateral mid-height → **arms / wings** (emote attach points)
   - largest DT maximum in the upper region → **head lobe**, the eye anchor
7. **Archetype**: `blob` (0 feet) · `biped` (2) · `quadruped` (4) · `bird` (2 + lateral + tall)

Golden tests against a fixture set of real drawings — including deliberately bad ones (a
single line, a scribble, a disconnected sketch, a drawing that fills the whole canvas).

### 3.3 Inflation (`src/inflate/`)

Simplified [Teddy (Igarashi '99)](https://dl.acm.org/doi/10.1145/311535.311602):

- Triangulate the smoothed contour (earcut), subdivide for deformation headroom.
- Displace front and back by `z = ±k · sqrt(dt / dtMax)`. The `sqrt` matters — it gives a
  pillowy spherical cross-section. Linear gives a cone-tent that reads as origami and
  violates "organic or softened."
- Weld the rim, smooth normals, light rim bevel.
- Apply the `fidelity` interpretation pass (§1) — reproportion, stance, symmetry pull.

Material: `MeshPhysicalMaterial`, `#080808`, `roughness ~0.35`, `clearcoat 1`,
`clearcoatRoughness ~0.15`, small studio env map. That's the gloss both briefs pair with
muted saturation — 38/100 material realism, not a chrome ball.

**The character is the only object in the scene allowed near `#080808`.** See TASTE §1.

### 3.4 Eyes

Two small caps just proud of the body at the head anchor, with the **eye shape evaluated as
a 2D SDF in the fragment shader**. One uniform set morphs dot ↔ crescent ↔ wide oval ↔
closed line ↔ angry wedge.

That shader is the character's entire emotional range, which is exactly what the brief
mandates: *"eyes are always the expressive anchor... never fully rendered features."*
Fill `#f4f3ef` so they read as **knockout**.

### 3.5 Locomotion — no skeleton, no bones, no bounce

The body is a generated blob, so we skip skeletal rigging entirely and deform the whole mesh
in a vertex shader from a few uniforms (bend, twist, squash, lean).

| Archetype | Gait |
|---|---|
| `blob` | Undulating **glide** — a travelling sine through the body. *Not* a hop: repeated hopping reads as bounce, which is forbidden. |
| `biped` | Two foot targets on a cycloid; body bobs at 2× step frequency; **rolls toward the planted foot** — that roll is the waddle |
| `quadruped` | Four targets, diagonal gait |
| `bird` | Biped gait; lateral leaves flap on turns and emotes |

One `phase` scalar drives all of it. **Heading changes are critically damped (ζ = 1.0)** —
they settle without ever crossing the target, per TASTE §2.1. Characters decelerate into
idle; they never hard-stop. Idle is not rest — the ambient drift floor keeps them alive.

---

## 4. Egg and hatching

- **Mesh**: ellipsoid, light `#e9ebe9` — the palette's *light / light-struck* role, which
  is what makes the egg read as the one lit object in a mid-toned field.
- **Pattern**: the drawing wrapped onto the shell — the mark centered on the front face plus
  a rotated, scaled repeat band around the sides, so it reads as a *painted* egg rather than
  a decal. Rendered from the stroke list, so it stays crisp at any scale.
- **Paint-on reveal**: on spawn, replay the strokes onto the egg texture over `t.primary`
  (1823ms). The egg visibly gets painted with what you just drew. Cheap; disproportionately
  good.
- **Wobble**: continuous rocking that **never stops** — amplitude and frequency ramp up as
  the hatch approaches, so the world telegraphs what's coming. Drift-settle, no rebound.
- **Cracks**: animated crack SDF in the shell fragment shader, growing in `#44413c`. Single
  0→1 uniform, so it's scrubbable in Ghost Panel.
- **Hatch**: shell parts in 2–3 pieces that **slide** away and dissolve; the character
  **rises and drifts** to rest. No pop, no overshoot, no scale-in — those are all forbidden.
  It plays a `surprised` eye morph on arrival. This is the one moment `#fb5429` gets a flash.
- **Trigger**: auto after a configurable timer, plus manual hatch from the phone or a dev
  key. Both paths run the identical sequence.

---

## 5. Where a vision model earns its place

Geometry gives us the mesh and the rig. It can't give us **character**. That's the model's job:

```jsonc
{
  "name": "pebble",              // lowercase — TASTE §5, no uppercase anywhere
  "archetypeHint": "bird",       // corroborates or overrides the geometric guess
  "personality": "skittish",     // biases idle behavior and emote frequency
  "idleBias": ["look-around", "preen"],
  "emoteBias": { "surprised": 1.4, "sleepy": 0.6 },
  "walkSpeed": 1.15
}
```

Rules:

- **Off the critical path.** The egg spawns immediately from geometry. The descriptor
  arrives whenever it arrives and enriches the character in place.
- **Never touches the mesh.** Interpretation is the `fidelity` pass, and it's geometric.
- **Degrades to nothing.** No key, no network, rate-limited → geometric defaults, and the
  demo is still complete.

---

## 6. The phone app (`src/phone/`)

The phone is a **persistent companion screen**, not a one-shot drawing pad. Three states,
each sliding into the next — never cutting.

### 6.1 ① draw

Full-bleed canvas, light `#e9ebe9` ground, one black brush. Undo / clear / done. Chrome is
hairline rules and icon marks only (TASTE §4) — no filled panels.

### 6.2 ② wait

The egg, rendered on the phone, painting itself with your strokes. A hatch countdown in
restrained lowercase type. A manual **hatch now** button.

### 6.3 ③ alive — your character, on your phone

Because `src/shape/` and `src/inflate/` are pure and deterministic, **the phone runs the
identical pipeline on the stroke list it already has and gets the identical mesh.** No
geometry crosses the wire. The phone shows a head-on portrait — which, at low `fidelity`,
*is* the drawing, closing the loop visually.

The world streams only lightweight state: position, heading, current emote, name.

**Emote wheel** — radial, touch, icon-only (the graphic layer both briefs specify is `icon`;
and labels would violate the no-uppercase rule anyway). Chao-inspired set: `happy`, `sad`,
`sleepy`, `angry`, `surprised`, `dance`, `wave`. Each is (eye SDF params + body deform curve
+ optional `#fb5429` glyph that **slides** in above the head and drifts).

**Minimap** — top-down on the mid-toned ground value, hand-drawn feel with jittered linework.
Built strictly from the measured mark set: a **thin `border`**, a **single hairline
`ruleLine`**, and **`icon`** marks (TASTE §4). No filled panel, no card, no drop shadow —
those mark types don't exist in this taste.

Scatter units render as tiny `#92928e` marks. Other players are `#666764`. **You** are
`#080808` with the `#fb5429` ring — that ring is your one accent, so nothing else on the
minimap may use it. Position updates throttled to ~10Hz and interpolated with a drift settle,
so the marker never jitters or snaps.

---

## 7. The world (`src/world/`)

- **Camera**: orthographic, true isometric (35.264° elevation / 45° azimuth), holding an
  imperceptibly slow **continuous drift**. It never locks, never shakes, never cuts. Reframes
  slide at `t.primary` and settle by drifting. Follow policy is in §7.1.
- **Ground**: mid-toned neutral `#b6b6af`–`#c2c2bb`, targeting the measured `groundLuma
  0.74`. **Not cream, not white** — see TASTE §2.2.
- **Scatter**: repeated small hand-drawn units — trees, rocks, huts, birds, doodads —
  authored as silhouettes and run through the **same inflater** as the characters. Placement
  on the isometric grid with jitter; **grid governs placement, never form** (TASTE §2.5).
  Values stay inside `#92928e`–`#666764`, never darker than `#353534` — the near-black band
  belongs to characters alone.
- **Grain**: a subtle, uniform **full-frame grain pass** over the composited image. This is
  the world brief's #2 defining signal (*"a steady grain sits over gloss finishes"*, 100% of
  corpus). It is a post-process, never a material texture — it must not vary across a
  character's fill or the silhouette stops reading as one solid shape (TASTE §2.7). Low
  amplitude: the corpus reads *polished*, not tactile.
- **Lighting**: hard key with sharp shadow edges, key-to-fill even and non-directional
  (`softness 0.117`, `keyToFill 0.333`). Explicitly **not** diffuse or shadowless. Paired
  with the gloss finish, per a defining pairing in both briefs.
- **Density**: global ≈0.39 (measured). Each character carries a **negative-space exclusion
  radius** that scatter won't enter (TASTE §2.3). Balanced overall, open around each subject.
- **Shadows**: **hard-edged, flat-filled** — a single value cut sharp, no penumbra, no PCF,
  no AO smear (TASTE §2.4). Shadow as a stamped graphic shape. This is a custom pass, not
  Three.js's default shadow mapping.
- **Scale is the subject.** The world brief's whole thesis is a tiny inhabitant in an
  enormous field. Characters render small. Resist the urge to frame them close.

### 7.1 A huge map, roamed freely — *(decided)*

No population cap. The map is large enough that characters naturally disperse and rarely
share a frame, so the "tiny inhabitant in an enormous field" thesis holds locally at any
point on it rather than being enforced by a despawn rule. Three things follow, and each is
real work rather than a free consequence:

**The camera has to choose.** With characters spread across a huge map, there's no single
framing that contains them. The answer is a **slow continuous tour**: the camera drifts
across the world on its own, easing near clusters and lone wanderers, dwelling, then moving
on. It never cuts between subjects — a cut is forbidden anyway (TASTE §2.1), and the
constraint turns out to be the feature. A tour *is* the world brief's reading order:
one small figure, then a field, then another small figure.

Hatches interrupt the tour by **sliding** the camera over at `t.primary`. That's the one
event important enough to redirect it.

**Wander behavior has to actively disperse.** Characters can't random-walk, or they clump
around spawn. Each gets a roam target biased away from other characters and toward
unvisited regions — dispersal is a gameplay system, not an emergent hope.

**The world has to be chunked.** Spatial partitioning so only nearby characters simulate at
full rate and only nearby scatter renders. Distant characters tick at a reduced rate and
render as simplified silhouettes; the inflated mesh is LOD'd down. This is the main perf
risk in the whole plan and it lands in P5.

**The minimap absorbs the crowding.** This is where a busy world actually shows, so the
minimap does the work: **you** are `#080808` with the `#fb5429` ring, always distinct at any
zoom; everyone else is muted `#8e908d` and clusters into a single softer mark below a
distance threshold. The map stays legible because it never tries to distinguish other
players from each other.

### 7.2 Flat map first, sphere behind a seam — *(decided)*

Build the flat isometric map, but write locomotion against a surface abstraction from day one:

```ts
interface Surface {
  sampleHeight(p: Vec2): number
  normalAt(p: Vec2): Vec3
  project(p: Vec3): { pos: Vec3; up: Vec3 }
}
```

`FlatSurface` ships first; `SphereSurface` implements the same interface later. **Locomotion
never touches world-space Y** — that discipline is the entire cost of keeping the planet
available, and it's cheap if held from the start and expensive to retrofit.

A curved horizon suits the world brief's pixel-planet reference well, and it interacts
nicely with §7.1: on a sphere, the camera tour becomes an orbit and dispersal is bounded by
the planet's surface area. P5, not P0.

---

## 8. Networking (`src/net/`, `worker/`)

Cloudflare Worker + **one Durable Object per room**. WebSocket both directions.

| Direction | Messages |
|---|---|
| phone → world | `join`, `drawing` (stroke list), `emote`, `hatch` |
| world → phone | `state` (`draw`/`egg`/`hatching`/`alive`), `pose` (pos + heading, ~10Hz), `roster` (minimap peers), `name` |

Stroke lists rather than PNGs: tiny payloads, replayable paint-on, and the deterministic
input that makes §6.3 work.

**Multiplayer falls out.** Many phones, one room, one world, N characters — which is what
the minimap requirement implies and what makes this good in a room full of people.

With no population cap (§7.1), `roster` is the message that grows. It carries only what the
minimap needs — id, position, and whether it's you — at a low tick rate, with distant peers
already clustered server-side so a busy room doesn't push per-character data to every phone.

Fallback: a same-device draw modal that bypasses the network entirely. Worth keeping
permanently — it's the offline demo and the fast dev loop.

---

## 9. Motion (`src/motion/`)

TASTE §3 is the spec. Implementation notes:

- One solver. **Damping ratio ζ is clamped to ≥ 1.0 at the API boundary** — underdamped
  springs are unrepresentable, so bounce cannot be written into the codebase by accident.
- The **ambient drift floor** is a scene-wide system, not per-element: low-frequency noise
  at ~0.3% of scale applied to everything, forever. Nothing ever fully arrests.
- Durations come from tokens (`t.tertiary` 456 / `t.secondary` 912 / `t.primary` 1823 /
  `t.ambient` 3646), never from literals.
- Entrances translate in. There is no `scale: 0 → 1` helper, and no opacity-only pop.

---

## 10. Ghost Panel as the dev surface

[`epun/ghost-panel`](https://github.com/epun/ghost-panel) auto-mounts against the Three.js
scene. We extend it via `ui.skills.register`:

| Skill | Controls |
|---|---|
| `refworld.inflater` | Puff depth, simplify tolerance, smoothing passes, **`fidelity` dial**, live re-inflate |
| `refworld.character` | Archetype override, gait, step length, waddle amount, scale |
| `refworld.eyes` | Eye SDF params, spacing, size, live emote preview |
| `refworld.egg` | Hatch timer, wobble amplitude, **crack progress scrub**, force hatch |
| `refworld.world` | Scatter density, exclusion radius, grid jitter, shadow hardness |
| `refworld.moderation` | **The operator layer** ([`MODERATION.md`](./MODERATION.md)) — hold arrivals for approval, approve/discard the queue, remove a creature in one tap, block a drawer |
| `refworld.taste` | **The verification gates from TASTE §7** — achromatic toggle, value histogram, damping audit, uppercase scan, stillness probe, density probe, mark-set lint, grain check |

That last row is the important one: a taste constraint that isn't a button doesn't survive a
build. Ghost Panel's graph editor authors the emote curves; we ship the exported data, not
the panel. All of `src/dev/` is gated on `isDev`.

---

## 11. Stack

| Choice | Why |
|---|---|
| Vite + TypeScript | Fast; the geometry pipeline genuinely benefits from types |
| `three` (pinned) | Direct, no R3F — we own the render loop and Ghost Panel drops in clean |
| Custom drift solver | The motion constraints rule out every off-the-shelf spring library's defaults |
| Vitest | `src/shape/` and `src/inflate/` are pure — the highest-value test surface here |
| Cloudflare Workers + DO | Room state and WebSockets with no server to run |

Deliberately **not** using: React (the UI is a canvas, a wheel, and a minimap); a physics
engine (locomotion is kinematic); skeletal animation (there is no skeleton); a 3D-generation
API (§1); a spring library (§9); Three.js shadow mapping (§7).

---

## 12. Phasing

| Phase | Deliverable | Done when |
|---|---|---|
| **P0** Scaffold | Vite + TS + Three, iso camera, mid-toned ground, grain pass, motion tokens, Ghost Panel, taste gates | Empty world renders and passes the achromatic + value + damping gates |
| **P1** Pipeline ⚠️ | Draw → mask → contour → DT → features → inflated glossy mesh, `fidelity` dial | Draw a blob, see it puffed and glossy in-world; dial tuned against ~15 real drawings |
| **P2** Egg | Egg mesh, stroke-replay paint-on, wobble, crack shader, hatch sequence | Draw → egg paints itself → wobbles → cracks → character drifts out |
| **P3** Life | Archetypes, gaits, waddle, idle behavior, eye SDF, emote set | Character walks the map, waddles, emotes on command, never fully stops |
| **P4** Phone | Worker + DO, rooms, the three phone states, emote wheel, minimap | Two phones, one world, full loop end to end |
| **P5** World | Scatter units, hard flat shadows, density gates, camera tour, dispersal AI, chunking + LOD, sphere `Surface` | Density and contrast probes pass; a busy room stays 60fps; planet variant swaps in |
| **P6** Polish | QA, perf, mobile, safe areas | 60fps on a mid phone; every TASTE §7 gate green |

P5 absorbed the cost of the huge-map decision (§7.1) — chunking, LOD, dispersal, and the
camera tour all land there. It's now the second-heaviest phase after P1 and should not be
treated as a polish pass.

**P1 is the risk.** Everything downstream assumes silhouette inflation produces something
that reads as a creature, and that the `fidelity` dial has a setting where people both
recognize their drawing *and* accept it as alive. Build it standalone against a real fixture
set before committing to P2.

---

## 13. Open decisions

1. **`fidelity` default.** Proposing 0.4 — recognizably your drawing, but standing and alive.
   A taste call to make by looking at P1 output, not now.
2. **Hatch pacing.** Needs a number. Tuned for a live demo, ~90s; unattended in front of an
   audience, much shorter.
3. **Camera dwell timing.** The tour (§7.1) needs a dwell duration per subject and a rule for
   what makes a spot worth easing toward. Both want tuning against a populated world.
4. **Room lifetime.** Rooms persist while anyone's connected — but do characters survive an
   empty room and a later rejoin, or does the world reset? Decides whether the DO needs
   durable storage or just in-memory state.
5. **Body type family.** The world brief's grotesque-sans read is marked *incidental*
   (conf 0.38, "preserve: no"), so it's the one type decision genuinely open to us. The
   wordmark is fixed: rounded slab serif, title case, bold.
6. **1823ms.** Measured at confidence 0.06 from four references. The *constraints* around it
   are confidence 1.00, but the number itself is a first guess to tune against.

### Decided

- **Crowding** — huge map, no cap, characters roam free. Costs chunking, LOD, dispersal AI,
  and a touring camera; see §7.1.
- **Topology** — flat map first, `SphereSurface` behind the `Surface` seam; see §7.2.
- **World palette** — resolved. The full measured token block arrived; the ground is
  **mid-toned neutral grey at `groundLuma 0.74`**, and there is **no pastel green or pink**
  in this taste. The earlier inference from truncated prose was wrong and has been corrected
  throughout (TASTE §2.2).

### A caution carried from the brief

The world brief marks `threeD` as **not observed** — there is no 3D evidence in its corpus at
all, and it instructs: *"never invent a rule and attribute it to this taste."* This is a 3D
project whose taste is silent on 3D. Rendering decisions are governed by the *observed* axes
(color, lighting, composition, graphics, surface, motion) and otherwise are **ours**. TASTE
tags every rule `[M]` measured or `[D]` derived so the line stays visible.

---

## Appendix — installed skills

Vendored into `.claude/skills/`; provenance in [`.claude/skills/README.md`](../.claude/skills/README.md).

- **Motion & design engineering** (Emil Kowalski) — `animate`, `animation-vocabulary`,
  `review-animations`, `improve-animations`, `find-animation-opportunities`, `apple-design`,
  `emil-design-eng`, `prototype`
- **Three.js core** (CloudAI-X) — `threejs-fundamentals`, `-geometry`, `-materials`,
  `-textures`, `-lighting`, `-shaders`, `-animation`, `-loaders`, `-interaction`,
  `-postprocessing`
- **Game systems** (Majid Manzarpour) — `threejs-game-director`, `threejs-gameplay-systems`,
  `threejs-game-ui-designer`, `threejs-aaa-graphics-builder`, `threejs-debug-profiler`,
  `threejs-qa-release`, plus `-3d-generator` / `-image-generator` / `-audio-generator`
  (need third-party API keys; unused by this plan)
- **3D vocabulary** (from `epun/ghost-panel`)

> ⚠️ Two vendored skills push directly against this project's taste and must be used
> selectively:
> - **`apple-design`** recommends springs with overshoot. Overshoot is a hard constraint
>   violation here (TASTE §2.1). Take its interruptibility and gesture guidance; reject its
>   curves.
> - **`threejs-aaa-graphics-builder`** pushes photoreal/AAA art direction. Use it for render
>   budgets and LOD only.
