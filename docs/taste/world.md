# ref taste brief — world

> Source: user-supplied brief. Governs the **environment** layer: ground, terrain, props,
> scatter units, lighting, camera, type, and **all motion in the project**.
>
> The character layer has its own brief in [`character.md`](./character.md). Where the two
> disagree, [`../TASTE.md`](../TASTE.md) is the arbitration.

**Task:** 3d isometric world in the style of 2d hand illustration

## Essence

A worldbuilding illustration board built around the tension between a **tiny inhabitant and
an enormous, hand-drawn environment**: a rabbit lost in a graveyard field, a jogger swallowed
by a forest, a lone raver on a planet-sized Earth.

The visual language moves fluidly between pixel-art, isometric cartography, and loose
pen-and-ink, but every piece insists on the same device: **scatter small repeated units**
(trees, houses, birds, doodads) across a large negative field so **scale itself becomes the
subject**. Color, when it appears, stays muted and pastel rather than graphic or saturated.

This system optimizes for a balance of clarity and density. Type carries secondary
information without competing with the image. Light stays legible rather than atmospheric
or dramatic. Motion is occasional rather than constant; where it appears it stays measured,
with a deliberate graphic layer reinforcing structure rather than decorating it.

## Taste scores

| Axis | Score | Meaning |
|---|---|---|
| Hierarchy | 72/100 | Nearly every frame anchors one small figure or landmark against a huge undifferentiated field — a hard one-plus-environment reading order even without type. |
| Density | 45/100 | Swings between crowded village maps / forest tangles and near-empty ink fields with a single wandering character. Mid-range on average. |
| Structure | 48/100 | Isometric village and mountain maps hold a real grid and consistent unit spacing; ink doodles and forest scenes are placed by eye. Loose-grid territory overall. |
| Contrast | 32/100 | Mostly monochrome ink on cream, or pastel duotone. Even the planet and album cover keep values close and gentle rather than punching black against white. |
| Depth | 50/100 | Isometric maps and the atmospheric pixel planet build real spatial layering; the pen-and-ink pieces stay flat line-on-paper with no shading depth. |
| Type treatment | 58/100 | The Plantasia cover carries a bold rounded display wordmark doing real graphic work; the rest of the set carries no type at all. Considered but occasional. |

## Draws on

- **Mother Earth's Plantasia LP art** — direct homage to the 1976 Mort Garson synth album,
  itself part of 70s new-age and countercultural plant-music packaging.
- **Isometric RPG cartography** — the village and mountain map draws on tabletop hex-map and
  Zelda-style overworld cartography, rooted in medieval manuscript map illustration.
- **Pixel-art planet iconography** — the ringed-planet sprite echoes 8-bit and 16-bit era
  space sprites, tracing back to early console sci-fi game art.

## Direction (soft — hold unless the task demands otherwise)

- Place the subject **small** within a much larger field to establish world scale before detail.
- Build environments from **repeated small hand-drawn units** rather than large solid shapes.
- Muted pastel color over saturated or high-contrast palettes.
- Loose, hand-drawn line quality **even inside structured or isometric layouts**.
- A single small character or creature dropped into a much larger environment, so the frame
  reads as a world, not a portrait.
- Ink and pencil linework stays loose and hand-drawn even when the underlying layout is an
  isometric grid.
- Negative space is the dominant compositional material — sparse marks scattered across
  large empty fields.
- Environments are built from repeated small units (trees, houses, birds, graves) rather
  than single hero shapes.
- Color is withheld, or kept to muted pastel green and pink. Never used to punch contrast.
- **Typography** — restrained in scale, weight, and frequency. Let the image lead.
- **Spacing** — density near balanced; regular rhythm between elements.
- **Color** — mid-toned grounds at muted saturation. Treat hue as incidental.
- **Visual style** — carry the handcrafted register: match grain, finish, and reflectivity,
  not just color.
- **Graphics** — favor `icon` over introducing a new mark type.
- **Motion** — keep new motion measured and ambient; settle it with **continuous drift, no
  full stop**.
- **Animation** — enter new elements with a **slide**; resolve with continuous drift, no full stop.
- **Animation curves** — time primary movements around **1823ms**; use a **drift settle** curve.
- **Lighting** — light hard, with **sharp shadow edges**; keep the key-to-fill relationship **even**.
- **Composition** — organic, unruled geometry with soft edges, at balanced density.
- **Type** — rounded slab serif, title case, bold, normal tracking. The one legible wordmark
  (*Plantasia*) uses a chunky rounded slab with a looping ligature — playful and retro rather
  than systematic, meant to read as illustration rather than as UI text.

### Pairings to keep intact

- Where hard-edged light appears, a gloss finish follows.
- Muted saturation and hard-edged light recur together.
- Muted saturation arrives with a gloss finish.
- Where even, low-drama light appears, a reflective surface follows.

## Constraints (hard — never cross these)

- **No abrupt stops.** Nothing is cut off mid-gesture.
- **No overshoot and no bounce.** Movement settles by drifting, not springing back.
- **No rectilinear geometry with hard edges.** Forms stay organic or softened.
- **No hard cuts.** Nothing snaps into view.
- **No uppercase type.** Type stays lowercase, mixed, or title case.
- **No neon saturation.** Color stays quiet even at full warmth.

## Tokens

> ⚠️ **The brief's token block was truncated in transmission** — it ends at the opening of
> the `palette` array. The values below are inferred from the prose and marked as such.
> Replace with the real block when available. See [`../TASTE.md`](../TASTE.md) §7.

```jsonc
{
  "palette": [
    // INFERRED — awaiting the real token block
    { "role": "ground",  "value": "#e9e5db", "usage": "Cream paper ground." },
    { "role": "ink",     "value": "#44413c", "usage": "Loose hand-drawn linework. Not pure black." },
    { "role": "pastelGreen", "value": "#b9c9a8", "usage": "Muted vegetation." },
    { "role": "pastelPink",  "value": "#e3bfbc", "usage": "Muted warm accent." },
    { "role": "neutral", "value": "#bcbab7", "usage": "Mid tone." },
    { "role": "neutral", "value": "#8e908d", "usage": "Deeper mid tone." }
  ],
  "tokens": {
    "hierarchy":  0.72,
    "density":    0.45,
    "structure":  0.48,
    "contrast":   0.32,
    "depth":      0.50,
    "typeTreatment": 0.58,
    "animation": {
      "primaryDurationMs": 1823,
      "settle": "drift",
      "enter":  "slide",
      "overshoot": false,
      "bounce": false
    },
    "lighting": { "keyEdge": "hard", "keyToFill": "even" },
    "graphics": { "kinds": ["icon"] }
  }
}
```

## Method

Create new, non-derivative work in this taste. Do not copy, trace, or recombine the
source references.
