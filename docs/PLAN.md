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
| `src/world/` | Camera rig, ground, `Surface`, scatter placement, shadow pass, landscape (authored map), water |
| `src/motion/` | Drift-settle solver, ambient-drift floor, the ζ≥1 spring |
| `src/net/` | Room protocol, WebSocket client, state sync |
| `src/phone/` | The companion app — draw, wait, alive, emote wheel, minimap |
| `src/ui/` | Shared HUD primitives, type scale |
| `src/moderation/` | **Pure.** What may become a creature — the screen, and the ingest gate |
| `src/session/` | **Pure.** The session event log and its replay ([`SESSION.md`](./SESSION.md)) |
| `src/dev/` | Ghost Panel skills. Gated on `isDev`, tree-shaken from the demo build |
| `worker/` | Cloudflare Worker + Durable Object, one per room |

`src/shape/`, `src/inflate/` and `src/moderation/` import **nothing** from Three.js or the
DOM. That purity is what lets both the phone and the world run them and get byte-identical
results — and, for moderation, what makes a decision reproducible after the event.

Every drawing enters the world through **one** call: the ingest gate
(`src/moderation/gate.ts`). Nothing spawns around it. What it screens, what it cannot, and
what the operator has to do instead is [`MODERATION.md`](./MODERATION.md).

That single seam is also what makes the session recorder honest: the gate and the creature
manager each hand a structural observer everything they decide, so a session log cannot miss
a drawing, a hatch or an operator's removal. The log holds inputs and decisions — never
per-frame state, because generation is deterministic and replay re-derives the rest.
See [`SESSION.md`](./SESSION.md).

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
- **Landscape**: the geography is **authored** in `src/world/landscape.ts` and is the single
  source every system samples — placement, colliders, water, minimap, height. A forest to the
  west, a range along the north, one lake with an island in it, four ponds, and since
  2026-09-15 **the map is an island** (user ask: *"I want this map to be an island instead of
  a large flat plane … it should feel like Studio Ghibli meets Scavengers Reign on a tropical
  island"*). The coast is `ISLAND_LOBES`: the union of four wobbled discs — a 150-radius main
  mass at the origin plus three headlands (north, south-east, west), so the coastline has
  bays and points at a scale one blob's three harmonics cannot reach. Measured radius
  **131.7–176.3** [D], inside the ground field's own ±200. Every authored feature keeps at
  least **12 units of land** between its edge and the sea (measured 12.55 at the range's
  eastern mass); the headlands are placed to buy that clearance, and nothing in the 2026-09-03
  layout moved. **It is 1.1× THAT SIZE on the katamari world** (`MAP_SCALE`; it was 2 from
  2026-09-16 and 1.3 briefly on 2026-09-17) — coast **144.8–193.9**, land area 1.21× over —
  see "one number for the map's size" below.
  **The sea is the complement of the coast** — `isWater` answers true outside it, so there is
  no separate ocean outline and nothing else has to know where the edge of the world is. It
  sits at `SEA_LEVEL = -1.2` before the elevation dial [D], under the plain's own tier 0 so
  the beach reads as a step down; `seaLevel()` is the one plane the whole ocean rides.
  `terrainHeight` cuts it as a **mirrored basin**: the land climbs out of the waterline over
  `TERRAIN.coastRamp = 26` [D] (wider than a lake's `shoreRamp` of 16 — the range's shoulder
  still stands 5–6 units high where the sea meets it, and at 16 the climb measured 0.6951,
  over the field's own 0.6 gradient bound; at 26 it measures 0.4967), with the same
  `basinRim` guard holding the first units of beach at the waterline. Outside the coast the
  floor falls one `shoreRamp` to `SEA_LEVEL - basinDrop` and is flat from there out — **the
  ground's far ring is sea floor now**, seated off the Surface at its own inner rim rather
  than assuming zero. The sea pass runs BEFORE the authored basins, the one place it departs
  from them: a basin's interior has to come out exactly its `waterLevel`, so nothing may run
  after one, and the sea is the landform the basins are cut into.
  **The beach** is a soft weight on the landscape sample — 1 at the waterline fading to 0
  `BEACH_WIDTH = 14` units inland [D] — and a `Region` of its own, claimed where that weight
  reaches 0.5. Scatter gives it a table (`BEACH_SEED`): small rocks and plenty of them,
  stumps as driftwood, palms, a rare cactus, sparse ticks, and nothing built or forested. The
  sea plants nothing, as it always did for water. Creatures are stopped at the waterline by a
  **wall** of hex-pitch collider circles walked along the coast (479 of them at the authored
  size, and `MAP_SCALE` times as many on a scaled one) rather than a tiling of the ocean,
  which would be unbounded.
  The plain mode is untouched by all of it: no coast, no sea, no beach, flat paper — pinned at
  2,000 points in `test/world/island.test.ts`.
- **One number for the map's size — *(2026-09-16 "make the island twice as big", then
  2026-09-17 "the map is way too big, let's reduce its size by 35%" and, the same day, "I
  still think this island is way too big, let's reduce it by another 15%")*.** `MAP_SCALE` in
  `src/world/landscape.ts` has been **2, then 1.3, then 1.1** — read as the multiple of the
  authored DIAMETER, and each reduction read as LINEAR (2 · 0.65 = 1.3, 1.3 · 0.85 ≈ 1.1).
  The doubled island was simply too much ground to cross for a room of 50–80 people: a
  creature a viewer could not find, and a katamari that never met the next thing to roll over.
  **1.1 keeps the island reading as an island** — a coast in frame at the zoom floor, a
  forest and a range and a lake that do not touch — while putting the far shore back within
  a walk.
  It is ONE number, read through `mapScale()` and **gated on `islandMode`**, so meridian and
  the public world are the map they already have to the bit
  (`test/world/island-scale.test.ts` pins both halves, and spells the scale out in exactly
  one assertion so the next change is one number plus a re-measure). The scale is UNIFORM and
  ABOUT THE ORIGIN, and that is what makes it one number rather than a second layout: the
  wobble phases key off a blob's seed and its polar angle and both survive such a scale, so
  `coastInland(kx, kz) = k·coastInland(x, z)` exactly and every clearance, ring width and bay
  depth the island's tests measure comes out scaled rather than re-authored.
  **It is no longer an integer, and that is the whole cost of the change.** Every derived
  COUNT has to be rounded where it is derived, and what was held *exactly* across the scale
  (a chord, a quad, a texel) is now held to within half a count: the three outline vertex
  counts (211 / 106 / 70 at 1.1, a 4.90-unit coast chord against the authored 4.9), the
  ground field's segments (352 — `320 · 1.1` happens to be whole, so the quad is exactly
  1.25 again), the three bake resolutions and the physics heightfield. The bakes are **rounded
  to a whole texel count rather than stepped to the next power of two**: 141² / 282² / 563²
  over 440 units, which holds every texel within 0.1% of its authored size (3.1206 / 1.5603 /
  0.7815 against 3.125 / 1.5625 / 0.78125). NPOT is free here — WebGL2, CLAMP, no mipmaps,
  and the height bake does its own bilinear tap off `uHeightRes` — where a power-of-two step
  would have halved the texel and quadrupled a bake that already measures a second on one
  core. And `MAP_SCALE` is not an exact binary float either, so a test asserts a scaled
  coordinate against `authored · MAP_SCALE` rather than against a spelled-out literal.
  **The riser run is now a function of the scale** (`riserRun`, `src/world/field.ts`) instead
  of a two-entry table: a riser climbs the middle 60% of a tier step, so it takes
  `0.96 / steepestSlope` units of run, and the steepest slope is MEASURED per scale because
  the verticals and the noise wavelengths do not scale — **0.843** authored, **0.4570** at 1.1
  (at 64.5, −133 on the range's apron), 0.5111 at 1.3, 0.4814 at 2. So the run is **2.101 u**
  at 1.1 against the 1.25 u quad. An unmeasured scale falls back on `0.843/√scale`, which
  understates the run and so tightens the bound rather than loosening it.
  **What scales** is anything that says WHERE something is: the coast's lobes; the forest and
  the range, centre *and* radius (a region has to stay one readable mass — at their authored
  radii the four mountain masses would have stopped overlapping and the range would have come
  apart into four hills); the lake, whole, its own island with it (the ring of water round it
  is a measured pair); the ponds' centres; `TERRAIN.islandRamp`, which is read as a fraction
  of a lake island's own radius; the far-field gate (`farFieldStart` / `farFieldEnd`, 165 /
  203.5 at 1.1) which is where the land settles onto the flat outer disc and so has to stay
  outside the coast; and every ring's vertex count, so a longer coastline keeps its ~4.9-unit
  chords.
  **What does not** is anything that says HOW BIG a physical thing is: `BEACH_WIDTH` 14,
  `TERRAIN.coastRamp` 26, `shoreRamp` 16, `basinRim`, `basinDrop`, `SEA_LEVEL`, every shelf
  height, the terrace step, the two noise wavelengths, the hatch clearing, a POND's own
  radius — and the shelf APRONS (`forestShelfFalloff` 24, `mountainShelfFalloff` 70). The
  aprons were tried scaled first and measured worse: a 140-unit apron on the range reaches
  from z = −210 to z = −18 and lifted most of the open plain with it, so the forest stopped
  standing a tier over it (1.12 → 0.49 on `test/world/landscape.test.ts`'s own metric). A
  bigger island gets more foothills, not wider ones. Verticals are untouched throughout, so
  every slope on the map is shallower than it was authored — the steepest measures **0.4570**
  at 1.1 against the field's 0.6 bound (0.4814 at 2, 0.843 authored), and the lake island's
  bank no longer needs the terrain test's explicit exception.
  **A body of water is the one thing a change of scale can break.** A pond's centre scales
  and the terrain NOISE does not, so every body lands on a different patch of the same
  hummocks at every scale, and `test/world/landscape.test.ts`'s basin-shoulder bound is what
  catches it: at the 1.3 tried on the way to 1.1 the first pond landed straddling a terrace
  riser with the ground east of it a whole tier below its own water line (0.517 against the
  0.6 bound — water reading as perched rather than sunk), and the fix would have been the
  pond's authored centre, not the bound. At 1.1 it measures 1.076, the healthiest of the
  four, so the authored layout is untouched. Re-measure the four when the scale moves.
  **Every field that has to cover the land rides the same factor**, and what is held fixed
  across the scale is the RESOLUTION. At 1.1: `FIELD_SIZE` 400 → 440 with `FIELD_SEGMENTS`
  320 → 352, so the quad stays **1.25 u**; the three geography bakes keep their texel
  (region 128² → 141², height 256² → 282², shore 512² → 563², all over 440 u);
  `GRASS_BASE_SPAN` 360 → 396 at the same budget; `SCATTER_EXTENT` 160 → 176 at the same
  6-unit grid step, so the prop count per unit area is unchanged; `HEIGHTFIELD_SEGMENTS`
  256 → 282 at the same 1.56-u cell; `SPAWN_RADIUS` 120 → 132; `WORLD_MAP_EXTENT` 185 →
  203.5; and `GROUND_RADIUS` 1400 → 1540 with the depth range that clears it
  (`cameraDistance` 1800 → 1960, `cameraFar` 3800 → 3920). The sea disc has to ride the map
  for a reason that is not symmetry, and it is a RULE and not a table: at the zoom floor on a
  390×844 phone the WIDTH binds, so the frame looks ~4× the coast's radius up-screen past the
  island, and the sea has to cover the far CORNER of it — measured **818 u** at 1.1 against
  the 1540-u ring (at 2 the corner was outside a 1400-u ring, which is what made this a
  derived number in the first place). `test/world/island-scale.test.ts` measures the corner
  rather than restating it.
  The blade field's base blade was widened √2 with its pixel floor 1.5× for the doubled
  island's quarter density; that switch is on `mapScale() !== 1` and still applies at 1.1,
  where the density loss is only a fifth — a slightly heavier blade on a slightly bigger
  meadow, and left alone deliberately rather than re-tuned for a scale that has moved twice
  in a day.
  `zoomMinFor` and `panLimitFor` needed no change — they were already derived from the
  coast's own reach — but the pan CEILING did: 200 units on an island whose coast reaches 352
  would have put the far shore out of reach at every zoom, so it rides the scale too (220 at
  1.1).
  **Not scaled: the painted map.** `PAINTED_SIZE` stays 400 because its extent is on the wire
  (`SCENE_EXTENT`, `src/session/scene.ts`), so the dev brushes paint the middle 400 units of
  a scaled island and the geography bakes no longer share their uv with the painted layers
  — the ghibli shaders carry `GG_SIZE` for the painted square and `GG_MAP_SIZE` for the
  ground field's. Widening the paintable region is a protocol change and a separate job.
- **The handset's terrain budget — *(2026-09-16, measured at `MAP_SCALE` 2)*.** Four times
  the land at the same resolution is four times the CPU, and it is a **rebuild** cost, not a
  frame cost: every
  vertex and every texel goes through the geography once per build and again on every
  `setTerrain`, `setLandscape` and painted pond. Measured on one node core, the terrain walk
  (region + height + shore bakes, the field's displacement, the physics heightfield and the
  water colliders) went **906 ms → 3625 ms**; on a handset that is seconds of blocked main
  thread at load and again on every drag, which is the user's standing *"very slow to load"*.
  So **extent is the same on every device and resolution is per tier**. `renderTier()` in
  `src/world/device.ts` is the one switch — module state, published by `start` beside the
  pixel cap, before the ground, the water or any bake is built, defaulting to `projection` so
  a test and a node script read the same world. A phone takes: the ground field at
  `FIELD_SEGMENTS_PHONE_ISLAND` **480** (a 1.67 u quad — still inside the **1.99 u** riser run
  `riserRun` gives at scale 2, measured height error **0.112 u** against 640's 0.066 u over
  250,000 land samples), the **shore** bake at 512² (1.56 u a texel, so the 1.5–3 u foam rim
  is one to two texels rather than two to four), the **region** bake at 128² (6.25 u a texel,
  and both its consumers smooth it further), and the physics **heightfield** at 256 (a 3.12 u
  cell, coarser than a riser, on a page that is usually a viewer — physics runs only on the
  simulating one). Measured after: **1944 ms**, 2.14× the public world rather than 4.00×.
  **Those trades were measured at `MAP_SCALE` 2 and are kept, but the field's one no longer
  binds — *(2026-09-17)*.** 480 is a CEILING, not a substitute: at 1.1 the projection itself
  cuts 352, so `fieldSegments` takes the `min` and a phone reads the projection's 352. A phone
  must never pay MORE than the projection for a map that got smaller, which is what 480 over
  440 units (a 0.92 u quad) would have been. The three texel trades still bind and are
  milder: 1.72 u a shore texel, 6.9 u a region texel, a 1.72 u physics cell. The numbers are
  kept rather than deleted because they are the measured budget for a bigger map and the
  scale has moved twice in one day; the field's ceiling starts binding again above 1.5.
  The **height** bake is deliberately NOT traded, and the reason is a kind and not a size:
  `ggGroundAt` is read per blade to seat it on the ground, so its error shows as geometry — a
  blade floating over a tread or buried in a riser — rather than as a soft edge. At 671 ms it
  is the biggest single item left, and it is the next lever if one is needed.
  **Nothing in the bakes runs per frame**, which is what makes the rest of this a load cost
  and not a budget: `bake*Texture` runs once in `ensureGhibli` (memoised on the first switch
  to the ghibli style), `rebake*` only inside `Ground.rebuild`, which only `setTerrain` and
  `setLandscape` call; the physics heightfield is rebuilt behind `TERRAIN_REBUILD_MIN_MS`; and
  `waterColliders` rides the scatter's collider cache keyed on `collidersVersion`. The frame
  loop's `ground.update` writes two uniforms.
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
- **Style is per world [D].** `src/world/style.ts` resolves one of two looks — `ink`, the
  shipped one and the only one the taste describes, or `ghibli`, a recorded user override
  (TASTE §9). It is pure: `sanitizeStyle` mirrors `scripts/world-build.mjs` exactly, and
  `readWorldStyle` takes `?style=` then `<meta name="refworld:style">` then `ink`. Each
  world's `worlds.json` entry carries the field and the build injects the tag ONLY for a
  world that asked, so the public html stays byte-identical. `src/main.ts` reads it once,
  beside the world's name, and hands it to `start`; `WorldHandles.setStyle` is the ONE place
  that moves the background, the ground's paper and mark ink, the three light colours, the
  cel switch, the ink composite, the prop palette, both shadow palettes and the water
  together — a frame half in one look is a bug nobody can name.
- **The cel lighting is a CHAINED injection [D].** `src/world/toon.ts` ports envpaint's
  `ghibliLightingGLSL` onto the stock three materials through `onBeforeCompile`, replacing
  `#include <opaque_fragment>` (the one point where `outgoingLight` and `diffuseColor` are in
  scope on basic, standard and physical alike). **It captures the hook already there and
  calls it first**, and suffixes `customProgramCacheKey` with `+toon-v1`, because half these
  materials already own their hook — the ground's terrace marks, the scatter's
  wind/nudge/variation stack, the character's deform → marking → eye chain, the egg's crack.
  So it is applied LAST, after `deform.attach` (which assigns rather than chains). Its noise
  helpers are uniquely named (`toonHash21`/`toonVnoise`/`toonFbm`): a duplicate definition
  beside the ground's `groundHash` fails the compile. One shared uniform set, so `uToonOn`
  flips the whole frame with no recompile. Two omissions from the port, both on purpose: no
  shadow-map term (shadow maps stay off — TASTE §2.4) and no per-material grain (grain is a
  post-process — TASTE §2.7).
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

*Partly shipped, 2026-09-15* (user ask: 100–200 players at once), ported from an instanced
crowd engine (red-reddington's "Where's Walter" — one `InstancedMesh`, shader LOD, amortised
per-frame updates, simulation in flat arrays). What transferred, and what did not:

- **Peer lookup is a spatial hash** (`src/physics/spatial.ts`). Each agent asks the cells
  around it rather than the whole cast; 2.8ms → 0.18ms a frame at 200 agents. The pair
  separation sweep stays all-pairs — ported, measured, byte-identical and slower, because
  twenty thousand tight numeric checks beat two hundred hashed walks.
- **Off-screen creatures refresh their presentation one frame in four**
  (`OFFSCREEN_STRIDE` in `src/creatures/manager.ts`): gait and emote springs, eyes, bubble,
  shadow stamp. The simulation still runs every frame for every creature — the host's
  positions are what every phone follows. The tour camera frames a small piece of a huge map,
  so this is most of the cast, most of the time.
- **Shadow stamps are one instanced draw call** (`src/world/shadows.ts`), instead of a mesh
  and a geometry each. Same flat value, same sharp edge.
- **Textures sized to what they cover**: egg shell 1024² → 512², world marking 512² → 256²
  (the phone portrait keeps 512). A manual world stands its whole clutch at once; at 200 eggs
  the shells alone were ~800MB of GPU memory.
- **Pixel ratio capped at 1.5 on coarse-pointer devices** (the phone's world view); the
  projection keeps 2.
- **`MAX_POPULATION` 96 → 256**, and a `spawn 200 (stress)` button with a live
  `frame · draw calls · tris · creatures` line in the ghost panel to measure against.
- **Not transferable**: the single draw call for the cast itself. Every creature here is a
  unique inflated mesh with its own marking texture and deform/eye uniforms; the reference
  shares one geometry across its whole crowd. `BatchedMesh` plus a texture atlas and
  per-instance uniform textures is the path if the projection still needs it, and it is a
  rewrite of `src/character/`, not a tweak.

#### the second pass, on the katamari world — *(2026-09-16)*

> User reports: *"at 200 characters right now, the page is glitching out, and it's very slow
> to load"*, then *"my character can't move now"*, then *"if the web page refreshes, the
> mobile view doesn't actually work and it gets frozen"*.

Measured with a headless harness (playwright + swiftshader, 200 synthetic drawings through
the real pure pipeline, thirty of them driven, on `?host=1` at 1280×800 and on a phone-tier
viewer at 390×844). Swiftshader is not a phone GPU, so the absolute frame times below are
only good for comparing against each other; the draw calls, the triangle counts and the
main-thread milliseconds transfer.

**The "glitching" was a crash, not a slow frame.** `stickItem` read the item's live rapier
transform AFTER `PropBodies.take` had removed its body, and a removed rapier body is a dead
handle: reading it traps the wasm module (`RuntimeError: unreachable`). That threw out of the
world's frame callback, so `requestAnimationFrame` was never re-armed and the page sat
holding the last frame it managed — which from a handset is every creature frozen where it
stood. Reachable on any population since `PICKUP_RATIO` went 0.6 → 1.0 made pickups happen
at all; reproduced at 60 creatures within seven seconds of the first one. The pose is
snapshotted before the take now, and `src/world/scene.ts`'s loop no longer lets one throwing
frame callback take the loop with it.

**The frame, in the order the profile ranked it:**

- **52% of the JS thread was `gl.getProgramInfoLog`** — three's `checkShaderErrors` calls it
  the first time each program is drawn, and it BLOCKS until the driver has linked, which also
  throws away the parallel compile a modern driver would do. 11.2 seconds of a 21.6-second
  window across the thirty-eight programs a katamari frame needs, all of it landing in the
  seconds right after the object library arrives: the *"my character can't move now"* report.
  It is off outside the vite dev server — `import.meta.env.DEV`, deliberately NOT `__IS_DEV__`,
  which `worlds.json` turns on for whole deployments — and `WorldHandles`' `warmPrograms`
  calls `renderer.compileAsync` after every rebuild that can introduce a material (the three
  library tiers, the one style switch) so the links happen together and off the first frame.
- **The ink chain ran five full-screen passes and needed four.** The overlay pass draws the
  speech bubbles, which detach themselves when they hide, so nearly every frame in a room was
  paying a full-screen render's traversal and submission to draw nothing. It now runs only
  when something is on `OVERLAY_LAYER`, detected in the walk the normal pass was already
  doing. With `autoClear` off and no background a pass with nothing in it writes nothing, so
  this is the same picture on every world.
- **A phone drew the props twice a frame.** `InkPass.setNormalPassSkip` is a caller's list of
  subtrees hidden for the normal target alone, and the phone tier registers the scatter group
  on a ghibli world. What the props contribute there is their own hatching and interior
  creases, neither legible on a 134-triangle prop at phone scale; the contour that reads comes
  off the DEPTH target, which is the beauty render's and untouched, and the ground behind a
  skipped prop fills the normal target where it stood so there is no hole to read. The
  projection registers nothing and draws both passes whole.
- **`Scatter.hideTaken`** — the incremental half of the taken filter. Every pickup called
  `setTaken`, which re-lays every InstancedMesh in the world from a filter over every
  placement plus a terrain sample per instance and per stamp (~250-330ms), and invalidated
  every `InstanceRef` the physics layer holds. It now blanks the one row and the one stamp,
  drops the collider cache and bumps `collidersVersion` — and deliberately not
  `rebuildVersion`, so nothing re-syncs. Monotone only: a key that would come back, or one
  with no row (a mark, a waterfall placement), falls through to a rebuild.
- **The prop field is read once per CHANGE, not once per frame**, and answers "nearest" off a
  spatial hash. `readProps` rebuilt 1,083 objects a frame and every agent then scanned all of
  them twice for one fact: 0.6ms + 6.1ms a frame at 200 creatures. `AgentPropField` is pinned
  against the linear scan over 2,000 random queries including exact ties.
- Two smaller ones, both byte-identical: `syncStuckColliders` returns before it allocates when
  the carrier holds nothing (four garbage objects per creature per frame), and
  `stepCreatures`'s pair-separation round re-seats only the bodies it displaced or that a
  sweep may have left inside something — pinned float-for-float against a reference that
  re-seats everybody.

| phone viewer, 390×844, library loaded | before | after |
|---|---|---|
| frame | 3002ms | 1404ms |
| draw calls a frame | 453 | 236 |
| triangles a frame | 2.67M | 1.32M |
| full-screen passes | 5 | 4 |

(The triangle drop is shared with the meadow going to 40% of its blades in the same pass.)

**The load is a worker now.** 200 creatures rebuilt from their drawings measured **57 seconds
of main-thread time**, mean 286ms each — the refresh report, and the egg is not the cost
(grown 260ms against with-egg 239ms). Deterministic does not mean "on this thread": it means
the same function on the same input. So `src/character/blueprint.ts` is the pure half of
`createCharacter` as one function — interpret, then inflate — importing `src/shape/` and
`src/inflate/` only, with every dial an ARGUMENT (`ovoid` included: it is a dev-panel override
in module state, so a worker reading its own copy would quietly build a different body).
`blueprint.worker.ts` is a message handler around it and nothing else; `blueprintPool.ts` is
`hardwareConcurrency − 1` capped at four, round robin, with three fallbacks to the main thread
(no `Worker`, a factory that throws, a worker that dies or answers nothing) because losing a
person's drawing to an optimisation is not a trade worth making. `CharacterOptions.blueprint`
and `SpawnOptions.blueprint` are additive — absent, the pipeline runs inline exactly as
before, which is what the phone and every live drawing on a quiet world still do.

Measured on the page, sixteen creatures each way: **294.8ms of main thread a creature inline,
33.7ms with the blueprint already built — 88.6% of it gone**, on a machine the pool sized at
three workers. At two hundred that is ~59 seconds of blocked main thread down to ~6.7, with
the pipelines running three-up alongside it. The rest is what a worker cannot take: the
BufferGeometry upload, the marking canvas, the stalk and the springs.

**And both ingest paths are one queue.** `src/moderation/ingestQueue.ts`: order exact
(pipelines finish out of order on purpose, the OFFERS do not — the gate's arrival number and
the session log's event order are what an operator's list, an eviction and a replay are built
on), nothing lost (an empty pipeline still offers, with no blueprint), and the frame handed
back on a budget rather than after a fixed count. The store's restore and the feed's own
arrivals both use it; the feed's mattered as much as the restore's, because the way a
refreshed projection heals itself is every handset in the room re-publishing at once.

**Two things measured and deliberately NOT done:**

- The remaining draw calls are one InstancedMesh per (kind, variant), and a call is a pair
  that got at least one placement — so the count is bounded by what is PLACED, not by the
  catalog. Measured off the pure placement: `ACTIVE_BUDGET` small/medium at 120/80 draws 217
  scatter calls, at 60/48 it is 170, at 32/24 it is 128, with the same 1,954 placements
  throughout. Cutting it is two numbers in `src/world/katamari/rules.ts` and a re-run of
  `scripts/katamari-curate.mjs --all --source <library>`; it needs the library, which is not
  in the repo.
- `FIELD_SEGMENTS` 320 → 160 saves 153,600 triangles a pass (~8% of the frame) and eats the
  steepest terrace creases: the field's steepest slope is 0.843, so a 1.6-unit riser over the
  middle 60% of its step is ~1.14 units of run, and a 2.5-unit quad is wider than the riser it
  has to draw. Measured height error against the authored field over 250,000 samples in the
  camera's core: max 0.155u at 320, 0.348u at 200, **0.443u at 160** — a quarter of a riser at
  the worst point. Rendered both ways at 1280×800 (the camera's drift put the two frames within
  0.1 world units of each other, so they compare): at 160 the ground's own terrace mark reads
  as a WASH rather than a drawn line, and the dirt path's edge loses its definition. The pixel
  diff is dominated by the grain and the blade field's own per-frame noise — a flat control
  crop differs nearly as much as the contour crop (mean 5.78 against 6.04 per channel) — so the
  picture is what decides it, and the picture says no. **320 stays.**

**The minimap absorbs the crowding.** This is where a busy world actually shows, so the
minimap does the work: **you** are `#080808` with the `#fb5429` ring, always distinct at any
zoom; everyone else is muted `#8e908d` and clusters into a single softer mark below a
distance threshold. The map stays legible because it never tries to distinguish other
players from each other.

#### a hundred creatures is a memory number — *(2026-09-17)*

> User report: *"i spawned 100 people and it crashed."*

**It did not throw and it did not leak. It grew.** Reproduced against the built `valiocon`
world off `vite preview` in a real chromium (swiftshader), three ways — a hundred
`__refworldCreatures.spawn(..., {grown:true})` calls with a hundred distinct synthetic
drawings, the same hundred as eggs hatching on a 100 ms timer, and the ghost panel's own
`spawn 200 (stress)` through the gate and the ingest queue — on the projection at 1280×800
and on a phone world view at 390×844, each left running 60-120 s after the last spawn.
**No `page.crash`, no `pageerror`, no `[refworld] a frame threw`, no context loss, no
climbing node or listener count, and `renderer.info.programs` settled back to 44 from a
148 peak.** What moved was the renderer process: **353 MB → 966 MB over a hundred spawns,
6.13 MB of process per creature.** A phone is killed somewhere around a gigabyte, and the
panel's stress path was at 847 MB by creature 90 and still climbing toward a
`MAX_POPULATION` of 256. `JSHeapUsedSize` never left 40 MB the whole time and says nothing
about any of it — every byte of this is `ArrayBuffer` backing store and canvas, which that
counter does not see. Sample the process, not the heap.

**Where a creature's bytes are.** Walked from the scene, per creature, before:

| | bytes | what |
| --- | --- | --- |
| body index | 934,944 | `Uint32Array`, 233,736 indices |
| body position + normal | 934,992 | `Float32Array`, 38,958 verts |
| topper index | 824,256 | `Uint32Array` |
| topper position + normal | 824,304 | `Float32Array` |
| stalk | 3,776 | the tube |
| `Character.analysis` | 1,310,720 | a 512² `Uint8` mask + a 512² `Float32` distance field |
| **total** | **4.83 MB** | ×100 = 483 MB of typed array |

**Two of those came off, and neither changes a pixel.**

- **`Character.analysis` is narrowed to `CharacterShape`** — the analysis minus its two 512²
  grids. Every reader of a grid reads it while the creature is being BUILT: `interpretDrawing`
  and `inflate` make them, `applyEyes` samples `headLobe` and `distance.max` once, `createTopper`
  inflates `source` through them, `createGait` wants one string off `archetype`. Nothing in
  `src/` touched `mask` or `distance` again — the comment said "kept for later modules (eyes,
  gait)" and the later modules had already had it. Same shape of retention as the blueprint
  leak f5fa81e fixed on the gate, and the fix is the TYPE, so the next line that wants a grid
  at runtime fails to compile instead of quietly pinning a megabyte per creature. **−1.31 MB
  a creature.**
- **The index is narrowed to 16 bits at the Three.js bridge.** `src/inflate/` still emits
  `Uint32Array` and must — its `MAX_VERTS` is 262,144 and the pure module's output is
  byte-identical on every device by contract (§6.3). But a real body is ~46k verts and a
  topper ~34k, both far under 65,536, and the index is the single widest buffer either
  carries. `toBufferGeometry` hands the renderer the narrow copy: the same integers, the same
  triangles, the same order, half the bytes on the JS heap and half again on the GPU.
  **−0.88 MB a creature, twice.**

**Measured after, same harness, same hundred drawings:** typed array per creature
**3.72 MB → 2.79 MB**, `arrayBuffers` at a hundred **507 MB → 289 MB**, and the phone world
view's renderer process **966 MB → 631 MB** (2.68 MB of process a creature, a 56% cut). The
hatch variant peaks at 765 MB and settles at 633 MB with all hundred standing.
`test/creatures/budget.test.ts` is the ceiling: a hundred through the real manager against
the stub world, no throw, and a per-creature byte and object budget sitting between the
before and the after so putting back either half fails on its own.

**Three suspects cleared, with numbers.** The manager's own frame is LINEAR — 0.183 ms at
25, 0.222 at 50, 0.564 at 100 — so the crowd-engine work above holds and there is no
O(n²) left in it. The blueprint is not retained anywhere: 507 MB of `arrayBuffers` at a
hundred accounts for the table above exactly, with the gate's decision log (capped at 40)
holding stroke lists only. And the frame guard never fired in any variant.

**What is still true and was NOT fixed.** A creature is **134,800 triangles** — body 91,232,
topper 43,424 — and at a hundred of them the scene holds **16.1M**, of which creatures are
96.7% (`ball` 9.66M, `topper` 5.93M against the ground field's 460,800). `DEFAULT_GRID_STEP`
is 6 and stays 6: its own header has the manifold table, and coarser steps hole the thin
spindly drawings people actually make. The remaining 2.64 MB a creature is the
position/normal/index copies that three.js keeps on the CPU after upload, and they cannot
simply be released with `onUpload` because **hover names raycast the creature meshes**
(`src/creatures/hover.ts`, `intersectObject(root, true)` per named creature per pointermove
— which is also 13.5M triangle tests a mouse move at a hundred named creatures). Freeing
them needs hover to raycast a proxy first. And `MAX_POPULATION` 256 is documented as a
frame-rate guarantee and is still not a MEMORY guarantee: at 2.68 MB of process a creature
the cap alone is ~690 MB over baseline, which no phone has. A tier-aware cap is the obvious
lever and is deliberately not taken here — a phone's memory limit deciding who gets retired
would put a population eviction in a page that is meant to decide nothing (§7.6), and
"support 100-200 players at one time" is a standing user ask. That is a ruling to ask for,
not to make in a perf pass.

#### the slow network — *(2026-09-16)*

> User ask: *"we need to be able to run this on a slow network on people's devices."*

Measured first, and the harness is `scratch/slow-network.mjs`: the built `valiocon` world
off `vite preview`, in a real chromium whose link is shaped by CDP
(`Network.emulateNetworkConditions`) at **1.5 Mbit/s down / 750 Kbit/s up / 150 ms** and
again at 5 Mbit/s, on the phone's world view (390x844, `isMobile`, a drawing already in the
handset's store) and on the projection. It records bytes transferred by type, the first
composed frame (`performance.mark('refworld:first-frame')`), the moment the player's own
creature is standing, and when each library tier attached. Under swiftshader the FRAME
times are a software rasteriser's and only compare against each other; the BYTES are exact.

**The baseline, phone world view at 1.5 Mbit/s: 5.55 MB over the wire and the library fully
attached at 50.4 s.** Four things paid for, in order of size:

| | baseline | after | why |
| --- | --- | --- | --- |
| object library | 4.06 MB | 2.97 MB | every glb `dedup`/`prune`/`weld`/`reorder`ed and `EXT_meshopt_compression`ed at curate time, **geometry bit-exact after decode** (docs/katamari-props.md), loaded with three's `MeshoptDecoder` (~30 kb, behind the katamari gate) |
| rapier | 0.76 MB | **0** on a handset | `physicsExpectedFor` (`src/world/device.ts`) — see below |
| app js | 0.60 MB | same bytes, cacheable | `manualChunks` in `vite.config.ts` |
| mqtt | 0.096 MB | same bytes, cacheable | the vendored file's name carries its content hash |

**And re-measured, same harness, same machine** (ms from navigation; swiftshader, so the
frame times are a software rasteriser's and only compare against each other):

| | first frame | creature standing | small | medium | large | library | total |
| --- | --- | --- | --- | --- | --- | --- | --- |
| phone, 1.5 Mbit **before** | 7837 | 9316 | — | — | — | 50392 | 5.55 MB |
| phone, 1.5 Mbit **after** | 7713 | 9183 | 16505 | 28327 | 35517 | 40760 | **3.68 MB** |
| phone, 5 Mbit after | 5647 | 7775 | 9573 | 17734 | 22508 | 26781 | 3.68 MB |
| projection, 1.5 Mbit before | 12383 | 13205 | — | — | — | 51404 | 5.50 MB |
| projection, 1.5 Mbit after | 12318 | 13109 | 19577 | 35597 | 52542 | 59729 | 4.37 MB |

Read that last row honestly. The projection's library COMPLETES later than it did, and the
deferral is why: the download used to start during construction and now starts on the far
side of the first composed frame, which under a software rasteriser is 12 seconds. The
number that is not an artifact is the download itself — 33 s for the library on the phone
against the baseline's ~49 s, which is the byte cut — and on a machine with a GPU the frame
it waits for is a fraction of a second. The trade is deliberate either way: the props are
the one thing on the page nobody is waiting for.

The per-tier columns are the staircase that was always there and could not be seen: the
field fills with cups at 16 s, benches at 28 s, cars at 35 s and the skyline last. ⚠️ The
first version of the harness read those marks BEFORE waiting for the library and reported
every one of them as null — a measurement bug that made a working staircase look broken.
Read the library's mark first.

**No quality was traded for any of it** (user ruling, 2026-09-16: *"I don't want to
compromise on quality"*). Nothing is simplified, nothing is dropped, no texture is resized,
and no page anywhere loads fewer models than any other: the levers are ORDER and CACHING.
Quantisation was measured (it would have been another 0.58 MB, at a worst position
deviation of 0.011 of a screen pixel) and **not taken** — `scratch/props-compare.mjs` has
the table and the two models whose normals and uvs it could not account for. The same
harness found a real bug on the way: `conformKatamariGeometry` read attribute arrays
directly, so any `KHR_mesh_quantization` model's uvs came through as raw unsigned shorts
and would have drawn the wrong texel. It de-normalises through the accessor now.

**Rapier never reaches a handset.** `@dimforge/rapier3d-compat` is 2.06 MB of javascript
with its wasm inlined, 760 kB compressed, ~4.1 s of a 1.5 Mbit link — and it was paid by
every phone testing alone in a room, because a phone alone on the link wins its own election
and becomes the host (`HostRole`, `src/main.ts`). `WorldHandles.enablePhysics()` now resolves
immediately on `renderTier() === 'phone'`, so the import is never reached, and the phone host
runs the game off the **pure resolve and the scatter's own colliders**: rocks and unrooted
props stand where they were placed, the resolve still blocks on anything over the carry
limit, and the sticky pass still decides and still says so as scene events (§7.6 — the
decision was always the event, never the body). The gate the creature manager read was
`bodies() !== null`, a sound proxy for *"this page is the host"* only while those two facts
arrived together; they no longer do, so it is two questions now (`deciding` / `rapierOwns`,
`src/creatures/manager.ts`) and every projection reads exactly the condition it did before.
What a phone host does NOT have is rolling stones and tumbling debris: a knocked prop lies
down where it stood. Pinned in `test/creatures/phone-host.test.ts`.

**Caching.** `vercel.json` serves `/assets/*`, `/katamari/models/*` and `/vendor/*`
`public, max-age=31536000, immutable`, and the html and `catalog.json` `must-revalidate` —
the rule being that a path gets the year if and only if something in it MOVES when its bytes
do. Three things had to be made true for that: three.js used to ship inside whichever async
chunk first reached it (it came out as `assets/minimap-<hash>.js`, a library unchanged since
0.180.0 wearing the hash of a file that changes every deploy), so `manualChunks` names
`three` and `rapier` by package; every model row carries a content hash
(`KatamariEntry.hash`) which the loader appends as `?v=`, so a re-curation can never serve a
stale model out of a year-long cache; and the vendored mqtt client is
`mqtt.min.<hash>.js`. `test/worlds/caching.test.ts` pins all three, including that the
vendored name still describes its own bytes.

**Load order, and nothing about content.** The library never blocked the first frame, but on
a 1.5 Mbit link it competes for it — 3 MB requested during construction saturates the
connection while the page's own remaining chunks are queued behind it. It now starts on the
far side of the first composed frame AND of the player's own creature standing
(`startLibrary` + `WorldOptions.libraryAfter`, `src/world/scene.ts`; `src/main.ts` passes
the gate). Frames and not timers, because a frame that has composed is a fact and a delay
in milliseconds is a guess about a machine — with one backstop, `LIBRARY_HOLD_FRAMES`
(90 composed frames), because this page's creature arrives over mqtt and a gate that never
opens must not cost the world its props. Tier order is unchanged and every tier still
loads: small → medium → large → building.

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

`RollingSurface` has since shipped as `ROLLING_SURFACE` in `src/world/surface.ts`, wrapping
the terraced terrain authored in `src/world/landscape.ts`. `FlatSurface` shipped alongside it
as `FLAT_SURFACE` and remains in use for the phone's character stage and for tests that want
a plane. `SphereSurface` is still open behind the same seam.

A curved horizon suits the world brief's pixel-planet reference well, and it interacts
nicely with §7.1: on a sphere, the camera tour becomes an orbit and dispersal is bounded by
the planet's surface area. P5, not P0.

### 7.3 Painted terrain (dev) — *(partly shipped)*

The geography stays **authored** (`src/world/landscape.ts`, hand-placed and fixed). Painting
is the one way a person adds to it, and it is a **dev** surface: the demo build never paints,
it loads. The port of EnvPaint's brush engine into this world is planned in
`envpaint/docs/port-meridian.md`; this section is what has landed and what has not.

**The hook.** `landscape.ts` gains exactly one new export, `setPaintedHeight(sampler | null)`,
and `terracedLand` becomes `terrace(field(x, z) + painted(x, z)) * farGate(...)`, where `field`
is `smoothField` in the landscape mode and 0 in the plain one — the mode gates the AUTHORED
geography, never a person's own hand, so the flat field the world opens on is fully paintable
and a painted hill survives the switch in both directions. That is what the toggle is for:
open flat, sculpt live. (`terrace(0)` is exactly 0, so an unpainted plain world is exactly
flat paper, and `terrainNormal` keeps answering straight up until something is painted.) The
offset goes in **before the terrace** so a painted hill gets the same risers the authored
relief has — the ink pass only draws elevation it can find a contour on, and painting after
the terrace would let a smooth ramp exist (TASTE §3) — and **before the far gate**, so painted
land settles onto the flat outer disc at the rim like everything else. It is **not** scaled by
the `elevation` dial [D]: the dials are multipliers on the authored geography, and a painted
unit is a world unit somebody put there by hand.

The hook lives in `landscape.ts` for the reason that module's header already gives for height
living there at all — heights come from one place, and a second place would be the second
shoreline in the height dimension. `terrainHeight`, `terrainNormal`, `waterLevel` and every
consumer are unchanged, and `Surface` stays two methods wide (§7.2): a painted map is a term
inside the one surface, not a second one. With no sampler set the world is the authored world,
pinned at 2,000 sample points in `test/world/painted.test.ts`.

**The map.** `src/world/painted.ts` — pure, importing nothing: a `Float32Array` of `res²`
world-unit offsets over a square `size` units across, centred on the origin (512 texels over
400 units, 0.78 u a texel). Bilinear between half-texel centres, exactly zero outside, fading
to zero across the last half texel so the rim never draws itself as a square contour. Its
array is deliberately **the same buffer** an `envpaint` paint layer stamps into, so a dab is
visible to the next height sample with no copy and no sync step. A second layer of the same
shape rides alongside it — `water`, one absolute surface level a texel — for the reasons below.
`serializeMap` / `deserializeMap` are base64 float32, ready for the committed map the bake step
will write.

**The skill.** `src/dev/paint.ts`, registered as `refworld.paint` and reached by a dynamic
import inside `initDevPanel`, so envpaint lands in its own dev chunk and never in the demo
build. Raise / lower / flatten / smooth on the height layer and pond / drain on the water one,
hotkeys 1-6, EnvPaint's tool strip while painting is on, EnvPaint's edge-shape defaults
(TASTE §2.5: no clean discs), and
ghost-panel's undo stack through EnvPaint's `History.attachUI`. Painting is off until a
checkbox says otherwise: the world keeps its own pointer, and even with painting on shift+drag
stays the world's pan. While a stroke owns the plain drag the world parks its own one-pointer
orbit (`WorldHandles.setSoloDrag`) — both listen on the same canvas and neither can out-order
the other, so the world lets go rather than the tool shouting louder.

After every batch of stamps the world re-cuts itself with `setTerrain({})` (ground → scatter →
water), throttled to ~8 rebuilds a second because one rebuild measures ~250-330ms, with one
guaranteed rebuild on `strokeend`. The rebuild is asked for from the per-frame dirty-rect
sweep rather than from the stroke events alone, so an **undo** reaches the world too: undo
writes the recorded rect back into the layer and marks it dirty without emitting a stroke.

**The water.** A second float layer, `water`, of exactly the same shape as the height one and
sharing its buffer with `PaintedMap.water`: one **absolute surface level** per texel in world
units, `DRY` (-1000) where there is none. `DRY` is duplicated on purpose — `painted.ts` imports
no brush engine — and `paint.ts`, the one module that sees both, asserts the two are equal at
startup. Two tools write it, through `envpaint/core`'s `writeLevelDisc` rather than a layer
stamp (a level is a value, not an increment): **pond** (hotkey 5; ctrl/cmd-drag erases, which
for water is a drain) and **drain** (hotkey 6). Spatter is forced off for both [D] — the rim
keeps its edge noise so no pond is a clean disc, but the droplets spatter throws would be culled
texel by texel a moment later, which reads as the brush fighting itself.

A stroke fills to **one level**, chosen once and held for every dab: a body of water is a plane,
and a level read fresh under each dab would tilt the sheet with the ground it crossed. Start
inside water already painted and the stroke takes that body's own level, so widening a pond
extends it instead of laying a second sheet against its bank. Start on dry land and it takes
the mean untouched bank around the dab (`bankHeight`, so a stroke cannot ratchet its own level
down over the basin it has just cut) minus `basinDrop × elevation` — which is exactly how an
authored body picks its own level in `waterLevel`. The level itself is then absolute: no dial
ever multiplies it again, for the same reason the painted height offset is not scaled.

`deriveWater` (`src/world/painted-water.ts`, pure) turns the layer into geography. It labels the
water's **8-connected** components, culls the ones under `MIN_BODY_TEXELS` back to `DRY` (a
twelve-texel speck is spatter, not a lake that deserves a shoreline and reeds of its own), fills
enclosed **4-connected** land components under `MIN_HOLE_TEXELS` with the water's level (a
pinhole is a gap in the paint, not an island), levels every body to **one plane** — the lowest
of the levels that ran together, because water finds the lower basin — and then builds an
**exact** Euclidean distance field (Felzenszwalb–Huttenlocher, not a chamfer: the zero contour
of this field is the shoreline every other system reads, and a chamfer's error is anisotropic
enough to draw flat-sided diagonals). The rings come off that field by marching squares with one
Chaikin pass, counter-clockwise, in the same convention as `waterOutline` / `islandOutline`. It
**mutates** the level layer as it goes, which is the point: the layer somebody paints and the
layer the world reads are one array, so the tidying has to be visible in the paint.

The field is installed on the geography through `setPaintedWater` in `landscape.ts` — one hook,
the same shape as `setPaintedHeight`, and in that module for the reason its header already
gives: heights and **shorelines** come from one place, or they drift apart by a fraction of a
unit between the ground, the physics and the reeds. `terrainHeight` cuts the basin from the
field with the **authored basin's maths verbatim**, `-shore` standing in for the distance
outside a wobbled radius: the interior comes out exactly the level, `basinRim` holds the first
units of bank at the waterline, and the land climbs out over `shoreRamp`. One pass over the
whole field rather than one per body, because the field measures the *nearest* shore. Like the
painted height offset it is a person's own hand and **not gated by the mode**: painted water
exists in `'plain'` and `'landscape'` alike, which is what makes "open flat, paint a pond in
front of the audience" work at all.

From there everything downstream is the machinery the authored ponds already had. `water.ts`
rebuilds `paintedGroup` on every `setPainted` — flat fills with the islands punched out as
holes, drawn shore ribbons walking those very arrays so grey and ink coincide by construction,
and ripple marks on the authored ripples' own material and `uTime`. Scatter's `place()` refuses
water, so props inside the new shore go, and the reed walk lines `paintedShoreSamples()` as one
more body. `waterColliders()` tiles hexes over each body's bounds and keeps the ones the
distance field says are wet — an island falls out for free, because `shore` is negative on land
inside a body. So a water stroke ends with the **landscape** rebuild (ground →
`scatter.refreshLandscape()` → water levels), not the terrain one: a pond changes what grows
where, while a height stroke only moves what is already standing. The **minimap** does not draw
painted bodies yet — it still shows the authored map only.

**Shared and stored.** A dab is not a private edit: the operator sculpts in front of the room
and every phone is running its own copy of this same page. So each stamp, the landscape switch
and the three terrain dials travel as ordinary session events — over the world sync topic to
every open page, and into `refworld:<world>:scene` so a redeploy does not throw the evening
away. Every page applies a foreign one through the replay driver it already had; there is no
second apply path, and nothing on the wire can move the ground in a way a recorded log could
not. `src/session/scene.ts` is the pure half (which kinds, what a batch may say, how a long
session compacts), `src/net/sceneoutbox.ts` batches the outgoing side, `api/scene.ts` keeps it.
See **docs/SESSION.md §6** and **docs/PUBLIC.md §the scene**.

**Deferred**, in the order the port plan takes them: painted **forest / mountain / clearing
weights** for scatter; and **recording, saving and baking** — the `paint` session event per
stamp, a "save map" button, and a committed `map.json` the deployment loads (the level layer is
already in `serializeMap`, and a map saved before water existed loads dry). `src/dev/paint.ts`
carries one marked hook comment where the session event goes.

### 7.4 Painted planting (dev) — *(shipped)*

2026-09-09, user ask: *"in the collection we should have brushes for trees, rocks, grass,
flowers, rivers, clouds, ponds, etc."* — the operator paints the world live in front of an
audience, so what a brush puts down must be **deterministic from the painted data**: same
painted layers → identical placements on every device, no `Math.random`, no clock.

**The layers.** `src/world/painted.ts` gains `planting`: one `Float32Array` per brush
(`mask`, `path`, `grass`, `flowers`, `trees`, `rocks`, `clouds`), weights in [0,1],
`PLANTING_RES` 256 over the same 400 units — 1.56 u a texel **[D]**, finer than the 6 u
scatter step so a stroke's edge falls between cells, and a quarter of the height map's memory
because there are seven of them. Same sampler recipe as `height`: bilinear between half-texel
centres, exactly 0 outside, fading over the last half texel. Same buffer-sharing rule: the
arrays **are** the brush's paint layers'. `serializeMap` / `deserializeMap` carry them, and a
map written before planting existed still loads.

**The seam.** `setPaintedPlanting(sampler | null)` beside `setPaintedHeight`, and
`sampleLandscape` gains `planting: PlantingWeights`. All zero when nothing is installed, so an
unpainted world is byte-identical to the shipped one — pinned in `test/world/planting.test.ts`.
It answers in **both** landscape modes, unlike the authored fields: the mode gates the map, not
a person's hand, and painting the flat field is the point of opening on one.

**The roll.** `scatter.ts` keeps its own rolls exactly as they were and adds a **second,
painted pass** over the same cells, on its own salt family, in which every kind rolls
independently and no kind claims the cell from another:

```
base'(kind) = base(kind) * (1 - planting.mask) * (1 - planting.path)
paint(kind) = Σ_brush planting[brush] * PAINT_SEED[brush][kind] * user * (1 - planting.path)
```

The separation is the whole guarantee. The base loop stops at its first hit, so if the painted
weight rode inside it a stand could out-roll a rock in a cell the rock already held and the
rock would **vanish** — painting would read as reshuffling the world rather than adding to it.
The painted pass is skipped entirely on an unpainted cell, which is every cell of the shipped
world. `PAINT_SEED` is the mix per brush (a `trees` stand is mostly one crown build plus
conifers, undergrowth and tick texture); `mask` and `path` name no kind.

**The path is drawn, not built.** It is the one planting layer the GROUND reads: no geometry
moves and no material is added — `src/world/ground.ts` takes the brush's own `DataTexture`
through `WorldHandles.setPaintedPath` and inks the trail in the same fragment injection that
draws the terrace lips, from the sampled weight and the pen's own wobble. Its rim is a line the
noise breaks gaps in and its tread is stipple with paper between the specks, because TASTE §2.5
will not have a ruled edge on this map and §2.3 wants the field breathing. The demo build binds
a 1×1 empty texture and never installs a layer. It is also the one brush that suppresses the
**painted** term as well as the base one: a mask opens a glade and leaves a painted grove
standing in it, a path is ground nothing stands on at all.

**Rebuild cost.** A planting stroke moves no vertex, so it rebuilds the **scatter only** —
`WorldHandles.refreshScatter` (re-roll + re-instance) rather than `setTerrain({})` (re-displace
the ground field, re-normal, re-seat, re-level water). Measured in a headless chromium on the
plain field: **~31–39 ms scatter-only against ~65–78 ms full**. The throttle is shared with the
height tools and the flag is sticky — if any dab in a coalesced burst was a height dab, the
burst owes the full rebuild.

**The brushes.** One tool per brush on the existing Brush, stamping `add` and erasing with
ctrl (weights clamped to [0,1] over the layer's dirty rect — the layers are float and
unclamped by construction), at `strengthScale` **7**: a planting dab writes a WEIGHT that
`PAINT_SEED` then multiplies by ~0.3, so at the engine's own scale a whole pass asked for a 4%
chance per cell and planted nothing (2026-09-10, user report: *"the brush tools aren't
working"*). `[` / `]` step the radius through **this** world's 0.5–40 range (EnvPaint's own
handler clamps at 12 and would stop responding over most of the field) and the brush opens at
**radius 3 u, strength 0.28** — EnvPaint's own numbers. **Shift inverts** every tool — raise ↔
lower, add ↔ erase, fill ↔ drain, smooth and flatten unchanged — applied before the session
event is written, so a replayed or synced dab lands the same result without knowing about a
modifier. Shift was the camera escape; it moved to **space+drag**, the **secondary button**
and **two fingers** (the last was always true — the world's pinch path ignores `setSoloDrag`).

**The strip** is EnvPaint's, exactly (2026-09-10, user ask: *"i want to match the brushes for
env paint exactly"*) — same ids, same order, same groups, same hotkeys, and EnvPaint's own
`toolIcon` glyphs, which resolve because the ids match. `src/dev/paint-tools.ts` owns the
tables; `src/dev/paint.ts` registers them in that order and the `.ep-strip` rules are inlined
there because `envpaint/ui` does not export its stylesheet.

| tool | key | group | writes | state |
|---|---|---|---|---|
| sculpt | `0` | ground | `height` (raise; shift/ctrl lower, alt smooth) | shipped |
| mask | `9` | ground | `mask` weight — suppresses the world's own seeding | shipped |
| path | `8` | ground | `path` weight — inked as a dirt trail, and nothing grows on it | shipped |
| grass | `1` | paint | `grass` weight | shipped |
| comb | `2` | paint | `comb` direction layer — grass and ticks lean at placement | shipped |
| flowers | `w` | paint | `flowers` weight | shipped |
| pond | `3` | paint | `water` level (shift/eraser drains) | shipped |
| river | `4` | paint | `water` level carried downhill, and a light carve (shift/eraser drains) | shipped |
| waterfall | `5` | paint | an ink mark on the painted map's `marks` list (shift/eraser removes the nearest) | shipped |
| trees | `6` | paint | `trees` weight | shipped |
| rocks | `7` | paint | `rocks` weight | shipped |
| fire | `f` | paint | `fire` weight — burns across painted grass, leaves scorch | shipped |
| clouds | `c` | paint | `clouds` weight | shipped |
| eraser | — | end | toggles the current tool's opposite (what shift holds) | shipped |
| home | — | end | slides the camera to the default view (`CameraRig.resetView`) | shipped |

**The comb, and fire** (2026-09-10, user ask: *"the brushes should have real world physics
as well just in the style of ref world"*). Two more layers beside the seven weights, neither
of them a planting brush because neither names a kind.

`comb` is a TWO-CHANNEL direction layer at `PLANTING_RES`, written by EnvPaint's own
`direction` stamp mode (`dir * 0.5 + 0.5`, neutral 0.5) and serialised beside the rest; a map
written before it loads uncombed, because a zeroed buffer decodes to no comb rather than to a
lean (src/world/comb.ts spells out why that case is special). It is read AT PLACEMENT — this
world's grass is instanced ink marks, not a GPU blade field, so the lean is a transform on the
instance matrix: the mark's yaw turns to the combed heading and the tuft tips by the vector's
magnitude, capped at `COMB_LEAN_MAX` (~26°) so blades stay readable. Deterministic in the
layer. The dab records its heading (`dx`, `dz` on the paint event) because nothing at replay
time could recover it.

`fire` is a weight layer whose MEANING is `src/world/fire.ts`'s `burnState` — pure, the way
`deriveWater` is what a level layer means. From each painted texel a front advances across
contiguous painted grass at a fixed rate in texels a second, biased along the wind; a texel
burns for one ambient beat and is scorch afterwards, and grass under scorch is consumed (its
weight reads 0 at placement, so the tufts are simply not placed). **Nothing spreads beyond
painted grass.** The clock is the session's: each fire texel carries the `t` of the stamp that
lit it, so `elapsedMs` is the same number on every screen and no two of them simulate
separately. Burning cells place a **flame** mark — a new ink mark kind, three wavered strokes
and a spark, on the same instanced mark path as the grass, flickering only through the tick
wind profile's slow smooth gust (TASTE §2.1: no pop). Scorch is drawn by the GROUND, bound
like the path texture and mixed toward `SURFACE.ink` and no further (TASTE §1). The world
frame drives a throttled re-evaluation (`FIRE_TICK_MS`, ~4/s) and re-rolls the marks only when
the burning SET changes.

**The river** is the pond's machinery with a level that can only fall. Each dab carves a little
channel (a `sculpt` `lower` dab, recorded as one, so a replay carves through the path that
already exists) and then fills to the plane this stretch of the stroke belongs to: the bank
around the dab less `basinDrop`, taken as a **running minimum** and bounded by a gradient so it
cannot chase the basin it has just cut. A dab inside water somebody else painted takes that
body's plane — a river reaching a pond joins it.

A river is a **chain of pools**, not one sheet [D]. `deriveWater` levels every texel of one
connected body to that body's own plane (lowest wins), because in this world a body of water
*is* a plane — so a continuous ribbon from a hill to a valley would flatten to its lowest dab
and the ground would cut a canyon the length of the stroke. Where the running level has fallen
by a real step, the stroke drains a short **riser** across itself: the run above and the run
below derive as two bodies, each at its own level, and the river descends the way water in a
plane-surfaced world has to. The riser is also exactly where a waterfall mark belongs.

**The waterfall** writes no layer at all. It appends `{ kind: 'waterfall', x, z, seed, yaw }` to
`PaintedMap.marks` (serialised beside the layers; a map written before marks existed loads with
none), and `src/world/waterfall-marks.ts` draws it — vertical hatched falling lines with splash
ticks at the foot, two authored variants, through the same instanced mark path as the grass
tufts and the reeds. The facing is read down the local gradient through the `Surface` seam and
**recorded**, like a pond's `level`, because the ground it came off may have been sculpted by
the time a log replays; the span is the surface at the lip less the surface one run downhill.
One mark a stroke. Automatic placement across a riser is *not* built.

A tool that is *coming* sits in its place holding its key, disabled, tooltip `coming`:
the strip is the picture of the whole kit and a gap in it would be a different kit.
`layerForTool` refuses its id exactly as it refuses any id it does not know.

While painting is **on**, a capture-phase handler swallows the strip's keys before the emotes
and before EnvPaint's own window binding; with painting **off** it returns on its first line
and 1–7 emote as they always did (§6.3). Keys the strip does not claim are never swallowed.

**Renames, and the scenes written before them.** `raise` → `sculpt`, `grove` → `trees`,
`clearing` → `mask`; `lower`, `flatten` and `smooth` left the strip (flatten entirely, the
other two are modes of `sculpt`), `drain` left (the eraser and shift are what it was), and
`cottages` left with its weight layer — EnvPaint has no cottage brush, and the scatter's
dooryard path stayed, generic, for whatever plants a building next. A stored scene or session
log still applies: `paint-tools.ts` `LEGACY_TOOLS` maps each retired id to its replacement —
and, where the id was the only thing saying what the dab DID, to the mode as well (`drain` is a
pond dab that erases). The translation happens once, at the replay seam, so the live brush, the
replay and the sync all route the same way (docs/SESSION.md §4).

---

### 7.6 Physics and the sticky world — *(shipped 2026-09-15)*

> User brief, 2026-09-15: *"the world should feel increasingly unstable as creature mass
> grows. creatures collide with props, knock them over, get them stuck to themselves, stick
> to EACH OTHER, carry debris into other objects, and grow into a pile. first ten seconds
> cute, last twenty out of control."*

**`src/physics/world.ts`** — one rapier world, one fixed 1/60 step behind an accumulator, one
heightfield terrain collider resampled from the Surface seam (§7.2) and nothing else deriving
a height. Restitution is **0 everywhere**, including on the ground: a bounce is forbidden at
confidence 1.00 however small, and rapier's own default would have put one in. The wasm is a
dynamic import, so it is a chunk of its own and the first frame never waits on it.
`FIX_INTERNAL_EDGES` on the heightfield is not cosmetic — without it a body rolling across a
cell boundary is kicked through the field. `setHooks` installs the one contact-pair filter
(see below); `step` hands back the frame's contact events, reusing its array.

**`src/world/rocks.ts`** — the bridge between rapier and the scatter's instanced draw. Every
scattered `rock` gets a dynamic body whose collider is the **convex hull of the shape on
screen**, so a stone beds down on a face instead of rolling forever like a ball; every hard
prop gets a fixed cylinder. Identity is the **placement key**, never the live position, so a
stone shoved twenty units downhill survives a `scatter.rebuild()` where it stands.
`writeRock` pushes each body's transform back into its instance row, and a struck tree's
recoil rides the same mesh's `aBend` through a ζ≥1 spring. Three additions for the katamari:
`loosen(key)` knocks a rooted prop out of the ground (fixed body out, `setTaken`, dynamic hull
body in), `restore(...)` puts a dropped item back as a free body, and `onSettle(cb)` fires when
a body that had been **moving** comes to rest — rate-limited to one per item per
`MOTION.secondaryMs` and only past `SETTLE_REPORT_MIN_MOVE`, so a field of four hundred
sleeping stones reports nothing.

**`src/world/wind.ts`** *(undocumented until now)* — one pure, seeded gust field, sampled in
TS and mirrored in GLSL (`WIND_FIELD_GLSL`) so the CPU and the vertex stage agree about where
the wind is. It has no clock of its own: time arrives as a uniform. The scatter bends its
swaying kinds by `aWindHeight` (roots pinned, crowns sway), small stones skitter in a strong
gust, and the environment engine glides the strength through a spring — so weather reaches the
grass and the stones through the same field rather than through two.

**`src/creatures/sticky.ts`** — PURE. The whole game: `STICKY`, a row per `PropKind` giving a
tier, whether it is rooted, what impact frees it and what impact shakes it off;
`decideContact` returning `block | loose | shove | stick`; `growth` as a cube root of
accumulated volume; `clumpLocalOffset`/`clumpLocalRotation` for where an item sits on a pile;
`rollAxis`/`rollDelta` for the no-slip roll. Impact is `speed × radius` — linear in size, not
a real momentum, because cubing it means a big creature flattens a forest by standing near it.
Every number in the file is **[D]**: the taste briefs say nothing about a katamari, so none of
it is attributable to them.

**`src/creatures/clump.ts`** — the pile as a `Group` hung on the creature **ROOT**, never on
`character.group`: the body is deformed in a vertex shader and its local transform is rewritten
every frame by the gait, so anything parented under it would be squashed and bobbed along.
Each item is seated at a clump-local offset and rotation and **slides** into that seat over
`MOTION.secondaryMs` on a ζ≥1 spring per axis — entrances slide, there is no `scale: 0 → 1`
path in this project. The group accumulates a world rotation from the carrier's own *resolved*
displacement, so a pile pinned against a trunk stops turning instead of spinning on ice.
Growth is applied to the root's uniform scale, which carries `bodyR`, the resolve radius, the
pickup reach, the shadow stamp and `positions()` — and so the scatter's exclusion radius —
in one write. **Speed is deliberately unchanged: this is a katamari, bigger is not slower.**

**Rolling — the creature *is* the ball** *(2026-09-16)*. User ask: *"like Katamari Damacy, we
should have the character ROLL versus walk. Right now, the walking cycle is way too slow."*
The pile already rolled and the body slid along beside it, which read as a creature *pushing*
a ball. So in a **`game: 'katamari'`** world the manager reparents `character.group` into
`clump.group` — the one node that accumulates the no-slip roll — inside a wrapper named
`ball` at local `(0, -baseR, 0)`. Since the clump already sits at `(0, baseR, 0)` on the root,
the net local offset is zero: the body stands exactly where it stood and now turns about its
own middle, with eyes, stalk and topper turning with it. Heading stays on the root, untouched;
the clump's `inverse(root.quaternion) × worldQ` already composes the two. The **gait is off**
there (fed 0, so the amplitude spring never leaves rest) — a waddle on top of a roll is two
locomotions at once — while `character.update`'s ambient drift floor keeps running underneath.
Roll accumulates from the *resolved* root displacement on the host and from the *eased* follow
displacement on a viewer, for every alive creature whether or not it carries anything; a
passenger rolls with its carrier's ball, because a carried creature is out of the movement
pass entirely. **No roll phase is on the wire** (`poses` carry x/z/heading): roll is arc length
over radius, so every page derives the same turn from the same travel.

**Walk first, roll with mass** *(2026-09-16)* **[D]**. User ask: *"let's have them start
walking at first and once they hit a few objects they begin to roll because they have mass."*
The gait used to be fed a flat zero on a katamari world, so a hatchling that had picked nothing
up slid across the field like a decal. It is a BLEND now — one ζ ≥ 1 `Spring` per creature over
`MOTION.primaryMs`, retargeted every frame at `rollTarget(items, growth)`: 1 once the clump
holds `ROLL_MASS_ITEMS` (**3**) or `growth` reaches `ROLL_GROWTH` (**1.08**), whichever comes
first, and back to 0 if the pile is shed. Three things read it, and the whole point is that they
move together:

- the **gait amplitude** target is scaled by `1 − blend` (`setLocomotion`'s third argument, a
  new optional `gaitAmp` on `Character` and `GaitController`): the step frequency still follows
  the real travel, so a creature becoming a ball stops waddling rather than being told it has
  stopped moving, and one that sheds its pile picks the walk up mid-stride;
- the **roll accumulation** is scaled by it (`Clump.roll(dx, dz, blend)` scales the ANGLE, not
  the travel, so the axis is unchanged): at 0 the `ball` node stays upright, at 1 it is the
  no-slip roll it always was, and in between the same distance turns it partly — no snap;
- the **drive ceiling** lerps `MAX_SPEED × KATAMARI_WALK_MUL` → `MAX_SPEED × KATAMARI_SPEED_MUL`
  by it (`driveMult`), so a hatchling drives at 3 u/s and the same creature three stones later
  drives at 7.2. The wander does NOT lerp: an agent always walks (see **Speed** below).

A **passenger rides its carrier's blend** (`rollOf` walks up the carriers): a creature sitting
on a pile has no locomotion of its own — it is inside somebody else's ball. And **nothing about
the blend is on the wire**: it is derived in `growPass`, which runs on every page, from the
clump's own item count and growth — both of which a viewer holds off the `stick` and `drop`
events. `CreatureManager.rollBlend(id)` and `driveCeiling(id)` are readouts for the panel and
the tests; nothing sets either.

**Speed** — two ceilings, both **[D]**, both katamari-only *(raised 2026-09-16 on the user
report: "we need to up the speed and velocity by a lot")*. `KATAMARI_SPEED_MUL = 6` is the
ROLLING ceiling — `MAX_SPEED × 6` = **7.2 u/s**, which crosses the ~100 u island in fourteen
seconds instead of thirty — and `KATAMARI_WALK_MUL = 2.5` is the WALK ceiling, **3 u/s**, what a
creature carrying nothing drives at and what every agent wanders at. The wander sits at the walk
and never at the roll: an unattended creature crossing the island at 7.2 u/s is a world running
away from the person watching it. Both are *different defaults*, not factors on the shipped
`WANDER_SPEED_DEFAULT`. `KATAMARI_TURN_TAU_MS = 60` (from 90) because at 7.2 u/s a 200 ms
heading lag is a metre and a half of sliding; it is still `followFraction`, monotone and unable
to overshoot. The substep guard still covers it: `stepCreatures` clamps dt at 250 ms and
advances `MAX_STEP_TRAVEL` (0.25 u) per substep over at most `MAX_SUBSTEPS` (16), so 4 u per
frame; 7.2 u/s × 0.25 s = 1.8 u, eight of the sixteen, with 0.25 u still well under the smallest
footprint on the map (a 0.5 u stone) so no substep can leap a collider — nothing needed raising.
The ghost panel's wander/speed slider opens on `CreatureManager.wanderSpeed()` (the rolling
ceiling) with its max at 8 and scales the pair. **Every other world keeps its walk cycle and its
speeds.**

**The stick's strength is the push** *(2026-09-16)* **[D]**. User ask: *"we should assign speed
velocity to the joy stick so the farther the push the faster the character goes."* It nominally
already was — `driveVx = driven.x × ceiling` and `driven.x` carries the magnitude — but two
things stood between the thumb and the speed. `stickVector` rescaled the strength onto the
well's RIM while the knob stops at `KNOB_TRAVEL` (half the radius), so a thumb pushed to where
the control visibly ends was asking for 0.44 and the rest of the range lay outside the control;
the rescale now ends where the knob does, and thumb and knob travel together. Then
`DRIVE_CURVE = 1.6` in `driveResponse`, applied in `stickToWorld` (the seam where a thumb becomes
an intent, so the knob keeps following the finger one-to-one): half a push is a third of the
ceiling, a quarter push a tenth, and the stop is still exactly the ceiling. `f(0) = 0`,
`f(1) = 1`, monotone — no cut anywhere. The wire is unchanged and carries the magnitude to three
decimals (`src/net/worldsync.ts` clamps, never normalises), and the recorder quantises only its
CHANGE detector, never the value it writes.

**`PICKUP_RATIO` 0.6 → 1.0** *(2026-09-16)* **[D]**. User report: *"I don't see the sticky
katamari effect where the character gathers objects as it touches them."* A hatchling measures
~0.9 u, so 0.6 capped it at ~0.54 u while the smallest thing on the map is a ~0.5 u stone and
the scatter runs to 1.7 u — there was no first rung, so the growth curve never bootstrapped.
1.0 is also the reference feel: you roll up things about your own size.

The ladder it produces, for a 0.9 u hatchling at the katamari top speed of 3.6 u/s — and with
the priority rule below, the first column is now what a prop's own footprint has to be under,
not what impact it takes: **at spawn** anything up to 0.9 u sticks (the small stones, the
bushes, the stumps); **3 stones of r 0.9** put it at `bodyR` 1.11, where impact crosses 4 and a
tree too big to carry can still be felled; **4** reach `bodyR` 1.2, **11** reach 1.5 — the
radius at which a full-sized tree is simply taken whole; **41** reach `bodyR` 2.22 and impact 8,
the monolith tier; **75** reach 2.7; **109** reach 3.06 and impact 11, where a monolith bursts
instead of coming up. (With smaller r 0.7 stones the same rungs are 9, 23, 35 and 158.)

The same limit decides a passenger, so two creatures of equal size are each eligible to carry
the other — that tie goes to the **bigger id**, a property of the two creatures and of nothing
else, so two pages build the same pile. The pickup overlap test reads the *growth-scaled*
`bodyR`, the same number `clump.R()` rolls on.

**The character has priority** *(2026-09-16)*. User ruling: *"The user's character has
priority; objects should stick to it as it moves or rolls over the object. It shouldn't impede
the character from moving unless the mass isn't big enough to overtake the object."* So
`decideContact` asks about SIZE FIRST and rootedness second: an item inside `carryLimit`
sticks whether it is planted or loose, with no impact threshold to clear; above the limit an
unrooted thing is `shove`d (never a block — a stone you can move does not stop you) and only a
*rooted* one `block`s, where the old ladder (`shatterStrength` → `break`, `breakStrength` →
`loose`, a building's cumulative `stages`) still lives unchanged. `stickiness: 0` still means
never, so the cloud is never worn.

Three seams carry that through the runtime. The pure resolve takes a per-body predicate,
`StepOptions.skipIf(collider, index)` → `HardOptions.skipIf`, honoured by the integrate pass
**and** by the post-separation backstop (a collider skipped on the way in and enforced on the
way out would shove the creature back off what it just rolled onto); the manager answers it
with `collider.r <= carryLimit(slot.bodyR)`, per creature, so the same sapling still stops a
hatchling. The soft slowdown (`SOFT_SPEED_FACTOR`) is likewise not applied to a bush inside
the limit — that factor is a bush resisting, and a bush about to be worn has nothing to resist
with. And because a skipped collider produces no correction and therefore no `onContact`, the
manager gathers those roll-over contacts itself, from the same `gatherNear` set it already has.
Then `uprootOntoPile` takes the placement, draws it through the loose layer at the pose it was
standing in and seats it: **one `stick` event, no `loose`, no round trip through the ground and
no recoil flinch.** Uprooting something smaller than you costs nothing. On the rapier side the
contact-pair filter is extended the same way — creature ball vs a fixed prop inside the limit
returns `null`, using a new `PropBodies.sideByCollider` (the impact seam's own lookup, made
public). A carrier's STUCK item colliders are deliberately not exempt: a swinging bench has to
go on hitting everything, which is where the brief's instability comes from.

Both halves are gated on `game: 'katamari'` **and** on physics being loaded: a page that
cannot pick the prop up must not walk through it.

**"my character got stuck" — three causes** *(2026-09-16, user report from a phone on
`valiocon`, then a second report off the deployed build)*. All three are fixed and pinned by
`test/creatures/stuck.test.ts`, which drives a hatchling from six spawn points in eight
headings over the real island and the real scatter — once through the pure resolve and once
with a real rapier world under it — and asserts it never covers less than 0.05 u in any 1.5 s
window while driven, unless something rooted and above its carry limit is holding it, in
which case a 90° heading change has to free it inside 1.5 s.

- **A creature was being CARRIED, and a passenger's drive was thrown away.** `PICKUP_RATIO`
  is 1.0 and it decided passengers too, so two hatchlings of equal size were each exactly at
  the other's limit: the first contact made one of them luggage and its stick went nowhere.
  **`CREATURE_CARRY_RATIO` = 1.35 [D]** now decides a creature (`creatureCarryLimit` in
  `src/creatures/sticky.ts`): a carrier needs `bodyR ≥ 1.35 × other.bodyR`. Both directions
  cannot hold at once, so the mutual-eligibility tie — and the bigger-id tiebreak that broke
  it — is gone; equal-sized creatures separate as they did before the katamari. A prop is
  unchanged at 1.0: a prop has no phone, and taking somebody's creature out of their hands
  needs a visible size gap. **And a carried creature's drive is no longer ignored** — it is
  summed with its carrier's own and applied to the CARRIER, clamped to one stick's
  magnitude, so every phone in a pile still steers the ball. The wire is untouched: a
  recorded `drive` still names the passenger and the manager resolves it to the carrier at
  apply time, on the host and on replay identically.
- **The first stone anybody rolled up killed the host's frame loop.** `take` removes the
  stone's rigid body, and the pickup then read that body's translation — a removed rapier
  body is a dead handle and the read traps the wasm (`RuntimeError: unreachable`). The throw
  came out of `update()`, so the projection stopped simulating: no more poses, and every
  creature in the room froze where it stood. The pose is now snapshotted as seven plain
  numbers BEFORE the take (`poseOf`, `stickItem`). This is the one that needed rapier to
  find, which is why that half of the test exists.
- **The rigid-body stand-ins were a frame behind the growth.** `growPass` writes `bodyR` and
  the drawn scale; the kinematic ball and the stuck-item balls were sized at the end of
  `simulateSticky`, a few lines earlier, so a creature that ate something spent a frame with
  a solver ball smaller than the circle the resolve was using. `syncStandIns` now runs after
  `growPass` — one radius everywhere, every frame.

**Relaxed, because being stuck is a physics feel and not only a bug** *(2026-09-16, third
report: "My character keeps on getting stuck on objects, and once it sticks to an object, it
can't move. I think we can relax the actual physics a little bit so that it's a bit easier to
pick up momentum and pick things up to your character")*. All four are **[D]** and all four are
katamari-only; every other world keeps the physics it shipped with.

- **Blocking is the exception.** `BLOCK_RATIO = 1.6`: a rooted prop only `block`s when its
  radius is over `1.6 × carryLimit`. Between the carry limit and that line it is `shove` — the
  ball pushes past, slowed by `SOFT_SPEED_FACTOR` (a bush's own price) and taking the impact it
  always took, but never held. One centimetre of prop radius used to be the difference between
  rolling something up and being stopped dead by it. The break ladder is untouched on both
  sides of the line, and a building still blocks and still wears down through its stages.
  `passLimit` is the one function that says it, and the resolve's `skipIf`, the roll-over
  gather and the rapier contact filter all read it so nothing can disagree about which props
  are walls.
- **A wall deflects the push instead of absorbing it.** `WALL_SLIDE = 0.8`. `resolveHard` keeps
  the tangential component of a contact and drops the inward one, which slides beautifully
  along anything met at an angle and does nothing for a hit dead on — where the tangent is zero
  and the creature simply stands there. That is the inside of a corner, a building's flat face
  and any trunk approached square, and to the hand it is being stuck. The blocked component is
  now turned along the surface (the side the push is already leaning, with a fixed fallback
  dead on, so the host and a replay agree). It cannot create penetration: what it adds is
  tangential and the resolve still runs after it.
- **Sticking is easy.** `CONTACT_PAD` 0.05 → **0.25**: the old pad was the solver's own slop, so
  a pickup needed the circles all but exactly tangent on the one frame the pass looked — and at
  7.2 u/s a frame is 0.24 u of travel. A quarter unit is a hand's width at world scale. There
  is no speed threshold on a pickup and never was (size first, since the priority ruling), and
  the tests now pin that at a twentieth of a push and through a mid-contact turn.
- **A stuck item is part of the carrier's body.** Its ball exists so the pile can sweep through
  what is LOOSE — stones, fallen props, debris, other creatures. `filterContactPair` now gives
  it no pair at all against static geometry: the ground, the fixed cylinders, anything planted.
  The carrier's body is kinematic so those contacts could never move it, but they DO fire the
  impact seam, which charged damage and drops to a creature for a ball scraping the terrain.
  The cost is named: a stuck bench no longer knocks a ROOTED sign loose (§7.6's own example) —
  the carrier's own ball still hits everything rooted, which is where `hitRooted`, the recoil
  and the staged damage live.
- **Momentum needed nothing.** The drive is a velocity substitution (`driveVx = driven.x ×
  ceiling`), not a spring, so a creature is at its ceiling on the first frame — inside the
  ~400 ms the ask allowed, with no token to derive. A heading change costs no speed either: the
  velocity is the STICK's direction and the facing eases behind it. Both are pinned, because the
  obvious "fix" for a stick that feels jerky is to put a spring here and that spring would be
  the lag the report was about.

What the sweep did **not** find, stated because it was the suspicion: nothing on the map
holds a driven creature. The resolve keeps the tangential component, so pressing into the sea
wall or a trunk slides along it; a right-angled corner of two mountain-sized colliders does
pin a creature, and a 90° turn frees it inside a window (`HEAD_ON_SLIDE` is for creature
pairs; this is the wall slide). And rapier cannot pin anything either — a creature stands in
that world as a KINEMATIC POSITION-BASED body written from the resolved position every frame,
so contacts move what it touches and never it.

**`src/world/loose.ts`** — one `Mesh` per thing that is no longer scenery, on every page. An
instance row cannot be removed, only overwritten, and a prop that has left the ground is
filtered out of the scatter entirely, so something has to draw the tree lying in the field.
The material is **shared** with the scatter's own (`scatter.materialFor`), so a fallen tree can
never be a different green from the standing ones and a style override reaches both in one
write; the geometry is a cached non-instanced clone per (kind, variant), because a plain mesh
drawn with an `InstancedBufferAttribute` reads garbage or refuses to compile depending on the
driver. It is the same mesh a pickup then hangs on a creature's pile.

**`src/world/device.ts`** — one read of `(pointer: coarse)`, pure and injectable, behind
`deviceTier()`. The pixel-ratio cap in `scene.ts` already asked that question inline and the
destruction work needs to ask it again, so it is asked once.

**The ball rides on its whole footprint** *(2026-09-16)* **[D]**. User report: *"the ball is
glitching through the map floor if it's big enough."* §7.2 places a creature on the height
under its CENTRE, which is right for a 0.9 u hatchling and wrong for a ball several units
across: the ball's underside IS the root (`clump.group` at `(0, baseR, 0)`, the root's scale
the growth), so on a slope, a terrace riser or a basin lip the ground under its uphill edge
is above the ground under its middle and the downhill half of it — with the items seated low
on the pile — goes under the paper. So `clearanceLift` (pure, `src/creatures/sticky.ts`)
samples the centre and a ring of `CLEARANCE_POINTS` (8) at `bodyR × CLEARANCE_RING` (0.8) and
answers `max(0, highest ring − centre) + bodyR × CLEARANCE_PAD` (0.06, for the ground that
goes on rising outside the ring and for the small items bedded `CLUMP_FIT` into the pile's
underside). `groundClearance` in the manager eases a ζ ≥ 1 spring onto it over
`MOTION.primaryMs` and **the frame's one ground pass adds it to the height it already
sampled** — not a second Y writer, not in the locomotion pass, and x/z and the resolve are
untouched by it. A creature carrying nothing has `growth() === 1` exactly, takes the early
return and gets the placement it shipped with to the float, so the ring costs a hatchling
nothing; every world without the game is 0 everywhere. **It is derived, never sent**: poses
carry x/z/heading, so a viewer applies its own lift on top of the pose it eases toward from
the same Surface and the same synced growth — the same rule the walk/roll blend follows. The
kinematic stand-in is placed at `ground + lift + bodyR` for the same reason, so the collider
is the sphere on screen rather than one sunk a clearance into the heightfield; the shadow
stamp is unaffected (it samples the Surface itself and stays on the ground) and so is
`ballDiameter`, which is `2 × bodyR`. The known limit: the ring LEADS the centre by
`bodyR × CLEARANCE_RING`, so a ball climbing a riser faster than a spring settles is briefly
behind its own target — the drawn sphere still clears the paper (at the ring its surface is
`0.4 × bodyR` above the underside), and arriving instantly would be the step the motion law
forbids.

#### the host-only rule

**Physics loads on host election and nowhere else.** `WorldHandles.enablePhysics()` is
idempotent and is called from `settleRole` when the election says this page is simulating, at
startup on a page pinned as host (`?host=1`, the moderator secret, the dev build), and at
startup in an installation room, which has nobody to elect against. A viewer never calls it:
`physics()` and `bodies()` stay null for the life of the page, `CreatureManager.simulating()`
is false, and the ghost panel's `physics` folder says *not simulating* rather than *not loaded
yet*. Most of the audience watches from a phone running its own copy of this page, and every
one of them used to download the wasm and step a simulation whose answers it then threw away.

Which means **every decision travels**. The simulating page decides and records; `stick`,
`drop`, `loose` and `settle` are **scene events** (docs/SESSION.md §6) riding the existing
outbox → sync → store → `applySceneEvents` path; every other page applies them through
`CreatureManager.applyStick` and its three siblings, which hide a placement, seat an item at
the offset the event carries and grow the carrier, and **decide nothing**. The host does not
come round through its own events — `applyingScene` swallows them on the way out — it applies
its decision as it makes it, through the same `seat`/`unseat` helpers. Two pages deciding
independently, off two rapier simulations that are explicitly not bit-identical, is two rooms.

On the host's own frame, after `stepCreatures` and before the ground pass: rooted props first
(what we ran into, which either comes out of the ground or stops us), then pickups, then
creature-onto-creature, then whether the impact knocked something off. Deciding pickups before
impacts would let a creature eat the tree that just stopped it. Rocks leave the kinematic
collider set entirely once rapier owns them (`resolveHard`'s `skipKind`) — resolving a creature
against both a stone's body and its stale footprint circle would push it out of a stone that is
no longer there. Each creature gets one kinematic position-based body with a ball collider that
grows with the pile, plus a ball for each of the nearest `STUCK_COLLIDERS_MAX` stuck items
re-seated at its current world offset every frame: that is what makes a stuck bench sweep a
real circle and shove real debris. The single contact-pair hook returns `null` for a creature
meeting an item small enough to carry — no contact at all, because the pickup is a decision
made a few lines later and a solver impulse arriving first would knock the thing away.

#### destruction — *(shipped 2026-09-15)*

> User brief, 2026-09-15: *"objects can bounce, knock loose, drag, stick, BREAK. large props
> break into major chunks that become independent debris. buildings use STAGED destruction:
> impact 1 → cracks, impact 2 → a section removed, impact 3 → collapse into rubble. attached
> objects stay dangerous (a stuck bench swinging into a sign knocks it loose). debris is
> lightweight, has LIFETIMES, never grows without bound. the server syncs only destruction
> STATES and major transforms; secondary debris is local. the look should be more physically
> complex than it is: big readable reactions, chain reactions."*

**Bounce is the one line of that brief we did not build.** Restitution stays 0 on every
collider in the project: a rebound is forbidden at confidence 1.00 (TASTE §2.1) and the taste
arbitration wins over a feature request. What replaces it is the settle trick already in
`rocks.ts` — a thing that is hit travels and beds down rather than springing back.

**`PropBodies.onImpact(cb)`** (`src/world/rocks.ts`) — the seam the whole runtime hangs on.
`update()` already drained rapier's contact events to kick tree recoils; the same drain now
names both sides of every started contact in which at least one side moved
(`ImpactSide { key, kind, r, x, z, rooted }`) and reports the relative speed. `kind` is a
`PropKind`, or `'chunk'` for a fragment, or `'creature'` for a collider the creature layer
registered through `registerForeign` — its kinematic ball, or one of the balls standing in for
what it is carrying, both named as the CARRIER. Which is what closes the gap the katamari work
left: drops and looses used to fire only off the pure resolve's hard contacts, and a bench
hanging off a pile never produces one of those. `rooted` is on the side rather than looked up
per kind because a standing tree and the fallen tree beside it are the same kind.

**One rule, two entry points.** `hitRooted` in `src/creatures/manager.ts` is reached from the
pure resolve's contacts and from the impact seam alike: recoil always, then `decideContact`,
then the staged damage. Impact is `speed × radius` in both — the creature's body radius when a
creature hit it, the item's own radius when a stone or a chunk did.

**Two ways a prop comes apart** (`src/creatures/sticky.ts`):

- **whole** — `shatterStrength` (monolith, waterTower: **11** [D], above their `breakStrength`
  of 8). `decideContact` gains `'break'`, asked before the loose test so it takes precedence:
  a prop hit that hard comes apart instead of being lifted onto a pile.
- **staged** — `stages`, cumulative impact thresholds (building **6 / 9 / 12**, mountain
  **9 / 13 / 18**, both [D]). `breakStrength` stays `Infinity`: a building is never carried,
  it wears down. Damage ACCUMULATES in a `Map<key, number>` on the host alone — the brief's
  *"initially resist, can become loose after repeated impact"* — and `stageFor` turns the
  total into 0…3.

**`src/world/wreck.ts`** — pure-ish bookkeeping of what has broken: `WreckState`
(`key`, kind, variant, scale, place, yaw, `stage`, `removed`), `advance` and `freedAtStage`.
`advance` is **monotonic and idempotent**, which the event format depends on: a `crack` carries
an absolute stage, `compactScene` keeps only the last one per item, and a phone that hears
stage 3 alone has to land exactly where the projection that heard all three did. Which chunk
goes when comes off `Chunk.stage` (authored per family in `chunks.ts` — a mountain's summit
before its shoulders before its foot), never off an index.

**`src/world/debris.ts`** — one chunk geometry, drawn through `LooseMeshes` like everything
else that stopped being scenery, plus a dynamic body on the HOST only (convex hull of the
fragment, ball fallback, restitution 0, the rock damping/settle trick). Drawn through the loose
layer rather than a group of its own because a fragment is **collectable**: a pickup hangs the
item's existing mesh on the pile, so a debris renderer would leave two of every collected
chunk. A host's fragments go to `PropBodies.adopt`, which puts them in `items()` — the pickup
pass sees them, the settle report fires for them, and they survive a scatter rebuild (they
never were placements). Fragment directions are seeded from the parent's placement key and the
chunk index (`fragmentSpread`), never `Math.random`.

**The two bounds are different bounds.** A LIFETIME keeps the field tidy — `debrisLifetimeMs`
off the motion tokens: small `ambientMs × 2` (7.3s), medium `× 4` (14.6s), large and building
chunks **persistent**, because a fallen section is a record of what happened in the room. An
expiring piece **sinks** into the ground over `MOTION.primaryMs` and is then disposed; nothing
in this project is allowed to blink out. A CAP keeps the page alive — `DEBRIS_CAP` (96
projection / 24 phone), oldest first, preferring to dispose a piece that is already half
underground. Under a flood the cap wins over the slide, deliberately.

**What the host decides and what travels** (docs/SESSION.md §6, schema **v4**):

| event | carries | meaning |
|---|---|---|
| `crack` | `item`, `stage` | a staged prop has reached this stage: 1 cracked, 2 a section gone, 3 rubble |
| `shatter` | `item`, `x`, `z`, `rotY`, `scale`, `kind`, `variant` | a large prop came apart into all its chunks; the pose travels because the placement is hidden the moment it is decided |

Chunks themselves are **local** — the brief's own split. The ones that come to matter travel
anyway: a piece coming to rest is a `settle`, and a piece a creature picks up is a `stick`
whose `item` is `<placementKey>#<chunkIndex>` (the `#` form is in the door's `ITEM_ID`, and
`LooseMeshes` builds the mesh for it out of `buildChunkGeometries()`).

**Every page presents; the host is a page too.** `applyCrack` / `applyShatter` (and so the
replay driver, the scene apply path and the host's own decision) run the same code: stage 1
puts the prop on the ink pass's crack list (`InkPass.setCracks` — a screen-projected disc per
prop, three wobbled pen strokes on the noise field the contours already ride, max 16); stage 2
hides the placement and draws the prop as its chunk set minus the section that has gone; stage
3 lets the rest go with an outward and downward velocity. A shatter is stage 3 in one call.

**Known edge:** the standing part of a staged ruin is drawn but has no collider — the
placement's own cylinder went with `take` at stage 2. A creature drives into the ruin and
brings the rest down, which is the point of a staged collapse, but it does not shoulder against
it on the way.

**`applyLoose` on a host now builds the body** (`bodies.loosen`, falling back to the plain hide
when the placement is no longer standing). It used only to `take`, which on a restore left a
tree lying in the field with nothing under it: in the picture, out of the simulation.

#### the katamari is a PER-WORLD GAME — *(2026-09-15 user ruling)*

Everything above runs in **one world**. The default branch builds every world's production
deployment at once, and the merge that shipped §7.6 put the rigid-body rocks, the katamari
pickups and the island map on **meridian**, which had to be reverted. So the game is a
`worlds.json` field and nothing else: `"game": "katamari"` on `valiocon`, absent everywhere
else. **Meridian and the public world are byte-identical and behaviourally unchanged by this
branch.**

The switch copies `style`'s discipline exactly (§9 of docs/TASTE.md, `src/world/style.ts`):
sanitised in `scripts/world-build.mjs` (`sanitizeGame` — only the exact lowercase word, else
`none`), injected as `<meta name="refworld:game">` **only** when it is not `none` so the public
html stays byte-identical, read once in `src/main.ts` through `readWorldGame` (`?game=` wins,
then the tag, else `none`), and mirrored in **`src/world/game.ts`** so the tag a build writes
and the app's reading of it can never name two different games. The default is the shipped
behaviour, at every one of these seams.

What the flag gates, and where:

| seam | with `game: none` |
|---|---|
| `WorldHandles.enablePhysics()` (`src/world/scene.ts`) | resolves immediately; **rapier is never imported**, `physics()`/`bodies()` stay null, `onPhysicsReady` never fires. The callers in `settleRole` and at startup are untouched. |
| `WorldHandles.game()` | `'none'`, read once at `start` and never switched |
| `createLooseMeshes` / `createDebris` (`src/main.ts`) | never built; the `debris.update` frame block is skipped |
| the replay driver's `stick`/`drop`/`loose`/`settle`/`crack`/`shatter` | **not installed**. `applySceneEvents` and `replaySession` call them as `driver.stick?.(…)`, so a page handed one of those kinds ignores it without error |
| `CreatureManager` (`{ game }` option) | `simulating()` is false however many bodies the page has; no clump, no kinematic body and no growth is ever created (guarded at the creation points); all six `apply*` methods no-op |
| the ISLAND (`src/world/landscape.ts` `setIslandMode`, off by default) | no coast, no sea, no beach: `isSea` is false everywhere, `seaLevel()` is 0, the sea pass in `terrainHeight` is skipped, `sampleLandscape().beach` is 0 and `region` is never `'beach'`, and `waterColliders()` walls no coast. The sea sheets in `water.ts` and the ocean fill in `minimap.ts` are **built and hidden**, exactly as the lake is in the plain mode, and re-asked on `setLandscape`. `scene.ts`'s `start` sets the flag from the game. |

`test/world/landscape.test.ts`'s island-off block measures the pre-island map back at 2,000
points; `test/world/island.test.ts` switches the island on in its `beforeAll`.

**The creature LOOK is not gated here.** The colourways, the stalk-and-topper and the two eyes
(docs/taste/creature.md, TASTE §8) predate this branch and belong to a separate decision.

#### the props ARE the object library — *(wired 2026-09-16)*

On a katamari world the scatter draws the **katamari object library** instead of the inflated
and architectural props (docs/katamari-props.md; user ask, 2026-09-15). The seam is a **prop
source** (`src/world/props-source.ts` for the pure half, `PropSource` in `src/world/props.ts`
for the geometry): `createScatter({ source })` takes either `stockPropSource()` — the authored
props, which is every other world — or `katamariPropSource(library)`, and `computePlacements`
reads its variant counts from the active source rather than from a frozen table. **Eleven**
kinds have their VARIANTS replaced; `mountain` and `cloud` keep the AUTHORED ones — the game's
island masses read as floating slabs, not as a range, so the source MIXES per kind and the
chunk map does too. The catalog itself is GENERATED (2026-09-16, user ask: *"bring as many
katamari objects in from the library as possible, minus the main characters"*):
`scripts/katamari-curate.mjs --all` measures every glb's own bounds out of its json chunk,
classifies 1,510 of the library's 1,703 models by size and name through the rules in
`src/world/katamari/rules.ts`, excludes the characters by their `OUJI` internal prefix, and
publishes an ACTIVE SET of 326 variants (a seeded shuffle per kind, materialised so every
device draws the same world) which load tier by tier — junk first, skyline last, one rebuild
each. Three new `PropKind`s — `small`,
`medium`, `large` — are the junk tiers, with an empty stock variant list and a shipped density
of 0, so no other world can place one. Counts and the per-variant region flags come off the
in-bundle catalog and never off the download, so the placement stays pure: a katamari world
rolls the identical world on a fast connection and a slow one, and draws **ground, water and
marks only** for the second before the glbs land (`startKatamariWorld`, then one
`scatter.setPropSource` → `rebuild()` → the same `rebuildVersion()` bump a density change
makes). Per VARIANT rather than per kind: `stickyFor(kind, variant)` lets a model overrule its
kind about rootedness (a bench is not planted, the vending machine beside it is) and
`src/world/rocks.ts` gives **anything unrooted** a dynamic body the way it always gave one to a
rock; the beach admits the catalog's `beach: true` rows and nothing else, bar the handful that
carry `inland: true` beside it and stand in both (the stones, a brick, the shells). Chunks are the
models' own `parts` — `buildChunkGeometries(library)`. The look is the library's own
(`createKatamariMaterial`, posterised texture under the world's toon chain) on `ghibli` and a
stock textured `MeshStandardMaterial` on `ink`, because the world is defined by `game` and its
look by `style`. Neither the loader nor the cel material is in any other world's first chunk
(both imports are dynamic and behind the game), and `public/katamari/` is dropped from a build
whose world did not ask for the game (`vite.config.ts`).

**HOW BIG THE BALL GETS, and what the room has to agree about** — *(2026-09-17, user ask:
"we should allow for larger mass sizes than 10 meters for users")*. There is no cap and never
was: `growth` is a cube root with nothing clamping it, and `decideContact` has put **size
first** since 2026-09-16, so a ball whose radius has passed a building's takes the building out
of the ground whole. `breakStrength: Infinity` on that row is about the carrier that is TOO
SMALL — the staged collapse — and is unchanged. What was wrong was the pace: **`GROWTH_K`
0.35 → 4**, which puts a 10 m ball at ~15 tree-sized items, 20 m at ~13 houses and 40 m at ~39
buildings, from a 0.9 u hatchling. The ceiling on that number is the FIRST pickup — a stone at
the very top of the carry limit multiplies a creature by `cbrt(1 + K)`, which has to stay under
2 — so 7 is the wall and 4 leaves 1.71. The ladder, the seat arithmetic at itemR 4–8 on a 19 u
ball, and the readout past 100 m are pinned in `test/creatures/growth-ladder.test.ts`.

Two things ride the size. The phone's follow camera widens with it
(`followZoomFor` in src/world/camera.ts: `HATCH_CLOSE_ZOOM / max(1, bodyR / BALL_ZOOM_REF_R)`,
clamped by the rig at the island's own floor, retargeted only when the answer changes so a
pinch stands). And a `stick` event now carries the item's **radius** — growth is derived on
every page, and a viewer read the radius off the scatter's instance row, which the host hid the
moment it took the placement; it fell back to the instance *scale* and the same ball was two
sizes in the same room (docs/SESSION.md §2).

**A CHANGE OF ROLE LETS GO OF EVERY STICK** — *(2026-09-17, "some characters get stuck when
trying to move and glitch on mobile")*. `slot.drive` is a hand on a creature and the hands
belong to the page that is simulating. `settleRole` forgot the poses (`clearFollow`) and paused
the agents but left every drive set, which is two bugs: `isDriven` stays true so those
creatures' agents stay stood down and they stand there, and the moment the page wins an
election back every stale vector takes effect at once. `CreatureManager.clearDrives()` goes
beside `clearFollow` on **both** directions of every role change. Nothing is lost by it — a
stick that is genuinely held republishes within one `DRIVE_INTERVAL_MS`.

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
