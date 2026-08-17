# ref-world

A shared isometric WebGL world. You draw on your phone, your drawing becomes an egg, the egg
hatches, and your character walks around a world you watch on the big screen — while your
phone becomes its controller.

Built with Three.js, in a fixed illustrated taste: stark single-color silhouette creatures,
tiny inside enormous soft hand-drawn environments.

> **Status: planning.** No implementation yet.

## Read these first

| Doc | What it is |
|---|---|
| [`docs/TASTE.md`](docs/TASTE.md) | **The arbitration.** Two art briefs govern this project and they conflict in six places. This resolves them, and it wins over either brief. |
| [`docs/taste/character.md`](docs/taste/character.md) | The character brief — silhouette, fill, eyes, gloss |
| [`docs/taste/world.md`](docs/taste/world.md) | The world brief — environment, lighting, camera, type, and all motion |
| [`docs/PLAN.md`](docs/PLAN.md) | Technical plan, architecture, and phasing |
| [`.claude/skills/README.md`](.claude/skills/README.md) | Vendored agent skills and their provenance |

## The loop

1. **Draw.** One black brush on a cream canvas on your phone. Nothing else.
2. **An egg appears** in the shared world, painting itself with your strokes.
3. **It wobbles, cracks, and hatches** — automatically after a while, or when you trigger it.
4. **Your character walks out**, loosely derived from what you drew.
5. **Your phone becomes its controller** — your character rendered on your own screen, an
   emote wheel, and a minimap showing where it is in the world.

Many phones, one world. Game feel is modeled on the Chao from *Sonic Adventure*: hatch from
an egg, waddle around, emote at you.

## How a drawing becomes a character

No 3D generation model in the critical path. The taste is flat black silhouettes, so a
person drawing in black ink is already producing art in the target style. The pipeline
inflates that silhouette into a rounded volume, reads its limbs off the medial axis, and
drives it procedurally.

It runs on-device in under a second, works offline, and is **deterministic** — which is what
lets your phone render your character locally from the same strokes instead of streaming
video from the world.

Details in [`docs/PLAN.md`](docs/PLAN.md) §1 and §3.

## The two-brief tension

The character brief wants stark black marks at 88/100 contrast in near-empty frames. The
world brief wants muted pastel environments at 32/100 contrast built from scattered
hand-drawn units. Read together, that's exactly the image the world brief describes: *a tiny
inhabitant lost in an enormous field.* The contrast differential **is** the composition.

The conflicts that don't resolve so neatly — motion especially, where the character brief
calls the corpus static and the world brief forbids overshoot and bounce — are ruled on in
[`docs/TASTE.md`](docs/TASTE.md).

## Dev surface

[Ghost Panel](https://github.com/epun/ghost-panel) is the in-scene inspector. `shift+d`
toggles it. Project controls — inflater `fidelity` dial, egg crack scrub, emote preview, and
the six taste verification gates — register as Ghost Panel skills, gated behind `isDev`.
