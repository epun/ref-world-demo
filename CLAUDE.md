# ref-world — agent notes

Isometric Three.js world. A drawing becomes an egg, hatches, and walks around.

## Before any visual work

Read [`docs/TASTE.md`](docs/TASTE.md). Its **Constraints** section is a hard gate, not a
suggestion. The three that get violated most easily:

- **No midtones.** Solid `#080808` on `#f4f3ef`. No gradients across the silhouette, no
  cast shadows smeared over the ground, no motion blur or particle spray. Contrast is
  scored 88/100 and everything must survive a grayscale test.
- **No rectilinear or engineered geometry.** Forms stay organic and softened. If a shape
  looks constructed from primitives, it's wrong.
- **Nothing packed.** Density sits at ~20/100. Open ground is the design, not an
  unfinished area to fill.

`#fb5429` is the only warm accent, and at most one accent element is on screen at a time.

## Architecture

[`docs/PLAN.md`](docs/PLAN.md) is the source of truth. Key invariants:

- **The user's drawn silhouette is inviolable.** Viewed head-on, the character must match
  the drawing exactly. Nothing — not a vision model, not a smoothing pass, not a stylizer —
  may alter it.
- **No skeletal animation.** Characters are generated blobs deformed in a vertex shader
  from a few uniforms. There are no bones and no GLTF rigs.
- **`src/shape/` is pure.** Contour tracing, distance transform, skeletonization, and
  feature extraction take data in and return data out. No Three.js imports, no DOM. It's
  the highest-value test surface in the repo.
- **Locomotion goes through the `Surface` interface**, never through world-space Y. That
  seam is what lets the flat map become a sphere planet without a rewrite.
- **Everything in `src/dev/` is gated on `isDev`** and must tree-shake out of the demo build.

## Motion

The source corpus is static. The resolution: every frame of every animation must still read
as a valid still from the corpus — one solid silhouette, eyes as the only interior detail.
Animate the whole shape (squash, bob, hop, lean); never animate interior detail into
existence. Springs, not linear tweens. The camera holds still.

`.claude/skills/apple-design` and `.claude/skills/animate` are the references for this.

## Skills

`.claude/skills/` is vendored — see its README for provenance. One caution:
`threejs-aaa-graphics-builder` pushes photoreal/AAA art direction, which is directly against
this project's taste. Use it for render budgets and LOD only.
