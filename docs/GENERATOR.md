# ref-driven world generator — product spec

> Source: user brief ("Build a Ref-Driven Chao-Inspired World Generator"). This is the
> product-level spec sitting above [`PLAN.md`](./PLAN.md); where it names systems the plan
> already defines, the plan's implementation stands. Behavioral inspiration is Chao Garden;
> **no Sonic/Chao visual derivation** — no Chao head shapes, floating ornaments, Sonic
> proportions, or derivative silhouettes.

## The one-line goal

ref taste brief → generated world rules → audience-created inhabitants → living shared
ecosystem. From far away the landscape reads first; then you notice one creature wandering,
another sleeping, two sitting together. Success is "that little one is mine" followed by
"wait, what is it doing over there?"

## What was already true (no change)

- Palette, saturation 0.188, contrast 0.577, groundLuma 0.74, density 0.39 — the measured
  tokens in `src/taste/tokens.ts`.
- Motion law: no bounce/overshoot/snap/cut, drift settle, ~1823ms primary, ambient floor,
  ζ≥1 springs (unrepresentable otherwise).
- Egg lifecycle: slide-in spawn, paint-on, wobble→crack→unfold over the primary token,
  no explosive pop. (The brief allows seed/stone/bulb/cocoon variants — shell shape becomes
  a Ref-config value, current scribbled egg is the first entry.)
- Scatter: repeated small handcrafted motifs, instanced, jittered organic-iso placement,
  clusters over uniform coverage, exclusion radii, negative space dominant.
- Grain, hard-even lighting, no bloom/volumetrics/photorealism.
- Ref-as-config: every aesthetic number already flows from one token module; the brief's
  `{ world, creatures }` JSON maps onto it (§ref-config below).

## Rulings on the two real divergences [D]

### 1a. Drawn objects keep their shape *(user decision, supersedes 1's torso synthesis)*

> User: "if a person draws an object or an animal we should resemble that shape. i.e. a
> hat, fish, cat, etc." — with the earlier qualifiers "not exactly of course" and "we
> don't want stray lines to create line or simple vector characters."

The creature's body silhouette is the drawing's own shape — **filled, smoothed,
simplified, and chunkified** — not a synthesized species torso. A drawn hat stays a hat;
a fish stays a fish. Species membership comes from what gets *added*: the tiny stubby
legs, the single pupil eye, stance and grounding — the reference sheet's grammar, where
a house with legs and an eye is a creature.

**All characters have legs (user ruling, 2026-08-17):** the two species legs are always
stamped beneath the grounded mass. Drawn foot protrusions stay part of the contour and
merge with the stance — a drawing whose bottom bumps register as "feet" still stands.

**Silhouette variety (user decision):** bodies are not all round. Triangle bodies, square
bodies, boxy masses, stars — strong primitive silhouettes are first-class species members
(the reference sheet's house/T/figure-8 grammar). Simplification must be
**corner-preserving**: a drawn triangle keeps its three shoulders, softened by hand-wobble
rather than rounded into a blob. The taste ban is on *engineered* hard edges; a wobbled
corner reads drawn and passes. Dev-fallback creatures sample the primitive range too.

Robustness rules (the "not exactly" and "no vector characters" halves):
- **Outline drawings fill**: enclosed regions become solid mass, not inflated rings.
- **Thin/stray lines thicken** to a chunky minimum body thickness (avatar spec: strong,
  chunky silhouette) — a scribble becomes a solid blob, never a wire figure.
- **Simplification + hand wobble + identity jitter** keep it from reading as a tracing.
- Motif extraction still runs (feet/crown/aspect) to place legs, eye, and appendages.

### 1. Drawing → creature: motifs, not replica *(historical — torso synthesis superseded by 1a)*

> User: "The hatched 3D figure should not be an exact replica of what they drew, but it
> should be inspired and have the motifs of what the user drew."

**Ruling: the creature is a species body synthesized from the drawing's measured motifs.**
The pipeline still runs the drawing through analyze() — but what it extracts (archetype,
foot/limb/head leaves with their angles and reach, aspect ratio, thickness profile, contour
lumpiness) now parameterizes a **species template** (irregular blob/egg torso, tiny legs,
optional ears/antennae/horns/tail per the generator brief) instead of being inflated
verbatim. The synthesized silhouette goes through the *same* inflate pipeline — pure,
deterministic, same strokes → same creature on every device.

Recognition is carried by two channels — the body, and a mark on its back:

- **The silhouette IS the drawing** (§1a) — the creature's body is the drawing's own shape,
  filled, smoothed and chunkified, with the motif echo (proportions, limb count and
  placement, top-of-head appendages) shaping its anatomy. Draw something tall with antennae
  and two legs → a tall two-legged creature with antennae. This is the channel that reads
  from any angle and at any distance; it carries the recognition on its own.
- **The marking, on the BACK only** — the original drawing painted onto the rear face of the
  body shell as a light knockout, so the literal mark travels with the creature without ever
  facing the camera the eye faces. `src/character/marking.ts`.

#### The marking's record — removed, then put back on the back *(both 2026-08-18)*

Two user rulings on the same day. Both stay on the record; the second supersedes the first.

1. **Removed** *(user: "after the egg hatches lets remove the actual drawing on the
   creature")* — the front/belly marking went, and `src/character/marking.ts` with it.
   Measured on the phone portrait at the time: pixels deviating from the body value by >0.10
   luma fell 26.9% → 17.5%, and what remained was the eye (13.0%) plus the material's
   stepped sheen (4.5%). The reason was composition, and it still holds for the FRONT: the
   drawing printed across the face the eye is on made the hatch a restatement instead of a
   reveal.
2. **Reinstated, on the back** *(user: "actually let's add the drawing back but let's put it
   on the creature's back")* — **superseding (1).** The mark returns, on rear-facing surfaces
   only. It is the reward for watching a creature walk away from you; head-on, the creature
   is still one solid near-black mass whose only mark is the eye, which is what (1) was
   protecting.

**Standing user override vs. `docs/reference/avatar-prompt.md`.** The avatar spec asks for
"ONE uniform solid black fill — no patches, spots, stripes, or two-tone markings anywhere;
the only white is the eyes." A back marking is a marking, so the conflict is real and is not
resolved — it is **overridden by user ruling (2)**, recorded here the same way the shipped
`SURFACE.ground` value is recorded as a standing override in `CLAUDE.md`. What the override
does *not* touch: the mark is a knockout in the light role, never a darkening; it is
black-and-white only; and it fades to nothing at the rim, so the avatar spec's actual
subject — the head-on silhouette — is untouched. Measured on the rear-projection build:
**0.000% of the front silhouette differs from a no-marking control** (max absolute luma
delta 0.0000 over 102k and 139k silhouette pixels, two test drawings), while from behind the
mark covers 7.1% and 15.8% of the silhouette, 100% of it lighter.

Constraints the marking must keep holding:

- **Rear-facing only.** The eye fades in on `+normal.z`; the marking fades in on `−normal.z`.
  Local +z is the creature's travel direction (`behavior/agent.ts` emits
  `vx = sin(heading), vz = cos(heading)`, and the manager sets `root.rotation.y = heading`).
- **Mirrored `u`.** A rear box projection viewed from behind puts object +x on the viewer's
  left, so the texture coordinate is flipped — otherwise the drawing reads reversed.
- **Knockout, never a darkening.** The body is the one near-black on screen (TASTE §1).
- **Rim fade.** `smoothstep(0.05, 0.5, −nz)` — nothing at the silhouette edge, so the
  distant read is one solid mass.
- **Seeded jitter.** Stamp offset and tilt come from the identity id, never `Math.random`.

**The egg is untouched.** It still wears the raw drawing and paints it on over the primary
token as it spawns — that is the egg's whole point. The verbatim-inflation path stays in the
codebase as the `fidelity 0` end of the dial (dev-tunable), but the shipped default is
interpretation.

### 2. Creature color — none. Black and white, by user decision

The brief offered an audience primary color constrained by the Ref palette. **The user has
since ruled: no color at all — the whole experience is black and white for now.**

- The audience color input is dropped from the creation flow (the vendored draw page's
  color swatches are ignored on ingest — strokes rasterize to a binary mask regardless).
- The single warm accent `#fb5429` is retired with it: the hatch ring and the minimap
  self-marker render in ink/light values instead. The token stays defined in
  `tokens.ts` for when color returns; nothing may reference it until then.
- Creature bodies are uniform dark ink (`CHARACTER.body`); identity comes from silhouette,
  stance, name, and behavior — which is truer to the corpus (solid black birds
  distinguished by posture alone) anyway. The one exception is the back marking (§1), and it
  is achromatic too: a knockout in the light role, no hue.

Under a future chromatic Ref collection, color re-enters through the ref-config layer,
not through per-creature inputs.

## New systems (wave 2)

### Behavior (`src/behavior/`)

Lightweight state machine per creature:
`idle · wander · look-around · approach-creature · follow-creature · observe-object · sit ·
sleep · play · explore`

- **Stillness is a state, not an absence.** Creatures frequently stop; stopped creatures
  keep the ambient floor + blink + occasional look-around. Movement is slow and measured;
  no hyperactive hopping.
- **Hidden personality** `{ energy, curiosity, social, playfulness, sleepiness } ∈ [0,1]`
  biases transition probabilities only — never inspectable in UI, only experienced.
  Derived from the audience personality answer:

| answer | biases |
|---|---|
| friends | social↑, playfulness↗ |
| snacks | curiosity↗, wander target = motifs |
| sleep | sleepiness↑, energy↓ |
| adventure | energy↑, curiosity↑, travels far |
| chaos | playfulness↑, energy↗, transition noise↑ |

- **Social**: notice nearby creatures → look / approach / walk together / follow / sit
  beside / inspect / ignore. Subtle; the target emergent moment is two creatures
  independently sitting beside each other.
- **Environmental affordances**: scatter units advertise simple verbs (tree → sit beneath,
  inspect; flower → look; pond → stare; rock → sit; artifact → investigate; house →
  linger). No inventories, no quests.
- Deterministic per-creature seeds; all steering through ζ≥1 heading springs.

### Scale + camera

- Creature ≈ 1–3% of viewport: frustum height 40 → ~90, creature height 3.5 → ~2.2.
  The world stays the hero; never portrait-framed on the big screen.
- Camera: slow drifting tour, easing near clusters, frequent wide compositions; never
  locked to one creature.
- **Hatch-all moment** (presentation): pull wide → many eggs scattered → simultaneous
  hatch → hold while dozens begin moving → drift through the populated world.

### Terrain

The map (`src/world/landscape.ts`, PURE — no Three.js, no DOM, no clocks, no `Math.random`)
has grown since the layout above was first drawn, and it now has height. Scatter covers
±160, creatures roam within 100, the camera pans to ±200, and the minimap reads ±175 [D] — far
enough apart that a 40-radius forest to the west (plus a spur), a four-mass range along the
far north, a 42-radius lake holding a 14-radius island — offset back toward the origin, with
water all the way round it and no causeway: nothing walks there [D] — and four corner ponds
each keep ≥20 units of open field from their nearest neighbor and ≥40 from the hatch
clearing [D].

`terrainHeight` (`TERRAIN =`) is a two-octave value-noise field plus region shelves (forest
+2.5, range +6), snapped onto 1.6-unit tiers with rounded risers [D] — a smooth swell reads as
nothing in an orthographic ink render, a staircase reads as height. Every water body sinks its
whole disc — the island it holds included — to one level 1.5 below the land it sits in, and
the island then climbs back out of that basin from the waterline through two contour tiers to
a crown 3.2 above the water [D]. The hatch clearing stays exactly flat, and the field fades to
0 by radius 185 so it meets the flat outer ground disc without a seam. Measured: heights run
−3.1 to +8, max slope 0.55 over the field and 1.15 on the island's bank — the one landform
measured against a bound of its own, because 3.2 units of rise cannot be spread across a
14-unit island at the field's gradient.

The `Surface` seam PLAN §7.2 promised has shipped (`src/world/surface.ts`): `ROLLING_SURFACE`
wraps this terrain, `FLAT_SURFACE` stays for the phone stage and tests, and every consumer —
ground mesh, scatter, shadow stamps, water, creatures, eggs, the hatch — samples one or the
other rather than deriving a height of its own. Locomotion still never touches world-space Y.
A `SphereSurface` behind the same seam remains open for later.

Water colliders are now a hex tiling of small hard circles approximating each body, not a
ring [D].

### Ink rendering pass *(reference-locked by user)*

The user supplied three reference frames and the instruction: *"the 3D version in the world
should look more hand-drawn and illustrated, with rough edges, exactly like the reference."*
The reference read, which is now the render target:

- **Forms are light, paper-filled shapes** — trees are near-white blobs — carried entirely
  by **rough, wobbly dark ink outlines** and interior hatch/scribble marks. Not solid
  grey masses.
- **The character is the only solid black mass** in the frame (both game references agree).
- **Steep/shaded faces read as hatching** (the cliff sides in reference 2) — line density
  does the work of shading. No smooth gradients.
- **Ground is paper**: light, with tiny tick marks and stipple; the existing grain pass
  supplies the paper tooth.
- **Edges are rough.** Outlines wobble like a pen line, not like a extracted contour.

Implementation: screen-space edge detection over depth+normals composited in the existing
post chain, with the edge line distorted by low-frequency noise for the hand wobble;
procedural hatching keyed to face orientation; prop albedos at the light token so the
outline carries the form. The character keeps its restrained sheen and near-black fill.

**Toon quantization is required** *(user: "I really want the 3D world to feel like a toon
shader hand-drawn illustration")*: surface shading quantizes into 2–3 flat cel bands —
no smooth lambert gradients anywhere. The character's sheen reads as one stepped highlight
band, not a smooth specular. Flat bands + rough contours + hatching + paper grain is the
complete look.

### Audience inputs (phone)

`name · drawing · primary color · personality` — the vendored draw page already carries
name + color + drawing; add the one personality question ("what does your little creature
want most?" — friends/snacks/sleep/adventure/chaos) and include it in the MQTT payload.
Payload stays backward-compatible (missing personality → neutral defaults).

### Presentation controls (Ghost Panel)

`refworld.demo` skill: spawn pending · spawn fallback creatures · hatch selected · hatch
all · pause ai · resume ai · clear creatures · reset world. Optional tuning: wander speed,
interaction frequency, population density, camera mode.

### Ref-config layer (`src/taste/refConfig.ts`)

The brief's shape, mapped onto the token module:

```jsonc
{
  "world":     { "palette": [], "materials": [], "lighting": {}, "environment": {},
                 "shapeLanguage": [], "mood": [], "density": 0.39 },
  "creatures": { "proportions": {}, "materials": [], "markingRules": [],
                 "accessoryLanguage": [], "animationStyle": "", "behaviorBias": {} }
}
```

One default export = the current collection. Everything downstream reads config, not
constants, so a new Ref brief swaps the world without touching systems. (Already ~true via
`tokens.ts`; this makes the seam explicit and creature-specific.)

## Scale target

`creature relative world scale ≈ 0.02` · creatures 1–3% of viewport · dozens of tiny
inhabitants · the landscape reads first.
