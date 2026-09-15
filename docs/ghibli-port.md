# envpaint's element shaders in the ghibli style — the wiring plan

**What this is.** `src/world/ghibli/` is the port of envpaint's element shaders — grass,
flowers, rocks, trees, clouds, water, ground, and the ink pass's line style — onto this
world's own seams (2026-09-15, user ask: *"my preference would be to have the same grass,
rocks, water, cloud, flower, etc. shaders as env paint — I want to lean into this ghibli
toon shader style"*, and: a tropical island, ghibli meets scavengers reign). It is the
`ghibli` style only, a recorded USER OVERRIDE and not a change to the taste
([`docs/TASTE.md`](TASTE.md) §9).

**Every module in the folder is inert until something calls it.** Nothing here is imported
by `scene.ts`, `scatter.ts`, `ground.ts` or `water.ts` yet — those files belong to other
delegates and the wiring happens at merge. This page is the merge instruction: for each
module, the exact call site, what has to be passed, and what is deferred. Until those calls
land, the `ink` style renders byte-identically (the modules tree-shake out of the demo
build entirely — `npm run build` confirms it).

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

`createGrassField({ count, heightAt, region, layers, baseDensity })` →
`{ mesh, material, setLayers, setRegion, setBaseDensity, rebuild, setCount, count, setWind, setZoom, dispose }`

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

**One thing the caller must bake: `aShore`.** Per fill vertex, the distance in world units
from that vertex to the body's own outline — the outline `createWater` already holds, and
already cut the fill from:

```ts
// where the fill geometry is built from `outlines[index]`
const shore = new Float32Array(vertexCount);
for (let i = 0; i < vertexCount; i++) shore[i] = distanceToPolygon(x[i], z[i], outline);
geometry.setAttribute('aShore', new BufferAttribute(shore, 1));
```

Without the attribute every vertex reads 0 and the whole body renders as foam — so bake it
in the same pass as the fill, both for the authored bodies and for the painted ones
(`addPaintedShore`'s sibling). The sea material is for the island's surrounding water when
that lands; the two differ only in palette and drift.

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
  every ghibli material writes alpha 1. If blade-by-blade contours read badly on screen,
  the fix is a mask in `src/world/ink.ts`, not a change here.
