# ref-world — agent notes

Shared isometric Three.js world. Phones draw characters; drawings become eggs; eggs hatch;
phones emote and track their character on a minimap.

## Before any visual or motion work

Read [`docs/TASTE.md`](docs/TASTE.md) — the arbitration between two briefs
([character](docs/taste/character.md), [world](docs/taste/world.md)) that conflict in six
places. **The arbitration wins over either brief.** The traps, in order of how easily they
get violated:

- **No overshoot, no bounce, no hard cuts, no abrupt stops.** Every spring runs at damping
  ratio **ζ ≥ 1.0** — the solver clamps this at the API boundary so underdamped motion is
  unrepresentable. Entrances **slide**; they never `scale: 0 → 1` or pop. Primary movements
  are **1823ms**. Nothing ever fully arrests — an ambient drift floor runs under everything.
  ⚠️ This directly contradicts the vendored `apple-design` skill. The arbitration wins.
- **`#080808` belongs to characters only.** The character is the *only* high-contrast object
  on screen (88); the world sits muted at 32. That differential is the composition, not an
  inconsistency to smooth out.
- **Shadows are hard-edged and flat-filled.** Single value, cut sharp, no penumbra, no PCF,
  no AO. Not Three.js default shadow mapping.
- **No rectilinear or engineered geometry.** The isometric grid governs *placement*, never
  *form*. If a shape looks constructed from primitives, it's wrong.
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

## Taste gates

TASTE §8 defines six verification gates (grayscale, contrast histogram, damping audit,
uppercase scan, stillness probe, density probe). They ship as Ghost Panel controls and
build-time checks, not as review checklists — a constraint that isn't a button doesn't
survive a build. Keep them working.

## Skills

`.claude/skills/` is vendored — see its README for provenance. Two cautions:
`apple-design` recommends overshoot (forbidden here — see above), and
`threejs-aaa-graphics-builder` pushes photoreal art direction (use for render budgets and
LOD only).
