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
| river | `4` | paint | a level carried downhill along the stroke | coming |
| waterfall | `5` | paint | an ink mark where a level falls | coming |
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
