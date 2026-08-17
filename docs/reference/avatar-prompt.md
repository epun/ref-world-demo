# Avatar generation prompt

The per-entity avatar (users and agents) is a text-to-image generation via
Reve's direct API. Everything below is the source of truth for the look; the
implementation lives in `worker/src/avatar.ts` (the `blob` style profile).

## The full prompt

Each generation sends one positive prompt, assembled as:

```
An art piece featuring a single character, {SUBJECT CLAUSE}, {STYLE SENTENCE}
```

- **Subject clause:** `a|an <subject> with two <legLength> <legWidth> legs and <eyes>`
- **Style sentence:** the fixed block below (identical for every avatar).

**Request params:** `aspect_ratio: "1:1"`, no negative prompt (Reve's direct
`/v1/image/create` endpoint doesn't accept one — the whole look rides on the
positive prompt).

## The style sentence (verbatim)

> rendered in a minimalist, hand-drawn style as ONE solid, filled-in black shape — a bold black silhouette completely filled with black, NOT an outline and NOT a line drawing, with no interior linework or contour lines. The whole body is ONE uniform solid black fill — no patches, spots, stripes, or two-tone markings anywhere; the only white is the eyes. Stark and high-contrast: only opaque black ink on a solid white background, nothing else. The solid black fill has a grainy and stippled charcoal or felt-tip texture, and its edges are fuzzy and slightly irregular. The eyes are large and prominent — big white shapes cut into the solid black silhouette, and each eye ALWAYS has a single solid dark pupil with NO highlight, glint, catchlight, or sparkle. Each eye is ONE of only two shapes: a plain round circle, or a wide almond/leaf shape — never small, never stylized, cute, or anime eyes, and no eyelashes. The character is large and bold and fills most of the square frame — a strong, chunky silhouette, centered, with only small margins and never small or thin in the frame. It reads instantly from its outline alone.

## Example (a fully assembled prompt)

> An art piece featuring a single character, a cat with two stubby wide legs and one large almond-shaped eye, rendered in a minimalist, hand-drawn style as ONE solid, filled-in black shape — a bold black silhouette completely filled with black, NOT an outline and NOT a line drawing, with no interior linework or contour lines. The whole body is ONE uniform solid black fill — no patches, spots, stripes, or two-tone markings anywhere; the only white is the eyes. Stark and high-contrast: only opaque black ink on a solid white background, nothing else. The solid black fill has a grainy and stippled charcoal or felt-tip texture, and its edges are fuzzy and slightly irregular. The eyes are large and prominent — big white shapes cut into the solid black silhouette, and each eye ALWAYS has a single solid dark pupil with NO highlight, glint, catchlight, or sparkle. Each eye is ONE of only two shapes: a plain round circle, or a wide almond/leaf shape — never small, never stylized, cute, or anime eyes, and no eyelashes. The character is large and bold and fills most of the square frame — a strong, chunky silhouette, centered, with only small margins and never small or thin in the frame. It reads instantly from its outline alone.

## Variable vocab (one option picked deterministically per entity)

Each avatar is deterministic: a SHA-256 of the entity id picks one option per
axis, so the same user/agent always gets the same character (until they
regenerate, which bumps a variant and rerolls).

### Subject (one of)

**Objects (non-living)** — chunky/round only; tall or thin things read tiny in a square:
padlock, teapot, kettle, mug, teacup, bowl, jar, flower pot, bucket, light bulb, book, envelope, stapler, anchor, bell, drum, camera, radio, alarm clock, compass, umbrella, boot, mitten, hat, crown, button, gift box, balloon, kite, paper boat, dice, spinning top, yo-yo, backpack, purse

**Fruit** — round/plump only (no banana):
apple, pear, cherry, strawberry, lemon, peach, grapes, avocado, orange, pineapple, watermelon slice

**Shapes + abstract shapes** — bold, filled forms (no crescent moon or sun — they echo the theme-toggle icon):
blob, star, raindrop, cloud, diamond, heart, pebble, triangle, spiral, oval, lopsided circle

**Cute/silly animals** — no bugs/insects, and no two-tone / spotted / patched animals (panda, penguin, cow, dalmatian…) since a solid silhouette can't show the pattern:
cat, dog, bird, fish, rabbit, frog, owl, bear, mouse, fox, duck, whale, turtle, hedgehog, sloth, seal, chick, snail

### Legs — always exactly two, always short

- **Length:** short, stubby, little, tiny, stumpy
- **Width:** thin, thick, spindly, chunky, skinny, wide

### Eyes — one or two, two shapes only

Weighted **60 / 40 toward one eye**. A round/circular eye is **always a single
eye**; almond eyes come in one or two. All large, each with a solid pupil (see
the style sentence). The pool:

- one large round eye
- one big round eye
- one perfectly round eye
- one large circular eye
- one large almond-shaped eye
- one wide almond-shaped eye
- two large almond-shaped eyes
- two wide almond-shaped eyes
- two big almond-shaped eyes
- two almond-shaped eyes
