# ref taste brief — character

> Source: user-supplied brief. Governs the **character mark**: silhouette, fill, eyes, gloss.
> Treat the Constraints section as a hard gate.
>
> The environment layer has its own brief in [`world.md`](./world.md), which also governs
> **all motion in the project**. Where the two disagree, [`../TASTE.md`](../TASTE.md) is the
> arbitration and it wins.

## Essence

A set of standalone character marks: single-color silhouette creatures, each built as
one solid shape with **eyes as the only interior detail**, floating alone in a field of
white. The vocabulary is mascot-logo design rather than illustration — every figure reads
instantly as a mark that could sit on a badge or app icon. The set holds a tension between
playful, rounded creature forms and a hard graphic-design discipline of restraint: no color,
no texture, no ornament beyond the eye.

Optimizes for clarity over density. Gives the subject room. Type carries secondary
information without competing with the image. Light stays legible rather than atmospheric
or dramatic. The source corpus commits fully to stillness.

## Taste scores

| Axis | Score | Meaning |
|---|---|---|
| Contrast | 88/100 | Solid black on untouched white. No midtones or gradients breaking the silhouette. |
| Density | 18/100 | One character occupies a small fraction of the frame; the rest is deliberate open space. |
| Structure | 22/100 | Hand-drawn, organic. Freeform curves and irregular limbs — no grid, no module. |
| Hierarchy | 58/100 | Exactly one subject per frame. Total but simple hierarchy — a single dominant mark. |
| Material realism | 38/100 | Mostly flat matte fill, but a gloss sheen / reflective highlight appears across most of the set. Just short of purely graphic. |

## Draws on

- **Comme des Garçons Play heart logo** — the eyes-in-shape mark; Filip Pagowski's naive,
  hand-scrawled reworking of a commercial logo into folk-art illustration.
- **Folk woodcut / stamp illustration** — rough-edged single-color marks that read like a
  hand-carved woodblock or rubber stamp, where one cut plate produces the whole solid shape.

## Direction (soft — hold unless the task demands otherwise)

- Build each character as a **single flat silhouette** with the eye as the only interior mark.
- Leave generous negative space around every figure so it reads as an isolated mark, not a scene.
- Keep silhouettes organic and hand-drawn rather than constructed from geometric primitives.
- Let a quiet **gloss or reflective highlight** sit on the black fill instead of leaving it fully matte.
- Eyes are always the expressive anchor — dots, crescents, or cutout ovals. Never fully rendered features.
- Bird and creature anatomy recurs (beak, wing, waddle, perched pose) even as drawing style
  varies from crude to refined.
- **Typography** — restrained in scale, weight, and frequency. Let the image lead.
- **Spacing** — density near low; regular rhythm between elements.
- **Color** — bright grounds at muted saturation. Treat hue as incidental.
- **Graphics** — favor `icon` over introducing a new mark type.
- **Motion** — the source corpus is static. See "Motion note" below.
- **Composition** — rounded, curved geometry with feathered edges, at low density.

### Pairings to keep intact

- Muted saturation + open generous spacing.
- Muted saturation + gloss finish + reflective surface.
- Open generous spacing + gloss finish + reflective surface.

## Constraints (hard — never cross these)

- No packed frames. The composition always leaves room to breathe.
- No rectilinear geometry with hard edges. Forms stay organic or softened.
- No neon saturation. Color stays quiet even at full warmth.
- No hard rectilinear or symmetrical geometry that would make a mark feel *engineered*
  rather than *drawn*.
- No saturated or neon color; the palette stays quiet even where warmth appears.

## Tokens

```json
{
  "palette": [
    { "role": "ground",  "value": "#080808", "usage": "Base fields and backgrounds." },
    { "role": "light",   "value": "#f4f3ef", "usage": "Highlights and light-struck surfaces." },
    { "role": "neutral", "value": "#bcbab7", "usage": "Supporting tone; safe in secondary elements." },
    { "role": "neutral", "value": "#8e908d", "usage": "Supporting tone; safe in secondary elements." },
    { "role": "neutral", "value": "#44413c", "usage": "Supporting tone; safe in secondary elements." },
    { "role": "neutral", "value": "#fb5429", "usage": "Supporting tone; safe in secondary elements." }
  ],
  "tokens": {
    "typography": { "present": "sparse" },
    "spacing":    { "density": 0.225, "rhythm": "regular" },
    "color":      { "saturation": 0.154, "contrast": 0.908, "groundLuma": 0.924 },
    "graphics":   { "kinds": ["icon", "ruleLine"], "coverage": 1 },
    "composition":{ "density": 0.225 }
  },
  "vocabulary": [
    "silhouette mark",
    "negative-space eye cutout",
    "single-color fill",
    "knockout detail",
    "mono-weight shape",
    "wordless icon mark"
  ]
}
```

## Method

Create new, non-derivative work in this taste. Do not copy, trace, or recombine the
source references.

---

## Motion note

This brief calls the corpus a **static system**. The world brief supplies the "new source
evidence" it asks for, and ships explicit motion tokens — so **motion follows
[`world.md`](./world.md)**, arbitrated in [`../TASTE.md`](../TASTE.md) §2.1.

What survives from *this* brief is the constraint on **what** moves, not how:

- Animate the **whole silhouette** (squash, bob, lean, rotate). Never animate interior
  detail into existence.
- The eye is the expressive channel. Emotes are carried by eye shape and body deformation
  — never by added features, sweat drops, motion lines, or speed streaks.
- No motion blur, no trails, no particle spray. Those introduce midtones and break the
  88/100 contrast score.
- Every frame of every animation must still read as a valid still from this corpus: one
  solid silhouette, eyes as the only interior detail, generous negative space.

Note that the world brief **forbids overshoot and bounce**, so classic squash-and-stretch
rebound is out. See the arbitration.

## Palette

Applied palette for the whole project — including which surfaces this brief's tokens do and
don't govern — lives in [`../TASTE.md`](../TASTE.md) §6.

The one rule to carry from here: `#080808` belongs to **characters only**. Nothing in the
environment may approach it.
