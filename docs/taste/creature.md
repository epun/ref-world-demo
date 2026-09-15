# ref taste brief — creature (Pikmin-inspired)

> Source: user-supplied brief, 2026-09-15. Collection: https://www.ref.design/s/xz7tqfhuakbc
> (45 references; JSON at https://api.ref.design/api/share/xz7tqfhuakbc).
> Governs the **creature**: body, stalk, topper, eyes, colourway. **Supersedes
> [`character.md`](./character.md) for the character mark** — see [`../TASTE.md`](../TASTE.md) §8.
> The world brief ([`world.md`](./world.md)) still governs the environment and all motion.

## Essence

A character-illustration board built around a single reusable creature template: a soft
ovoid body with two dot eyes and a stalk sprouting from the head that ends in a leaf, bud,
or flower. Every reference restages that same rig across techniques (flat vector, pixel
art, marker, ink-wash, watercolor) and colorways, treating the stalk-topper as the variable
that carries species identity while the body stays constant. The set favors friendly,
rounded, toy-like forms shown in clean lineups or loose vignettes rather than narrative
scenes.

This system optimizes for clarity over density, giving the subject room. It lets type
carry secondary information without competing with the image, keeps light legible rather
than atmospheric or dramatic, and commits fully to stillness; nothing in the corpus moves,
with a deliberate graphic layer reinforcing structure rather than decorating it.

## Taste scores

| Axis | Score | Meaning |
|---|---|---|
| Density | 45/100 | A handful of creatures spaced out on white or paper ground. |
| Structure | 40/100 | Loosely arranged rows or scattered clusters; hand-composed. |
| Contrast | 55/100 | Bright saturated hues on white; value range within each figure gentle and flat-shaded. |
| Hierarchy | 25/100 | Every creature at the same visual weight. |
| Material and fabrication | 20/100 | Flat color or light ink wash; graphic, not material. |
| Styling | 30/100 | Plain lineup or sticker-sheet display. |

## Draws on

- **Pikmin (Nintendo)** — the stalk-topped creature silhouette and pastel-to-saturated
  color-coding by type; botanical/insect hybrid creature design.
- **Kawaii character-sheet culture** — sticker-sheet and lineup presentation of a full
  roster at uniform scale.

## Direction (soft — hold unless the task demands otherwise)

- Keep the stalk-and-topper as the sole marker of species variation while holding the
  body silhouette constant.
- Render each character in a near-monochrome palette so color itself signals identity.
- Leave open negative space around each figure rather than tiling them edge to edge.
- Keep forms rounded and soft-bodied even for mineral or crystalline variants.
- Every creature keeps the same body-plus-stalk anatomy, with only the head topper (leaf,
  bud, or flower) changing to signal a new variant.
- Bodies stay rounded and organic with no hard angles, even where geometric forms like
  the rock and crystal types appear.
- Color rarely mixes on one figure; each character is a near-monochrome fill in red, blue,
  yellow, purple, pink, or gray.
- Compositions leave generous white or neutral ground around each figure.
- Facial expression is minimal and consistent: two dot or oval eyes, no mouth or a simple
  line.
- typography: restrained in scale, weight, and frequency; let the image lead.
- spacing: density near low; regular rhythm.
- color: warm, bright; saturation vivid.
- visualStyle: carry the handcrafted register — grain, finish, reflectivity, not just color.
- graphics: favor icon over introducing a new mark type.
- motion: static system; no motion without new source evidence.
- lighting: hard light, sharp shadow edges; even key-to-fill.
- composition: organic, unruled geometry with soft edges, low density.
- Pairings to keep intact: even low-drama light ↔ gloss finish + reflective surface; warm
  color ↔ gloss finish + reflective surface; open spacing ↔ even low-drama light.

## Constraints (hard — never cross these)

- No rectilinear geometry with hard edges; forms stay organic or softened.
- No uppercase type; type stays lowercase, mixed, or title case.
- No packed frames; the composition always leaves room to breathe.
- Avoid hard rectilinear geometry or sharp mechanical edges anywhere in the character design.
- Avoid complex shading or material rendering that would compete with the flat, graphic read.

## Tokens

```json
{
  "palette": [
    { "role": "light",   "value": "#f7f4f1", "usage": "Highlights and light-struck surfaces." },
    { "role": "neutral", "value": "#b0aead" },
    { "role": "neutral", "value": "#847b72" },
    { "role": "neutral", "value": "#544c50" },
    { "role": "neutral", "value": "#e1d6ad" },
    { "role": "ground",  "value": "#1a1717", "usage": "Base fields and backgrounds." }
  ],
  "tokens": {
    "typography": { "present": "sparse" },
    "spacing": { "density": 0.32, "rhythm": "regular" },
    "color": { "temperature": 0.209, "saturation": 0.609, "contrast": 0.614, "groundLuma": 0.916 },
    "graphics": { "kinds": ["icon", "ruleLine"], "coverage": 0.978 },
    "lighting": { "softness": 0.009, "keyToFill": 0.234 },
    "composition": { "density": 0.32 }
  },
  "vocabulary": ["flat color blocking", "spot color", "contour line", "variable line weight", "figure-ground", "repeat pattern"]
}
```

## What the board shows that the brief does not say (observed, 2026-09-15) [D]

Read off the 45 references directly, recorded so the numbers we pick have a source:

- **Body**: a soft bulb — round to pear-shaped, often a touch narrower at the crown where
  the stalk leaves it. Stubby legs, sometimes two small arm or ear nubs. Rock types are
  faceted but still round in mass.
- **Stalk**: thin, slightly curved, one to one-and-a-half body heights of reach from the
  crown, in a darker shade of the body hue or a neutral.
- **Topper**: leaf, bud, flower, star, mushroom, cloud — the drawn thing. Light or
  contrasting to the body; where the drawing goes in ours.
- **Eyes**: two, wide-set, either plain dark dots or white ovals with dark pupils; no
  eyebrows, no lashes. Mouth absent or a single line.
- **Line**: thick contour, hand-wobbled, occasional double stroke; flat fill inside with at
  most light hatching or watercolour bleed.
- **Ground**: white or cream paper, small green tufts under feet in a few sheets.

_ref prompt format p2 · medium: generic · 1.0.0+2026-09-15T19:24:49.649Z_
