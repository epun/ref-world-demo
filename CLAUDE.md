# ref-world — agent notes

Shared isometric Three.js world. Phones draw characters; drawings become eggs; eggs hatch;
phones emote and track their character on a minimap.

## Before any visual or motion work

Read [`docs/TASTE.md`](docs/TASTE.md) — the arbitration between two briefs
([character](docs/taste/character.md), [world](docs/taste/world.md)) that conflict in seven
places. **The arbitration wins over either brief.**

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
- **The ground is mid-toned grey (`groundLuma 0.74`), not cream or white.** There is **no
  pastel green or pink** in this taste; it is near-achromatic (`saturation 0.188`).
  ⚠️ **Standing user override:** the shipped `SURFACE.ground` is `#dfdfdf` (luma ~0.87) —
  lighter than the measured target — picked in the panel's color picker and exported as the
  default. `COLOR_METRICS.groundLuma` keeps the measured 0.74; the value-histogram gate
  measures against the configured paper and prints the drift. Don't "correct" it back.
- **Grain is a full-frame post-process, never a material.** It must not vary across a
  character's fill or the silhouette stops reading as one solid shape.
- **UI is `icon` + `ruleLine` + `border` only.** No filled panels, no cards, no shadows under
  UI. That mark set is the world brief's #1 defining signal.
- **Shadows are hard-edged and flat-filled.** Single value, cut sharp, no penumbra, no PCF,
  no AO. Not Three.js default shadow mapping.
- **No rectilinear or engineered geometry.** The isometric grid governs *placement*, never
  *form*.
- **No uppercase type. Anywhere.** Room codes render `xkcd`, not `XKCD`.

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

## Running the room

[`docs/RUNBOOK.md`](docs/RUNBOOK.md) — one page, read before a demo. The part
worth knowing here: a refreshed projection **heals itself**. The world
announces its epoch retained, handsets re-publish their own drawing under the
same id, and the pure pipeline rebuilds the identical creatures. `shift+R` is
the manual path (local log first, then a recall) and it always reports on
screen what it did — shifted because the ghost panel owns plain `r`. Never reach for *replay* to
recover — that re-runs a session at its recorded pace; *restore* is the one
that applies the whole log at once (docs/SESSION.md §4a).

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
