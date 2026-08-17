# ref-world

An isometric WebGL world where a drawing you make on your phone becomes an egg, hatches,
and walks around as a character.

Built with Three.js, in a fixed illustrated taste: single-color silhouette creatures with
eyes as the only interior detail, on a field of white.

> **Status: planning.** No implementation yet.

## Read these first

| Doc | What it is |
|---|---|
| [`docs/TASTE.md`](docs/TASTE.md) | The character/art taste brief. Hard constraints — read before touching anything visual. |
| [`docs/PLAN.md`](docs/PLAN.md) | Technical plan, architecture, and phasing. |
| [`.claude/skills/README.md`](.claude/skills/README.md) | Vendored agent skills and their provenance. |

## The idea

1. You draw on your phone. One black brush, white canvas — nothing else.
2. An egg appears in the world, painted with your drawing.
3. It wobbles, cracks, and hatches.
4. Your drawing walks out as a 3D character — and the head-on silhouette is exactly
   what you drew.
5. You steer its emotes from your phone.

Game feel is modeled on the Chao from *Sonic Adventure*: hatch from an egg, waddle around,
emote at you.

## How the drawing becomes a character

No 3D generation model in the critical path. The taste is flat black silhouettes, so a
person drawing in black ink is already producing art in the target style. The pipeline
inflates that silhouette into a rounded volume, finds its limbs, and drives it
procedurally — on-device, in under a second, offline, and pixel-faithful to the drawing.

Details in [`docs/PLAN.md`](docs/PLAN.md) §1 and §3.

## Dev surface

[Ghost Panel](https://github.com/epun/ghost-panel) is the in-scene inspector. `Shift+D`
toggles it, `Shift+A` opens the add menu. Project-specific controls (inflater params, egg
crack scrub, emote preview, palette grayscale test) register as Ghost Panel skills and are
gated behind `isDev`.
