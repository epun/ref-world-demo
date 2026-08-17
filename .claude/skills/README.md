# Vendored skills

Skills pulled in for this project, indexed via [ui-skills.com](https://www.ui-skills.com/skills)
and vendored from their upstream GitHub sources.

> **Note:** `ui-skills.com` is blocked by this environment's network egress proxy, so the
> skills were fetched from the GitHub repositories the directory points at rather than
> through the site itself.

| Group | Upstream | Commit | License |
|---|---|---|---|
| Motion & design engineering | [emilkowalski/skills](https://github.com/emilkowalski/skills) | `78761e1` | MIT © Emil Kowalski |
| Three.js core | [CloudAI-X/threejs-skills](https://github.com/CloudAI-X/threejs-skills) | `b1c6230` | not stated upstream |
| Game systems | [majidmanzarpour/threejs-game-skills](https://github.com/majidmanzarpour/threejs-game-skills) | `7221c1f` | MIT © Majid Manzarpour |
| 3D vocabulary | [epun/ghost-panel](https://github.com/epun/ghost-panel) | `.claude/skills/3d-vocabulary` | MIT © Evan Pun |

## What's here

**Motion & design engineering** — `animate`, `animation-vocabulary`, `review-animations`,
`improve-animations`, `find-animation-opportunities`, `apple-design`, `emil-design-eng`,
`prototype`

`apple-design` is the load-bearing one for this project: spring physics, interruptible
gesture-driven motion, and velocity inheritance are exactly what the drawing input and
character locomotion need. `animate` and `review-animations` are the build/critique pair
for any motion work.

**Three.js core** — `threejs-fundamentals`, `-geometry`, `-materials`, `-textures`,
`-lighting`, `-shaders`, `-animation`, `-loaders`, `-interaction`, `-postprocessing`

**Game systems** — `threejs-game-director`, `threejs-gameplay-systems`,
`threejs-game-ui-designer`, `threejs-aaa-graphics-builder`, `threejs-debug-profiler`,
`threejs-qa-release`

`threejs-gameplay-systems` (game loop, entities, input, camera, game feel) and
`threejs-game-ui-designer` (HUD, touch UI, safe areas) are the relevant ones.
`threejs-aaa-graphics-builder` pushes toward photoreal/AAA polish, which is **against**
this project's taste — consult it for render-budget and LOD technique only, and ignore its
art direction.

**3D vocabulary** — maps fuzzy 3D intent ("make it shiny", "soften the shadows") to the
precise Three.js property to change.

## Not vendored

Three skills from `threejs-game-skills` require third-party API keys and are **not** used
by the current plan:

- `threejs-3d-generator` (Tripo) — text/image-to-3D. Superseded by the silhouette-inflation
  pipeline in [`docs/PLAN.md`](../../docs/PLAN.md) §1.
- `threejs-image-generator` (Gemini) — 2D concept/texture art.
- `threejs-audio-generator` (ElevenLabs) — SFX and voice.

They are present in the directory but inert without credentials. Remove them if the noise
in the skill list becomes a problem.

## Skipped

From `emilkowalski/skills`: `ask-sonner` (toast library, not relevant) and
`pick-ui-library` (stack already chosen).

## Updating

```bash
git clone --depth 1 https://github.com/emilkowalski/skills /tmp/emil
cp -r /tmp/emil/skills/<name> .claude/skills/<name>
```
