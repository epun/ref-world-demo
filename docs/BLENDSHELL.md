# character v2 — SDF blend-shell + procedural stepping

> Source: user-supplied resource (the "SDF blend-shell" write-up + procedural-animation
> notes). Standing instruction: **keep our original style** — everything here renders
> inside the existing taste (black and white, ink outlines, toon bands, paper grain,
> drawn-motif creatures). This is a construction and locomotion upgrade, not an art pivot.

## The technique (from the resource)

- Characters are built from **plain capsule/cone primitive meshes merged into one draw**.
- A vertex shader **snaps every vertex onto the smooth-min SDF surface** of all shapes
  combined — overlapping shapes converge onto one blended surface and seams cease to exist.
- **Normals come from the SDF gradient** (lighting flows continuously across joints).
- Ordinary mesh rendering — no raymarching, no skinning; per-vertex cost, mobile-fast.
- Robustness: **outlines project onto the SDF offset surface** (no inverted-hull artifacts
  in concave joints), buried geometry tucks under the skin, thin parts (antennae) cap
  their blend radius so they don't dissolve.
- Animation is **entirely procedural**: reactive IK stepping (2/4/6 legs from one system),
  squash-stretch state machines for hoppers, physics-rope tails/ears whose segments are
  SDF primitives too — fused while flopping.
- **A character is ~15 lines of JSON** — endless generatable critters, always seamless.

## Why it fits us exactly

1. **The motif pipeline already produces the JSON.** `extractMotifs` measures torso
   aspect/fullness, foot angles, limb heights, crown appendages, lumpiness. Those are
   precisely the parameters of a primitive-set description: torso capsule + head sphere +
   leg capsules at the measured angles + crown cones. The species interpretation stays;
   only the body construction changes downstream of it.
2. **SDF-offset outlines are a cleaner per-character ink line** than screen-space edges —
   they follow concave joints without artifacts, matching the drawn-contour goal.
3. **Reactive stepping is the real answer to "actual walk cycles"** — the shear-based gait
   (v1, shipping) reads as stepping; IK feet that plant and swing with per-step wobble and
   clamped extension read as *walking*.
4. **Blend radius = hand-sculpted softness** — the "organic or softened, never engineered"
   constraint enforced by construction.

## Our-style pins (what "keep our original style" means concretely)

- Body stays the **one near-black mass**; SDF proximity color-blending is used only for
  the subtle light **marking** projection and eye knockouts — never hue.
- Toon quantize + grain + hatch stay as the frame-level passes; SDF gradient normals feed
  the same cel bands.
- Outline: SDF-offset shell drawn in ink with the same wobble treatment as the world pass.
- Motion law unchanged: steps are reactive, springs stay ζ≥1, stops complete their stride,
  ambient floor persists. Squash-stretch state machines are allowed as continuous
  locomotion rhythm but never rebound past rest (no bounce, confidence 1.00).
- Eyes remain the only facial detail (the SDF head is still a silhouette with knockouts).

## Adopted implementation notes (from the procedural-animation resource)

- **IK is the standard** — two-segment analytic IK per leg, driven from foot targets.
- **Foot placement**: step targets ahead of travel via the `Surface` interface (flat now,
  sphere later — the seam finally earns its keep); no raycasts needed on analytic ground.
- **Per-step wobble** on targets so steps never repeat mechanically.
- **Clamp foot glue / max extension** so legs never overreach.
- **Spring/verlet secondary motion** for ears/tails/antennae as SDF rope segments —
  ζ≥1 damped, floppy but never bouncing.
- **Hybrid is the practical path**: the v1 vertex-gait remains as the low-LOD / distant
  path; blend-shell creatures take over near the camera.

## Plan

| Step | What |
|---|---|
| 1 | `src/character/blendshell/spec.ts` — pure: Motifs → primitive-set JSON (the ~15-line character) |
| 2 | `blendshell/shell.ts` — merged primitive mesh + vertex-snap shader (smooth-min, gradient normals, blend-radius caps) |
| 3 | `blendshell/outline.ts` — SDF-offset outline shell in ink |
| 4 | `blendshell/step.ts` — reactive IK stepping (2/4 legs), per-step wobble, clamped extension, stride completion on stop |
| 5 | `blendshell/secondary.ts` — verlet ropes for ears/tails as fused segments |
| 6 | Integration behind a flag: `createCharacter(..., { construction: 'blendshell' \| 'inflate' })`, default flipping after visual review |

Launches after the v1 gait workstream lands (same files).
