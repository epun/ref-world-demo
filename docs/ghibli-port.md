# envpaint's element shaders in the ghibli style — the wiring plan

**What this is.** `src/world/ghibli/` is the port of envpaint's element shaders — grass,
flowers, rocks, trees, clouds, water, ground, and the ink pass's line style — onto this
world's own seams (2026-09-15, user ask: *"my preference would be to have the same grass,
rocks, water, cloud, flower, etc. shaders as env paint — I want to lean into this ghibli
toon shader style"*, and: a tropical island, ghibli meets scavengers reign). It is the
`ghibli` style only, a recorded USER OVERRIDE and not a change to the taste
([`docs/TASTE.md`](TASTE.md) §9).

**WIRED, 2026-09-15/16.** This page was written as the merge instruction — for each
module, the exact call site, what to pass, what is deferred — and it is kept because the
call sites are still the map of how the style is assembled. Four things it says are now
WRONG, and each is corrected in place below: the `aShore` bake (§6), the `seaLevel()` the
ground never needed (§7), the heights-from-a-callback (§1), and the tree-shaking claim
here.

**The modules no longer tree-shake out.** They did while nothing imported them. Now
`scene.ts`, `scatter.ts`, `ground.ts` and `water.ts` all do, and they must: `?style=ghibli`
switches the look on ANY deployment at runtime (`readWorldStyle`, src/world/style.ts), so
the code has to be in every bundle. What `ink` still pays is NOTHING AT RUNTIME, which is
the property that actually matters and the one to keep: every ghibli material, field and
bake is constructed on the FIRST switch to the style and never before it, so an ink world
compiles no extra program, allocates no extra geometry and bakes no texture. Measured on
the public world, before the wiring against after: identical program (14), geometry (46)
and texture (5) counts, and the same frame to within one draw call of ambient drift.

**The two files outside the folder that did change**, and all that changed in them:

- `src/taste/tokens.ts` — new keys in the `GHIBLI` block only: `grassDry`, the six
  `flower*`, `waterWet`, `waterHighlight`, `wetSand`, and the island's `seaDeep`,
  `seaShallow`, `sand`, `sandWet`, `sandDark`. Every one comes off envpaint's
  `ghibli-toon` palette or the same family. Nothing existing was touched.
- `src/world/toon.ts` — three constants became `export`: `TOON_NOISE_GLSL`,
  `TOON_LIGHTING_GLSL` and a new `TOON_VARYINGS_GLSL`. `applyToon` and its behaviour are
  untouched. The point is that a bespoke `ShaderMaterial` can now light itself with the
  SAME chunk and the SAME `toonUniforms` object the stock materials get by reference — so
  the cel sun swings the grass, the rocks and the ground in one uniform write.

---

## 1. `grass.ts` — the blade field

`createGrassField({ count, span, layout, height, region, layers, baseDensity, bladeWidth, minBladePx })` →
`{ mesh, material, setLayers, setRegion, setBaseDensity, setHeight, setCenter, center, setCount, count, setWind, setZoom, setPixelScale, dispose }`

**CORRECTION (2026-09-16): the height is a TEXTURE, not a callback.** This section's
`heightAt` was baked into an `aGround` attribute per blade, and re-baking it whenever the
field moved cost **651ms for 150 000 blades** — measured, a dropped frame every few units of
camera travel. The `Surface` seam is now sampled once per terrain rebuild into an R32F
texture (`src/world/ghibli/height.ts`, 256² over the painted map) and the vertex shader taps
it with its own bilinear; `src/world/ground.ts` owns the bake and re-runs it in place beside
the region and shore bakes. It is still the seam and nothing but the seam — a cache of its
answers, exactly as the region bake is.

**And the field is two layers with a radial LOD**, not one constant-density window: a BASE
field over the island's bounding box (600k blades on a projection) plus the NEAR field
around the look-target whose density follows an inverse-square curve out to 70 units. The
window slides every frame as one uniform write, quantised to the layout's own spacing.

**Where it goes:** `src/world/scene.ts`, beside the scatter.

```ts
// after `const scatter = createScatter({ surface });` and `createGround(surface)`
const region = bakeRegionTexture();                       // src/world/ghibli/region.ts
const grass = createGrassField({
  count: coarse ? GRASS_COUNT_PHONE : GRASS_COUNT_PROJECTION,
  heightAt: (x, z) => surface.sampleHeight(x, z),         // the Surface seam, only
  region,
});
scene.add(grass.mesh);
grass.mesh.visible = currentStyle === 'ghibli';
```

- `coarse` is already computed in `scene.ts` for the pixel-ratio cap — the same signal
  picks the tier: **150 000 blades on a projection, 40 000 on a handset** (`DEBRIS_CAP`
  style constants, exported from the module).
- **`applyStyle`** (`scene.ts`, the `// ── the look ──` block): `grass.mesh.visible = ghibli`
  and the same line for the flowers. That is the whole style gate — an invisible mesh costs
  nothing and keeps the ink frame identical.
- **the frame loop** (`scene.ts`, next to `scatter.setWind(environment.state.wind, nowMs)`):
  `grass.setWind(scatter.windField(), nowMs)`. Pass the scatter's OWN field, not a second
  one: a blade and a scatter tick have to be bent by the same weather, which is the whole
  contract `src/world/wind.ts` keeps. Optionally `grass.setZoom(cameraRig.frustumHalfHeight())`
  for envpaint's distance collapse.
- **`setTerrain`** and **`setLandscape`** (`WorldHandles`): after `ground.rebuild()`, call
  `grass.rebuild((x, z) => surface.sampleHeight(x, z))`; on `setLandscape` also
  `rebakeRegion(region)` and `grass.setRegion(region)` (same texture object — the re-bake is
  in place).
- **`refreshScatter`**: nothing. Blades do not ride the scatter seed.
- **the painted layers** (`src/dev/paint.ts` installs them today through
  `WorldHandles.setPaintedPath`): add the same shape for
  `grass.setLayers({ grass: layer.texture, comb: combLayer.texture })`. The buffers are the
  painted map's own — shared, never copied (`src/world/painted.ts`).

**The ink pass's normal target.** `src/world/ink.ts` renders normals with
`scene.overrideMaterial = MeshNormalMaterial`, which would draw the blade geometry's
rest-pose `position` instead of the shader's blades. The grass and flower meshes therefore
carry `userData.ghibliNormalPassSkip = true`; the wiring hides them for that one pass:

```ts
// src/world/ink.ts, around the normal-target render
const skipped = [];
scene.traverse((o) => { if (o.userData.ghibliNormalPassSkip === true && o.visible) skipped.push(o); });
for (const o of skipped) o.visible = false;
// … render the normal target …
for (const o of skipped) o.visible = true;
```

A rest-pose `position` attribute exists on both geometries anyway, so a missed hide is a
small tuft at the origin rather than a NaN.

## 2. `flowers.ts` — the bloom field

`createFlowerField({ count, heightAt, region, layers, baseDensity })`, same handle shape.

Identical wiring to the grass, in the same four places: `scene.add`, the `applyStyle`
visibility line, `setWind` in the loop, `rebuild` / `setRegion` on `setTerrain` /
`setLandscape`. Layers: `{ flowers: <painted flowers layer>, grass: <painted grass layer> }`
— a bloom wants meadow under it (`uNeedGrass`). Tiers: **40 000 on a projection, 10 000 on
a handset**.

## 3. `rocks.ts` — `createRockMaterial()`

**Where it goes:** `src/world/scatter.ts`, the material block in `createScatter`. The swap
belongs in `setStyle`, not at construction, because the style switches live in the ghost
panel:

```ts
// createScatter, beside `const rockMaterial = new MeshStandardMaterial(...)`
const ghibliRock = createRockMaterial();           // inert until a mesh uses it
// …and in setStyle(style), where the per-kind material is chosen:
const materialFor = (kind: ScatterKind): Material =>
  style === 'ghibli' && (kind === 'rock' || kind === 'monolith') ? ghibliRock : rockMaterial;
```

`setStyle` currently only recolours; a material SWAP means re-assigning `mesh.material` on
the kind's existing meshes (or rebuilding that kind), which is the one structural change
the scatter needs. The material already carries the scatter's per-instance variation from
`aVariation` — do not drop that attribute.

Optional, unwired: an `aMoss` (0–1) and `aSeed` per-instance attribute. Both read as 0 when
absent, which is unmossed stone with its fleck seeded from `aVariation.w`.

## 4. `trees.ts` — `createCanopyMaterial({ profile })`

Same swap, same place: `swayMaterial` → `createCanopyMaterial({ profile: 'sway' })`,
`palmMaterial` → `createCanopyMaterial({ profile: 'palm', doubleSide: true })`,
`cactusMaterial` → `createCanopyMaterial({ profile: 'cactus' })`. Each carries the
variation, the height-weighted wind AND the `aBend` recoil channel, so the kinds that had
them keep them.

**Per kind, set `crownY`** — the crown's centroid height in that geometry's object space
(`buildPropGeometries` knows each variant's height; `variant.height * 0.6` is a reasonable
first pass). That number is the blob-normal approximation's one input; the module header
says exactly what it does and does not get right.

**Frame:** `setWindOnMaterial(material, scatter.windField(), nowMs)` for each, from
`src/world/ghibli/shared.ts`. The scatter's own `windUniforms` live inside its closure and
are not exported, so these materials own their own copy of the four names and take the same
field.

## 5. `clouds.ts` — `createCloudMaterial({ cloudSpan })`

`cloudMaterial` → `createCloudMaterial()`, `cloudSpan` set from the cloud variant's own
vertical extent. Same `setWindOnMaterial` call in the loop. The drift is the scatter's cloud
profile, smooth-noise driven on purpose (not the gust front) — see the module header and
`scatter.ts`'s own note.

## 6. `water.ts` — `createWaterSurfaceMaterial()` / `createSeaSurfaceMaterial()`

**Where it goes:** `src/world/water.ts`, `createWater`'s `fillMaterial`, swapped in its
`setStyle`. The fills are the only mesh that changes: the drawn shore ribbons and the ripple
marks stay exactly as they are (they are ink marks, and on this style they already take
`GHIBLI.foam`).

**CORRECTION (2026-09-16): `aShore` was wrong and is gone.** This section asked the caller
to bake the shore distance per FILL VERTEX. That cannot be made robust, and the way it fails
is the whole body: earcut's fill has every vertex ON the outline it was cut from, so a
triangle spanning the interior reads zero at all three corners and paints its span as foam.
The first attempt refined the triangles inside an 8-unit band, which fixed the ponds and
left the lake with **huge white wedges** — its big interior triangles, whose centroids sit
outside the band — and that is what a user saw on the live build.

The shore distance is a TEXTURE now (`src/world/ghibli/shore.ts`): one exact Euclidean
distance transform (Felzenszwalb & Huttenlocher, `distanceTransform` exported from
`src/world/painted-water.ts` — not a chamfer, whose diagonal error is wider than the foam
rim) over a presence mask sampled from `isWater`, which answers for the authored bodies, the
sea and every painted body at once. R32F at 512² over the 400-unit field: 0.78 units a
texel against a rim of one and a half to three. `setShoreTexture(material, tex)` hands it
over; the fragment reads it by world xz. The fills are the plain earcut sheets again — no
refinement, no second geometry — which is also what the ink pass draws, and they leave the
ink pass's normal target because a flat sheet coplanar with the ground has no crease in it
(see `src/world/water.ts`'s note on the lifts for the measurement that settled that).

The sea material is the island's surrounding water; the two differ in palette and drift, and
the sea alone carries the long swell.

## 7. `ground.ts` — `createGroundMaterial()`

**Where it goes:** `src/world/ground.ts` / `scene.ts`. `createGround` builds ONE
`MeshBasicMaterial` shared by the field and the far ring; the ghibli ground is a second
material the style swaps in:

```ts
const ghibliGround = createGroundMaterial({ region });
// in applyStyle:
const m = ghibli ? ghibliGround.material : ground.material;
for (const mesh of ground.group.children) (mesh as Mesh).material = m;
```

Then re-point the four handles `scene.ts` already drives at the shipped ground, so the
swapped material gets them too:

| shipped call | ghibli call |
| --- | --- |
| `ground.update(nowMs)` | `ghibliGround.update(nowMs)` |
| `ground.rebuild()` | `ghibliGround.refresh()` (the geometry is shared; only `uStep` moves) |
| `ground.setPaintedPath(t)` | `ghibliGround.setPaintedPath(t)` |
| `ground.setPaintedScorch(t)` | `ghibliGround.setPaintedScorch(t)` |
| — | `ghibliGround.setPaintedGrass(t)` — new: meadow goes lush under painted grass |
| — | `ghibliGround.setRegion(region)` after a `rebakeRegion` |

`setInk` is already called on this style with `GHIBLI.dirtEdge`; the ghibli material
defaults to the same value, so an un-rewired `setInk` is still correct.

**CORRECTION (2026-09-16): the ground needs no `seaLevel()`.** The wiring notes asked for
the sea level to be passed in for the wet-sand band. It is not a parameter of anything: the
band is a threshold on the REGION texture's water-proximity channel, which
`src/world/ghibli/region.ts` bakes from `sampleLandscape().water` — so the shoreline the
ground damps against is the same one every other element reads, and no height enters into
it. `createGroundMaterial` takes `{ region, snowHeight }` and nothing else.

**And there are THREE bakes now, not one.** `ground.rebuild()` re-runs the region, the
height (§1) and the shore (§6) in place — one pass, three textures, and every element that
reads a shoreline or a ground height sees the new map without being handed anything. The
ghibli ground also carries the blade field's window (`setFieldWindow`) so it can tint the
meadow to the field's own colour exactly where the field is drawn, and its own blade
STIPPLE so the ground reads as grass everywhere the blades are not.

**Do not let the marks go.** The ghibli ground replicates `ground.ts`'s terrace-lip line,
riser hatching, painted-trail rim/stipple and scorch, constant for constant, with a `gg`
prefix on the noise chain. A dial changed in `ground.ts` and not here shows up as marks in
the wrong place on one style only — change both.

## 8. `post.ts` — `applyGhibliPost(ink)`

**Where it goes:** `src/world/scene.ts`'s `applyStyle`, immediately after
`ink.setStyle(style)`. On `ink`, restore the shipped defaults (`ink.setParams({ lineWidth:
2.1, wobble: 1.6, hatchStrength: 0.15 })` — or better, have `InkPass.setStyle` own both
directions). Three of envpaint's seven dials map; `break`, `inkOpacity`, `hatchScale` and
`pooling` do not, and the module says what would have to change in `src/world/ink.ts`
first.

---

## The region texture

`src/world/ghibli/region.ts` bakes the authored map (`sampleLandscape`) into one 128² rgba
texture: **r** meadow weight, **g** beach weight, **b** water proximity (exactly 1.0 in
water, a ramp inland). It is the reason an unpainted island still has a meadow, the sand
thins the grass out, nothing grows in the sea, and the ground can put a damp strip in the
last units before the waterline.

One texture, shared by the grass, the flowers and the ground. `bakeRegionTexture()` once at
start-up; `rebakeRegion(texture)` in place whenever the map moves — `setLandscape`, and a
painted pond (`WorldHandles`' paint path). It is not on the scatter seed and it does not
ride the terrain dials (only the shoreline matters to it, and a dial moves heights).

## Deferred, deliberately

- **The ripple sim.** envpaint runs a height-field sim into a render target for rain rings
  and rock impacts. `uRippleTex` stays in the water shader bound to a 1×1 flat texel, so the
  two `step`s that read it are always false and the sim can land later without touching the
  material.
- **Press-layer writes.** The grass and flower shaders read a `uPress` rgba layer — push
  direction and force — and flatten under it. Nothing WRITES that layer here yet; in
  envpaint the rolling rocks do. `src/world/rocks.ts` and the creature layer are the
  natural authors; both are other delegates' files. Until then the layer is a 1×1 rest
  texel and the field stands up straight.
- **Leaves.** envpaint's `Trees` also sheds leaf particles on a gust. Not ported: it is a
  particle system, not an element shader, and the scope here is the shaders.
- **`aMoss` / `aSeed` on rocks**, and `aBlobN` on crowns — see §3 and §4. Both degrade to a
  documented default rather than requiring a geometry change in somebody else's file.
- **Ink-mask alpha.** envpaint writes an alpha channel that tells its post pass "outline
  this, do not hatch it", and the grass writes 0 so a meadow is not outlined blade by
  blade. This world's ink pass keys off depth and normal targets and has no such mask, so
  every ghibli material writes alpha 1. **Solved another way, 2026-09-15:** the blade and
  bloom fields (and, since the shore bake, the water fills) are hidden for the normal pass
  through `userData.ghibliNormalPassSkip`, and that pass is where the contour and the hatch
  both come from — so a blade is never outlined blade by blade and no mask was needed.

## Still open

- **Reflections and light shafts.** The water reference (the Tiny Delivery clip, §6) has
  soft reflections of the geometry above the surface and broad light shafts across it.
  Neither is in this port: both want a second pass, and the surface is one flat unlit sheet
  by design.
- **The foam's tonality.** The reference's foam carries blue-white variation and feathers
  into the shallows; ours is a chalkier white with an eroded inner edge. Closer would mean
  a second foam tone and a wider feather, both in `ghibli/water.ts`'s FRAGMENT.
- **The shallows over sand.** The bed showing through reads slightly greyer than the
  reference's bright aqua. `uBed` is `sand` lerped 0.62 toward `waterBed`; the lerp and the
  token are the two knobs.
