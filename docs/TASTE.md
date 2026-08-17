# Taste — arbitration

Two briefs govern this project:

| Brief | Governs |
|---|---|
| [`taste/character.md`](./taste/character.md) | The character mark: silhouette, fill, eyes, gloss |
| [`taste/world.md`](./taste/world.md) | Everything else: ground, terrain, props, scatter, lighting, camera, type, **and all motion** |

They disagree in six places. This file is the ruling. **When a brief and this file
conflict, this file wins** — it exists because neither brief alone can be applied to a
running game.

---

## 1. The two systems are the composition

The character brief scores **contrast 88, density 18**. The world brief scores
**contrast 32, density 45**. That reads like a contradiction. It isn't.

The world brief scores **hierarchy 72** and describes it precisely:

> *"Nearly every frame anchors one small figure or landmark against a huge undifferentiated
> field"* — a rabbit lost in a graveyard field, a jogger swallowed by a forest.

A solid-black 88-contrast mark standing in a soft 32-contrast pastel field **is that image.**
The contrast differential is not a bug to be split-the-difference'd away — it is the
mechanism that produces the hierarchy the world brief asks for.

So: **the character is the only high-contrast object on screen.** Nothing else may
approach `#080808`. The moment a prop goes as dark as a character, the composition dies.

---

## 2. Rulings on the six conflicts

### 2.1 Motion — **the world brief governs, absolutely**

The character brief says *"treat this as a static system; do not introduce motion without
new source evidence."* The world brief **is** that new source evidence, and it ships
explicit motion tokens. All motion in this project follows the world brief.

| Rule | Value |
|---|---|
| Primary movement duration | **1823ms** |
| Settle | **drift** — never arrests completely |
| Entrance | **slide** — never a cut, fade-pop, or scale-in |
| Overshoot | **forbidden** |
| Bounce | **forbidden** |
| Abrupt stop | **forbidden** — nothing cut off mid-gesture |
| Hard cut | **forbidden** — nothing snaps into view |

**This overrides the `apple-design` skill.** That skill's core recommendation — springs with
velocity inheritance and a little overshoot — is *directly against* this project's hard
constraint. Take its guidance on interruptibility, starting from current value, and
gesture-tracking. Reject its overshoot.

Implementation rule, mechanically checkable:

> **Every spring in the codebase runs at damping ratio ζ ≥ 1.0.**
> `ζ < 1` is underdamped, underdamped means it rebounds past target, and a rebound is
> "bounce." Critically damped (`ζ = 1`) is the fastest settle that never crosses the target.

The full motion scale is in §3.

### 2.2 Ground value — cream material, mid-toned *frame*

The character brief wants a "field of white" (`groundLuma 0.924`). The world brief wants
"mid-toned grounds" and an overall contrast of 32.

**Ruling:** the ground *material* stays cream — `#e9e5db`, near the character brief's light
token, never pure white. The frame reads mid-toned because it is **populated**, not because
the ground is painted grey. Scattered muted units (`#bcbab7`, `#8e908d`, pastel green/pink)
across the field pull the frame-average contrast down to ~32 while the local contrast at the
character stays at 88.

Both scores are hit, by scatter density rather than by paint.

### 2.3 Density — global 45, local 18

**Ruling:** world-wide density is 45, achieved with repeated small hand-drawn units per the
world brief. Each character carries a **negative-space exclusion radius** — a zone around it
that scatter placement will not enter. Inside that radius, local density is 18.

The character keeps its field of white. The world keeps its populated map. This is a
placement rule, not a compromise.

### 2.4 Shadows — hard edges, flat fills

The world brief asks for hard light with **sharp shadow edges**. The character brief forbids
**midtones and gradients**.

**Ruling:** shadows exist, they have hard edges, and they are rendered as **flat solid
shapes with no penumbra gradient** — a single value, cut sharp. This satisfies "sharp shadow
edges" and satisfies "no midtones" simultaneously, and it reads as the "deliberate graphic
layer reinforcing structure" the world brief explicitly calls for.

No soft shadow maps, no PCF blur, no ambient-occlusion smear. Shadow as a stamped shape.

### 2.5 Structure — grid places, never forms

The character brief scores structure 22 (organic, no grid). The world brief scores 48 and
describes real isometric grids with consistent unit spacing.

**Ruling:** the **isometric grid governs placement. It never governs form.** Props snap to a
grid; every prop is a loose hand-drawn silhouette. Both briefs hard-forbid "rectilinear
geometry with hard edges," so nothing on screen is ever built from boxes.

Placement is also *jittered* off the grid by a small amount — the world brief says the maps
"hold a real grid" while ink pieces are "placed by eye," and 48/100 is that blend.

### 2.6 Camera — drifts, never stops, never cuts

The character brief's stillness suggests a locked camera. The world brief forbids full stops
and hard cuts.

**Ruling:** the camera holds an **imperceptibly slow continuous drift** and never arrests.
No shake, no hand-hold, no dolly, no snap, no cut. When it needs to move (following a
character, framing a hatch) it slides at the 1823ms beat and settles by drifting.

---

## 3. Motion system

Derived from the world brief's 1823ms primary.

| Token | Duration | Used for |
|---|---|---|
| `t.tertiary` | 456ms | Button states, eye-shape morphs, minimap pings |
| `t.secondary` | 912ms | UI panel slides, HUD reveals, emote glyph entrance |
| `t.primary` | **1823ms** | Hatch, spawn, camera reframes, egg crack stages |
| `t.ambient` | 3646ms | Wobble periods, idle loops, terrain drift |

**Drift settle curve** — strong ease-out, zero overshoot, long tail:
`cubic-bezier(0.17, 0.72, 0.24, 1.0)`

**The ambient floor.** "No full stop" is taken literally: a persistent low-amplitude,
low-frequency noise drift (~0.3% of an element's scale) runs underneath *everything* on
screen, forever. Nothing in this world is ever perfectly still, including elements that
have finished animating. This is what separates "settles by drifting" from "settles."

**Entrances slide.** New elements — eggs, characters, props, UI, minimap markers — translate
in from an offset. Never `scale: 0 → 1`, never opacity-only pop, never appearing at a
frame boundary.

**Exits drift out.** Same rule reversed. Nothing is cut off mid-gesture; a departing element
finishes its motion before it stops being drawn.

---

## 4. Shared law — where both briefs agree

Non-negotiable, no arbitration needed:

- **No rectilinear geometry with hard edges.** Forms stay organic or softened. Both briefs
  list this as a hard constraint.
- **No neon or saturated color.** Quiet even at full warmth. Both briefs.
- **Gloss and reflective finish** over flat matte. Both briefs pair this with muted
  saturation and want it kept intact.
- **Type is sparse; the image leads.** Both briefs.
- **`icon` is the graphic layer.** Don't invent new mark types. Both briefs.
- **Generous negative space.** Both briefs.
- **One subject.** Both briefs.

## 5. Type — hard rules

From the world brief:

- **No uppercase. Ever.** Lowercase, mixed, or title case only. This applies to every string
  in the product: HUD, buttons, room codes, tooltips, the title. A room code renders as
  `xkcd`, not `XKCD`.
- Wordmark: **rounded slab serif, title case, bold, normal tracking.** Playful and retro,
  reading as illustration rather than as UI text.
- Everything else: restrained in scale, weight, and frequency.

## 6. Palette, applied

| Surface | Value | Notes |
|---|---|---|
| World ground | `#e9e5db` | Cream paper. Never pure white. |
| World linework / ink | `#44413c` | Loose hand-drawn. **Not** black — black belongs to characters only. |
| Scatter units, terrain | `#bcbab7`, `#8e908d`, pastel green, pastel pink | Muted. This is what pulls frame contrast to 32. |
| Shadows | flat `#8e908d` at low alpha | Hard edge, no gradient. |
| **Character body** | `#080808` | The only true black on screen. Clearcoat gloss. |
| **Character eye** | `#f4f3ef` | Knockout — reads as negative space punched through the fill. |
| Accent | `#fb5429` | The one warm note. **At most one accent element on screen at a time.** Reserved for: the hatch moment, and *your* marker on the minimap. |

## 7. Known gaps

- The world brief's **token block was truncated** mid-`palette`. The pastel values in
  [`taste/world.md`](./taste/world.md) are inferred from its prose and marked as such.
  Replace them when the real block is available.
- The character brief's **Method section was truncated** at "- When". Nothing appears to be
  load-bearing, but confirm.

## 8. Verification gates

Build these as dev tools, not as review checklists — a constraint that isn't a button
doesn't survive a build. All live in the Ghost Panel `refworld.taste` skill:

| Gate | Check |
|---|---|
| **Grayscale** | Desaturate the frame. Everything must still read. Only `#fb5429` may depend on hue. |
| **Contrast histogram** | Frame-average contrast ≈ 32. Character-local contrast ≈ 88. Nothing but a character in the `#080808` band. |
| **Damping audit** | Assert every registered spring has ζ ≥ 1.0. Fails the build if not. |
| **Uppercase scan** | Lint every user-facing string for `A-Z` runs. Fails the build if found. |
| **Stillness probe** | Sample any element over 2s of "idle" — nonzero motion required. Nothing fully arrests. |
| **Density probe** | Sample scatter coverage globally (≈45) and inside character exclusion radii (≈18). |
