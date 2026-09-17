# ref-world — agent notes

Shared isometric Three.js world. Phones draw characters; drawings become eggs; eggs hatch;
phones emote and track their character on a minimap.

## Before any visual or motion work

Read [`docs/TASTE.md`](docs/TASTE.md) — the arbitration between the briefs
([character](docs/taste/character.md), [world](docs/taste/world.md), and since 2026-09-15
[creature](docs/taste/creature.md), which supersedes the character brief for the creature —
TASTE §8) that conflict in seven places. **The arbitration wins over any brief.**

It tags every rule **[M]** measured (from a brief's tokens — not ours to negotiate) or
**[D]** derived (our decision, consistent with the briefs but not attributable to them).
Keep that discipline: the world brief explicitly says *"never invent a rule and attribute it
to this taste."* It also marks **`threeD` as not observed** — this is a 3D project whose
taste has no 3D evidence in it, so rendering choices follow the observed axes and are
otherwise ours to make and to label.

The traps, in order of how easily they get violated:

- **No overshoot, no bounce, no hard cuts, no abrupt stops** — all confidence 1.00. Every
  spring runs at damping ratio **ζ ≥ 1.0**; the solver clamps this at the API boundary so
  underdamped motion is unrepresentable. Entrances **slide**; never `scale: 0 → 1`, never a
  pop. Nothing fully arrests — an ambient drift floor runs under everything.
  ⚠️ This contradicts the vendored `apple-design` skill. The arbitration wins.
  ⚠️ But note **1823ms is confidence 0.06** — the constraints are certain, the number is a
  starting point to tune.
- **Near-black belongs to characters only.** Environment never goes below ~`#353534`. The
  measured palette has near-black at just 0.09 prevalence — it's rare by nature, and it's
  the character.
  ⚠️ **Standing user override (2026-09-15):** creatures are now COLOURED, per the creature
  brief ([docs/taste/creature.md](docs/taste/creature.md), TASTE §8) — one of six vivid hues
  read off the drawing (`src/character/palette.ts`), a stalk with the drawing as its topper,
  two eyes. The environment rule above is untouched: nothing environmental goes near-black
  or takes a hue. Don't "correct" the creatures back to `#080808`.
- **The ground is mid-toned grey (`groundLuma 0.74`), not cream or white.** There is **no
  pastel green or pink** in this taste; it is near-achromatic (`saturation 0.188`).
  ⚠️ **Standing user override:** the shipped `SURFACE.ground` is `#dfdfdf` (luma ~0.87) —
  lighter than the measured target — picked in the panel's color picker and exported as the
  default. `COLOR_METRICS.groundLuma` keeps the measured 0.74; the value-histogram gate
  measures against the configured paper and prints the drift. Don't "correct" it back.
- **The `valiocon` world renders in the ghibli cel style — a recorded user override, not a
  change to the taste.** Green meadow, warm sun, cool two-tone shadows, envpaint's ink on the
  contours; the achromatic palette and the six-luma quantize are the only two rules it
  relaxes, and the two palette gates report `n/a` there rather than a false failure. Every
  other world, the public one first, renders exactly as before. Documented in
  [`docs/TASTE.md`](docs/TASTE.md) §9; the code seams are `src/world/style.ts` and
  `src/world/toon.ts` (chain `onBeforeCompile`, never clobber it).
  **And since 2026-09-17 the HANDSET'S CHROME takes that world's palette too** (user ask:
  *"can we style the device on mobile in the new style of the world so it's not just black
  and white"*, TASTE §9b). `src/ui/theme.ts` names the six roles every flat surface uses —
  `paper`, `ink`, `muted`, `light`, `pad`, `accent` — and resolves them from `WorldStyle`,
  the way `mapPalette` already resolves the map's two. On `ink` every role IS the token the
  surface used before, so the public handset is byte-identical; on `ghibli` every role is a
  `GHIBLI` token, `GHIBLI.paper` being the one new `[D]` value (a UI paper — nothing
  environmental takes it). Surfaces say `var(--rw-ink, ${WORLD.ink})` and the FALLBACK is
  the shipped token, so a module is correct with no theme installed (a unit test, or
  `/draw/`, which cannot import from `src/`); `installUiTheme` is called once at boot in
  `src/main.ts` and `src/phone/main.ts` and nowhere else. `phone.html` learns its style from
  a `refworld:style` meta that `applyStyleToPhoneHtml` (scripts/world-build.mjs) injects only
  when it is not `ink`.
  ⚠️ **Nothing inside the device's bezel is themed.** The well is `public/device/shell.svg`,
  a static asset shared with `/draw/` and the tray, and its screen is `SURFACE.ground` — a
  key face, the stage paper, the pad's ground or the egg's clear colour in the theme's paper
  draws a LIT RECTANGLE inside the bezel, which is the enclosure DEVICE §3 forbids and a
  rectilinear form. The case is a physical object with its own colour; the theme paints the
  page it lies on, the keys' rings, the type and the frames. The keepsake image is the one
  exception — it is not in the bezel.
- **Grain is a full-frame post-process, never a material.** It must not vary across a
  character's fill or the silhouette stops reading as one solid shape.
- **UI is `icon` + `ruleLine` + `border` only.** No filled panels, no cards, no shadows under
  UI. That mark set is the world brief's #1 defining signal.
  ⚠️ **Standing user override (2026-09-17):** three things on the world view stand on PAPER
  inside the project's wavering hand-drawn hairline — the join code, the minimap, and now the
  projection's leaderboard (`src/ui/leaderboard.ts`, TASTE §9a). One generator for all three
  (`wavyBorderPoints` + `wavyBorderPath`), one inset (`mapBorderInset`), one 1.25 hairline,
  and nothing else comes with it: still no shadow, still no radius, still no second fill. The
  mark-set lint reports those fills as ruled exemptions rather than failures. And the
  leaderboard's title is the ONE recorded capital in the product (`Leaderboard`, asked for
  twice) — everything else, room codes and creature names included, is still lowercase.
- **Shadows are hard-edged and flat-filled.** Single value, cut sharp, no penumbra, no PCF,
  no AO. Not Three.js default shadow mapping.
- **No rectilinear or engineered geometry.** The isometric grid governs *placement*, never
  *form*.
- **No uppercase type. Anywhere.** Room codes render `xkcd`, not `XKCD`.
  ⚠️ One recorded exception since 2026-09-17: the leaderboard's title, `LEADERBOARD_TITLE`
  in `src/ui/leaderboard.ts`, carrying the static gate's scoped `gate-allow-uppercase` hatch
  on its own line (TASTE §9a). The scan itself is unchanged — don't widen it, and don't
  spend the exception twice.

## Architecture

[`docs/PLAN.md`](docs/PLAN.md) is the source of truth. Key invariants:

- **`src/shape/` and `src/inflate/` are pure and deterministic.** No Three.js, no DOM. Same
  strokes → identical mesh on every device. That determinism is load-bearing: it's why the
  phone can render the character locally instead of streaming video from the world. Don't
  introduce nondeterminism (unseeded random, time, float-order drift) into these.
- **The drawing is reproportioned, never replaced.** The `fidelity` dial controls how loosely
  the character interprets the drawing, but no code path generates a new shape.
- **No skeletal animation.** Characters are generated blobs deformed in a vertex shader from
  a few uniforms. No bones, no GLTF rigs.
- **Locomotion goes through the `Surface` interface**, never world-space Y. That seam is what
  lets the flat map become a sphere planet without a rewrite.
- **Durations come from motion tokens**, never literals.
- **Everything in `src/dev/` is gated on `isDev`** and must tree-shake out of the demo build.
- **Scene changes — landscape, terrain dials, paint — travel as session events** over the sync
  topic and into `refworld:<world>:scene`; apply through the replay driver, never a second path.
- **Physics runs only on the simulating page; every decision about what is stuck, loose or
  settled travels as a scene event.** `world.enablePhysics()` is called on host election and
  nowhere else — a viewer holds no rapier world and decides nothing (docs/PLAN.md §7.6).
  **And a HANDSET never loads rapier at all (2026-09-16)** — 760 kB compressed, paid by
  every phone testing alone in a room, because a phone alone on the link hosts. A phone host
  runs the game off the pure resolve and the scatter's own colliders instead and still
  decides everything; what it does not have is rolling stones and tumbling debris. So
  "does this page hold rigid bodies" and "is this page the authority" are now TWO questions
  (`rapierOwns` / `deciding` in `src/creatures/manager.ts`) — don't collapse them back into
  `bodies() !== null`. One flag reverses it: `PHONE_RUNS_RAPIER` in `src/world/device.ts`.
- **A phone in a room is a VIEWER, and that is the path to test (2026-09-17).** Its stick
  never moves its own creature — it publishes an intent, the host applies it, the pose comes
  back. Three rules hold that together and each was a bug: a change of role must
  `clearDrives()` beside `clearFollow()` (a drive is a hand on a creature and the hands belong
  to the page that simulates — left set, `isDriven` keeps the agent stood down forever and a
  re-elected page applies every stale vector at once); the stick's uplink pacing lives in
  `createDriveUplink` (src/net/worldsync.ts), never inline, and the RELEASE is exempt from it;
  and a viewer leads the host's last pose by the host's own derived speed, or a walking
  creature stutters at the 5 Hz pose rate. `test/net/two-page-room.test.ts` is two real
  managers through an in-memory bus; `scratch/room-drive-smoke.mjs` is the same room in real
  browsers against a local aedes broker (`?broker=` overrides EVERY socket the page opens).
- **The katamari is a PER-WORLD GAME (user ruling, 2026-09-15). `worlds.json`
  `game: katamari` is the only switch; meridian and the public world are byte-identical and
  behaviourally unchanged by it.** The default branch builds every world's deployment at
  once, so nothing about the game may be unconditional. The seam copies `style`'s discipline
  — `src/world/game.ts`, `sanitizeGame` in `scripts/world-build.mjs`, a `<meta>` injected
  only when it is not `none`, read once in `src/main.ts`, default = the shipped behaviour.
  The flag gates: `WorldHandles.enablePhysics()` (rapier is never imported without it),
  `createLooseMeshes`/`createDebris` and the debris frame block, the replay driver's
  `stick`/`drop`/`loose`/`settle`/`crack`/`shatter` (not installed, so those scene events are
  ignored), the creature manager's `simulating()`, clumps, kinematic bodies, growth and all
  six `apply*`, the `rider` node that keeps the drawn creature its DRAWN size while the pile
  grows (user ask 2026-09-17, PLAN §7.6 — the growth is still ONE write on the root and the
  rider divides it back out, so don't put the creature back inside the clump), **the BALL'S
  OWN BODY** (`src/creatures/ball.ts`, user report 2026-09-17: *"currently there is a bug
  where the characters are floating in space"* — when the creature came out of the pile
  nothing was left drawing the sphere the items are seated on, so a small character stood on
  the north pole of nothing; one cel-shaded sphere per creature in the creature's own hue,
  radius 1 scaled to `baseR` on the ROOT so the growth carries it to `bodyR` in the same
  single write, centre at `baseR·(2·roll − 1)`, and buried under the ground at `roll` 0 so a
  walking creature shows no ball without anything being switched off.
  ⚠️ **And the creature is INSIDE it, at the centre** — user direction the same day: *"I think
  the creature should be at the center, and then it should just be a giant rolling mass … we
  still have a glitch where the creature is sitting on the Z-index above whatever objects they
  collect"*. So the rider's height is `baseR·roll` (the ball's centre = `clump.group`'s origin
  = the point every seat is measured from), and the shell is drawn **`BackSide`**
  (`BALL_SIDE`): the far inside is the fill behind the creature, the silhouette is still the
  full circle, and nothing is ever drawn in front of the centre — that is what makes the
  creature visible with NO depth or render-order hack, which is the glitch that was reported.
  An item on the near side of the pile occludes the creature, and that is correct. Don't add
  `depthTest: false`, don't touch `renderOrder`, and don't put the creature back on the pole.
  The rider also counters the ROOT's lean (the zero-gravity tumble) so the mass tumbles and the
  thing inside it stays upright), the
  **the map's GRAVITY** (`g` on the keyboard page, user ask 2026-09-17: *"i want a zero
  gravity mode … characters should float in space"* — a `world` event with `field: 'gravity'`
  on the scene layer, so it retains and restores like the landscape switch, with its own
  replay-driver method installed beside `stick`/`drop`/`loose` and therefore ignored on every
  other world; the FLOAT is local and derived on every page from that one bit, the slot id and
  the page's own clock (`src/creatures/gravity.ts`) and is applied in the same ground pass as
  `groundLift`, so Y never goes on the wire and the Surface seam stands; rapier's own gravity
  and the nudge for the sleepers are the simulating page's alone, PLAN §7.6), the
  ball-diameter readout on the phone's world view (`src/ui/size.ts`,
  `CreatureManager.ballDiameter`), the handset's contextual hints, loading and empty states
  (`src/ui/hints.ts`, `loading.ts`, `empty.ts` — the hints are three marks in the live world
  view, each dismissed by doing what it says; user ask 2026-09-17, no slideshow), and **the island** — `setIslandMode` in
  `src/world/landscape.ts`, off by default, so the coast, the sea and the beach do not exist
  on any other world. Don't make any of it unconditional again. The creature LOOK is not
  part of this gate.
  **On a katamari world the props are the vendored object library** — the scatter's variants
  come from `src/world/katamari/` through a prop source, three junk kinds (`small`/`medium`/
  `large`) exist only there, and `public/katamari/` is personal-use material that ships to a
  katamari deployment and no other (docs/katamari-props.md). The catalog is **generated**:
  edit `katamari/rules.ts` and re-run `scripts/katamari-curate.mjs --all`, never
  `catalog.data.ts`. The game's characters are excluded there and stay excluded.
- **The geography is authored in `src/world/landscape.ts`** and is the single source every
  system samples — placement, colliders, water, minimap. Never re-derive a shoreline
  elsewhere, and the map does not ride the scatter seed. The ground has height: sample it
  through `src/world/surface.ts` only, never derive a height elsewhere. Locomotion never
  writes Y. **On the katamari world the map is an island; the sea is the complement of the
  authored coast** — everything outside `ISLAND_LOBES` is water, so nothing else needs to know
  where the edge of the world is (PLAN §7). It is behind `setIslandMode`, off by default: every
  other world's map is the one that shipped before the island landed.
  **The island is 1.32x the ORIGINAL diameter, and that is ONE number** — `MAP_SCALE` in
  `src/world/landscape.ts`, read through `mapScale()` and gated on `islandMode` like the
  coast itself. It has been 2 (2026-09-16, *"make the island twice as big"*), then 1.3, then
  1.1, then **1.32** — three asks on 2026-09-17, the first two *"too big"* and the third
  *"map is now too small, let's increase the size of the island by 20%"*, every one read as
  linear (2 x 0.65, x 0.85, x 1.2). Every extent that has to cover the land rides it (the
  ground field and its three bakes, the base blade span, the scatter extent, the physics
  heightfield, the spawn disc, the minimap, the sea disc and the camera's depth range). A
  number scales when it says WHERE something is and not when it says HOW BIG a physical thing
  is: a beach, a pond, a shore ramp and the terrain noise are all unchanged.
  **It is NOT AN INTEGER, so every derived COUNT is rounded where it is derived** — the three
  outline vertex counts, `fieldSegments`, the three bake resolutions and the physics
  heightfield — and the thing held across the scale (a chord, a quad, a texel) is held to
  within half a count instead of exactly. The bakes round to a whole texel count rather than
  stepping to a power of two (169²/338²/676² over 528 u, every texel inside 0.03% of its
  authored size); NPOT is free on WebGL2 at CLAMP with no mipmaps. At 1.32 the ground field
  rounds too (422.4 -> 422), so the 1.25 u quad is 1.25118 — a test allows half a segment and
  no more. And 1.32 is not an exact binary float, so assert a scaled coordinate against
  `authored * MAP_SCALE`, never a spelled-out literal. **The riser run is a function of the
  scale** (`riserRun` in `src/world/field.ts`, `0.6 * terraceStep / steepestSlope`) off a
  table of MEASURED steepest slopes — 0.843 authored, 0.4570 at 1.1, **0.5037 at 1.32**,
  0.4814 at 2 — because verticals and noise wavelengths do not scale, so the number does not
  even move monotonically with the map. Measure the slope and add the entry when the scale
  moves; the fallback `0.843/sqrt(scale)` only tightens the bound.
  **EXTENT is the same on every device; RESOLUTION is per tier.** The projection holds every
  texel and the 1.25 u ground quad it had. A HANDSET (`renderTier()` in
  `src/world/device.ts`, published once by `start`) trades four of them back, because four
  times the land at the same resolution is four times the CPU and it is a REBUILD cost every
  terrain dial and painted pond pays again — measured at `MAP_SCALE` 2: 906 ms → 3625 ms on
  one core, and 1944 ms with the trade: ground field 480 segments (1.67 u quad, still inside
  the 1.99 u riser run, height error 0.112 u), shore bake 512², region bake 128², physics
  heightfield 256. The HEIGHT bake is deliberately NOT traded — it is where every blade
  stands, so its error is geometry and not a soft edge. **The field's 480 is a CEILING and at
  1.32 it does not bind**: the projection cuts 422, so `fieldSegments` takes the `min` — a
  phone never pays MORE than the projection for a smaller map. Don't delete it; it binds
  again above scale 1.5.
  **A body of water is what a change of scale breaks.** A pond's centre scales and the noise
  does not, so every body lands on different hummocks at every scale — and the FIRST pond
  straddles a terrace riser everywhere in the band 1.28–1.35, reading as perched (0.478 at
  1.32, 0.517 at the 1.3 tried before it, against the 0.6 basin-shoulder bound in
  `test/world/landscape.test.ts`). The fix is where the pond stands, never the bound: it
  carries an **`islandNudge` of (+5, +5)** — world units added after the scale, island mode
  only, the nearest offset that reads clear (0.8175), measured over a grid around the scaled
  centre. The authored centre (15, −55) that the public world reads is untouched.
  **And the lake on the island map has NO ISLET in it (user ask 2026-09-17: *"let's remove the
  small island within the island."*)** — one named constant, `LAKE_ISLET_ON_ISLAND` in
  `src/world/landscape.ts`, applied in `scaleWaterBody`, which is reached only from the scaled
  (island-mode) branch; `WATER_BODIES_AUTHORED` keeps its islet byte for byte, so the public
  world and meridian read the lake they always did. Every consumer asks the body for its islet,
  so with the field absent the basin stays flat, no sample is ever `island`, there is no
  `shore-island-*` ribbon and no hole in the fill, the minimap paints none and the scatter
  plants nothing there. The islet's own measurements are facts about the AUTHORED map now and
  run with the island OFF. Nothing was re-measured — the steepest slope is still 0.5037 at
  (80.4, −164.6) — except the ripple margin that empties the lake (24 → 44, because the widest
  open water it held was the crossing past the islet).
  Don't capture the exported layout (`ISLAND`, `ISLAND_LOBES`, `WATER_BODIES`, `FOREST_BLOBS`,
  `MOUNTAIN_BLOBS`) into a module-scope const — they are live bindings `setIslandMode`
  re-points, so read them after the flag is set. PLAN §7 has the full list.
- **A HANDSET DRAWS NO GRASS (user report, 2026-09-17: *"let's remove the grass shader for
  now, it's glitching"* / *"on mobile when you zoom out the shader glitches out and looks
  like camo"*).** No blade field and no bloom field on `renderTier() === 'phone'` — not even
  the base field the 2026-09-16 work left it with. The ghibli ground shader carries the whole
  meadow there: with no field there is no window, so `ggFieldDense` reads 0 and the stipple
  and the meadow tint run at full strength, which is what they were tuned to do outside the
  window anyway. One pure answer decides it — `fieldPlanFor` in `src/world/device.ts`, built
  by `buildFields` in `src/world/ghibli/fields.ts` — and one flag reverses it:
  `PHONE_DRAWS_GRASS`. The projection lays all three, base field first, unchanged.
  Measured on the phone frame: 172 → 171 draw calls, 2 983 505 → 2 663 505 triangles
  (40 000 blades × 8), 40 → 38 programs, 133 → 129 textures.
- **Every world-space noise frequency in the cel chain fades out as it crosses nyquist** —
  `toonBandLimit` in `src/world/toon.ts`, off the units-per-pixel `setToonPixelScale` writes
  once a frame. That was the OTHER half of the camo: at the phone's zoom floor the frame is
  1.9 world units a pixel, which put the cel terminator's wobble at 0.26 pixels a cycle and
  the ground's blade stipple at 0.15 — ten times past nyquist, so a two-tone ramp dithered
  per pixel. Full at two and a half pixels a cycle, gone by one and a half; the default view
  is 0.05 u/px, where the finest term still has 2.9, so nothing at the default framing
  changes. **A new world-space noise dial takes a `toonBandLimit` of its own base frequency**
  (`test/world/ghibli/band-limit.test.ts` pins the ones that exist).
  **And the rate is PER FRAGMENT, not per frame (2026-09-17, *"when I rotate the view too
  much on mobile"*).** `uToonUnitsPerPx` is the SCREEN-PLANE units per pixel, and the ground
  is not in the screen plane: its depth axis foreshortens by `1/sin(tilt)`, so the rig's
  lowest orbit (`ELEVATION_MIN` 0.3) samples it 3.4x more coarsely than that number says —
  and a lattice stepped near its own cell spacing BEATS into large soft blotches rather than
  speckling, which is the screenshot. So `toonUnitsPerPxAt` measures the real rate from the
  screen-space derivative (`max(length(dFdx(p)), length(dFdy(p)))`, not `fwidth`, which mixes
  the screen axes and so swings with the azimuth), `toonMeasurePixel(vToonWorldPos.xz)` is
  called ONCE per fragment at the top of `main` (a derivative is undefined in non-uniform
  control flow), and the frame's scalar stays as the FLOOR — nothing is ever band-limited
  less than before. The measure is calibrated by `sin(iso elevation)` so a default-framed
  flat ground reads back exactly the scalar and the tuned 2.5 → 1.5 ramp keeps its meaning.
  `setToonPixelScale` also takes the rig's tilt as a ratio to the iso tilt, which is the half
  a scalar CAN carry and the only fix a shader that measures nothing per fragment gets (the
  rocks, the canopies, the clouds, the katamari props). **The WATER had no band limit at all**
  until then and was the worse half of the picture: all seven `toonFbm` terms in
  `src/world/ghibli/water.ts` now ride one at their own base frequency and each fades to its
  own MEAN (`fbmMean`, now in `src/world/ghibli/shared.ts`) rather than to zero, so the sea
  at the floor is the flat wash the marks average to instead of blotches — fading a wobble to
  zero would move the colour band it wobbles, and fading a threshold's noise to zero would
  erase the mark instead of averaging it. **The rocks moss edge (2.5), the canopy break-up
  (1.6) and the cloud belly mottle (0.24) ride one too** since 2026-09-17 — a walking
  creature zoomed out has all three in frame — and each of those three shaders measures its
  own rate, because a scattered prop is a few pixels across long before the ground is.
- **The CEL RAMP widens where the MESH outruns the frame, and only there** [D] — the third
  pass at the camo (2026-09-17), because band-limiting every noise dial to zero did not empty
  the low-tilt frame. The ramp is a hard two-tone step on `dot(normal, sun)`, and the ground
  field's quad is 1.25 u — half a CSS pixel at the zoom floor — so each pixel takes whichever
  of four quads won the depth test and the step lands on opposite sides of its own edge in
  neighbours. Only the step's own gradient can reach that (three's `geometryRoughness`
  measures the same quantity): `toonMeasureRamp` reads `dot(dFdx(normal), sun)`, and
  `toonRamp` floors its half-width at it. Measured on the ground alone at the floor at
  `ELEVATION_MIN` (`scratch/camo-source.mjs`): land sd 23.75 → 21.48, high-pass rms
  16.52 → 14.47, and the flat basin unchanged (sd 4.92 → 4.91) — it acts where normals vary
  and nowhere else. The default view is inside the frame's own animation floor.
  **It is OPT-IN per fragment and the ground is the only shader that opts in** — a creature's
  terminator, a prop's and an egg's are the character (TASTE §8) and stay exactly as hard as
  they ship. Two numbers: `TOON_RAMP_PX` 1.0 (about two pixels of transition) and
  `TOON_RAMP_MAX` 0.5, the ceiling.
  ⚠️ **A WIDENED THRESHOLD LEAKS — twice tried, twice measured worse, twice reverted.** The
  same trick on the ground's `step(rockEdge, n.y)` washed four tenths of a GREY rock over the
  whole map (sea sd 3.07 → 13.39, mean 40.8 → 54.0) and on the sea's foam edge put a tenth of
  a foam over the whole ocean (mean 40.8 → 53.8). The average of a threshold over a pixel is
  only the answer when both sides are equally likely; rock and foam are rare, so widening
  them past the distance from the input to the edge returns a partial EVERYWHERE. The ramp is
  different because its two sides are the two tones and the average IS the answer. Both
  reverts are pinned in `test/world/ghibli/band-limit.test.ts`; don't re-try them without
  reading why.
  ⚠️ **And the sea's residual mottle is NOT aliasing.** With every water term limited to 0 it
  still measures sd 3.0 on a mean of 41 — that is the painterly swell (`SWELL_SCALE` 15 u,
  band limit 1.0 at every framing the rig can reach) and the long shoreward swell, both
  intended. The huge soft blobs the `nowater` probe shows over the basin are the ground's own
  authored 67-unit colour break-up (`cn`) and its beach two-tone, which the sea covers in
  every real frame — don't chase them.
- **No `FloatType` texture is ever `LinearFilter`ed.** 32-bit float is not
  texture-filterable in core WebGL 2 — that is `OES_texture_float_linear`, which iOS Safari
  does not expose — and a `LINEAR` sampler on one makes the texture INCOMPLETE, so it samples
  black. The shore bake is therefore **R16F** (`src/world/ghibli/shore.ts`; zero there means
  "on land", which reads as foam, so on an iPhone the whole sea rendered as surf). The height
  bake stays R32F because it is `NEAREST` and taps its own bilinear in the shader. The ghibli
  fragment shaders say `precision highp float` themselves, and a dev deployment logs what the
  driver actually offers on the phone tier (`src/world/capability.ts`).

## Running the room

[`docs/RUNBOOK.md`](docs/RUNBOOK.md) — one page, read before a demo. The part
worth knowing here: a refreshed projection **heals itself**. The world
announces its epoch retained, handsets re-publish their own drawing under the
same id, and the pure pipeline rebuilds the identical creatures. `shift+R` is
the manual path (local log first, then a recall) and it always reports on
screen what it did — shifted because the ghost panel owns plain `r`. Never reach for *replay* to
recover — that re-runs a session at its recorded pace; *restore* is the one
that applies the whole log at once (docs/SESSION.md §4a).

**`?fresh=1` is the one load that starts the room EMPTY — a testing flag, not a
world setting (2026-09-17: *"i want the default load to be empty"*, then *"it doesn't need
to start empty on every load but just for testing. on the actual demo day we want to make
sure that the world saves and is stored."*).** On that load the projection does what `reset
world` does before anything is shown — generation bumped through `/api/moderate` when the
page holds the secret, the store's drawings and scene not read in, phones sent back to the
pad KEEPING their drawings — and then it strips itself from the address the way `?mod=`
does, so the next reload restores and heals as always. It is deliberately NOT a
`worlds.json` field and has no `<meta>`, so no world can inherit it; the whole decision is
`src/world/load.ts` (`readFreshLoad` / `planLoad` / `startFresh`), read once in
`src/main.ts`, and it is inert on a handset (a phone in a room is a viewer and must see the
live creatures), inert in an installation world, and still locally empty — saying so — on a
page with no secret. Don't make it a per-world default (docs/RUNBOOK.md §between test runs,
docs/SESSION.md §4b).

**Never delete a handset's stored drawing.** It is the only copy that survives
a projection restart, and two separate code paths used to destroy it on exactly
the event that made it precious. `test/session/recovery.test.ts` pins both gone.

## Taste gates

TASTE §7 defines eight verification gates (achromatic, value histogram, damping audit,
uppercase scan, stillness probe, density probe, mark-set lint, grain check). They ship as
Ghost Panel controls and build-time checks, not as review checklists — a constraint that
isn't a button doesn't survive a build. Keep them working.

## Skills

`.claude/skills/` is vendored — see its README for provenance. Two cautions:
`apple-design` recommends overshoot (forbidden here — see above), and
`threejs-aaa-graphics-builder` pushes photoreal art direction (use for render budgets and
LOD only).
