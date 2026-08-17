# Taste — arbitration

Two briefs govern this project:

| Brief | Governs |
|---|---|
| [`taste/character.md`](./taste/character.md) | The character mark: silhouette, fill, eyes, gloss |
| [`taste/world.md`](./taste/world.md) | Everything else: ground, terrain, props, scatter, lighting, surface, camera, type, **and all motion** |

They disagree in seven places. This file is the ruling, and **it wins over either brief** —
neither can be applied to a running game on its own.

Both briefs resolve conflicts in the same declared order:
**essence + intent → constraints → direction → everything else.**

## 0. Measured vs. derived

The world brief ends with a standing instruction:

> *"Anything it does not mention is open — decide it with ordinary good design judgment
> consistent with the essence, and **never invent a rule and attribute it to this taste**."*

So every rule below is tagged:

- **[M]** measured — a token or constraint straight from a brief. Not ours to negotiate.
- **[D]** derived — our project decision, consistent with the briefs but **not** attributable
  to them. Changeable on evidence.

The world brief explicitly marks four axes as **not observed**: `layouts`, `imagery`,
`micrographics`, and — most relevant here — **`threeD`**. There is no 3D evidence in the
corpus at all. **This is a 3D project whose taste says nothing directly about 3D.** What
governs our rendering is the *observed* axes (color, lighting, composition, graphics,
surface, motion) applied with ordinary judgment. Everything else in the 3D pipeline is
tagged **[D]** and owned by us.

---

## 1. The two systems are the composition

**[M]** The character brief scores **contrast 88, density 18**. The world brief measures
**contrast 0.577, density 0.39**, near-achromatic, on a **mid-toned ground (`groundLuma
0.74`)**.

That reads like a contradiction. It isn't. The world brief scores **hierarchy 72** and
describes it precisely:

> *"Nearly every frame anchors one small figure or landmark against a huge undifferentiated
> field"* — a rabbit lost in a graveyard field, a jogger swallowed by a forest.

A near-black mark standing in a soft mid-grey field **is that image.** The value differential
is not a bug to split-the-difference away — it is the mechanism producing the hierarchy the
world brief asks for.

The measured palette confirms it: **`#0c0d0d` appears at only 0.09 prevalence.** Near-black
exists in this taste and is *rare*. That is the character.

**Ruling [D]:** the character is the only near-black object on screen. Nothing in the
environment goes below roughly `#353534`. The moment a prop reads as dark as a character, the
composition dies.

---

## 2. Rulings

### 2.1 Motion — the world brief governs, absolutely **[M]**

The character brief calls its corpus a *static system* and asks for "new source evidence"
before introducing motion. The world brief **is** that evidence and ships motion tokens. All
motion follows the world brief.

| Rule | Value | Confidence |
|---|---|---|
| Primary movement duration | 1823ms | **0.06 — a starting point, tune it** |
| Settle | **drift** — never arrests | 0.07 |
| Direction | ambient | 0.07 |
| Entrance | **slide** | 0.07 |
| Overshoot | **forbidden** | **1.00** |
| Bounce | **forbidden** | **1.00** |
| Abrupt stop | **forbidden** | **1.00** |
| Hard cut | **forbidden** | **1.00** |

Read that confidence split carefully. The **constraints are certain** (0 of 4 applicable
references bounce, cut, or stop abruptly). The **values are weak** — measured from four
references. So: never bounce, never cut, always drift; but 1823ms is a first guess to tune
against, not a number to defend.

**This overrides the vendored `apple-design` skill [D].** Its core recommendation — springs
with velocity inheritance and a little overshoot — is directly against a confidence-1.00
constraint. Take its guidance on interruptibility, starting from the current value, and
gesture tracking. Reject its curves.

Mechanically checkable **[D]**:

> **Every spring runs at damping ratio ζ ≥ 1.0.** `ζ < 1` is underdamped, underdamped
> rebounds past target, and a rebound is bounce. Critically damped is the fastest settle
> that never crosses.

Motion scale — **1823ms is [M], the rest of the scale is [D]**:

| Token | Duration | Used for |
|---|---|---|
| `t.tertiary` | 456ms | Button states, eye morphs, minimap pings |
| `t.secondary` | 912ms | UI slides, HUD reveals, emote glyph entrance |
| `t.primary` | **1823ms** **[M]** | Hatch, spawn, camera reframes, crack stages |
| `t.ambient` | 3646ms | Wobble periods, idle loops, terrain drift |

**The ambient floor [D].** "No full stop" taken literally: a persistent low-amplitude,
low-frequency drift (~0.3% of scale) runs under *everything*, forever, including elements
that have finished animating. That is what separates "settles by drifting" from "settles."

### 2.2 Ground — mid-toned grey, not cream **[M]**

⚠️ *This corrects an earlier reading. The truncated brief's prose mentioned "cream" and
"muted pastel green and pink"; the measured tokens show neither.*

`groundLuma 0.74`, `saturation 0.188`, temperature-neutral, *"hue is incidental"*, essence
*"near-achromatic."* The ground is a **mid-toned neutral grey** around `#b6b6af`–`#c2c2bb`.
`#e9ebe9` is tagged **light / highlights** — it is not the ground.

The character brief's "field of white" describes how a character *mark* is presented on a
page — generous negative space around it. It is not an instruction to paint the game world
white. In-game the field is mid-toned and the negative space is spatial.

**There is no pastel green or pink.** The palette is six near-achromatic greys.

### 2.3 Density — global 0.39, local sparse **[M]** + **[D]**

**[M]** Both `spacing.density` and `composition.density` measure **0.39** — balanced,
neither sparse nor tight, with *regular* rhythm. Avoid "compositions with no negative space
at all."

**[D]** Each character carries a **negative-space exclusion radius** that scatter placement
will not enter. Global density holds at 0.39; locally, each character keeps its room. This is
a placement rule of ours, not a taste rule.

### 2.4 Shadows — hard edges, flat fills **[M]** + **[D]**

**[M]** `lighting.softness 0.117` — hard, with sharp shadow edges. `keyToFill 0.333` — even,
non-directional. Explicitly avoid "fully diffuse, shadowless lighting."

**[D]** The character brief forbids midtones and gradients, so shadows render as **flat solid
shapes with no penumbra** — a single value, cut sharp. Satisfies "sharp shadow edges" and
"no midtones" at once, and reads as the "deliberate graphic layer reinforcing structure" the
world brief calls for. No soft shadow maps, no PCF, no AO smear. Shadow as a stamped shape.

### 2.5 Structure — grid places, never forms **[M]**

The character brief scores structure 22 (organic, no grid). The world brief scores 48 and
describes real isometric grids with consistent unit spacing — while its `composition` axis
reads *"organic, unruled geometry, held in soft edges"* and both briefs hard-forbid
rectilinear hard-edged geometry at confidence 1.00.

**Ruling:** the isometric grid governs **placement**. It never governs **form**. Props snap
to a grid; every prop is a loose hand-drawn silhouette. Nothing on screen is built from
boxes. Placement is jittered off-grid — 48/100 is exactly that blend of "holds a real grid"
and "placed by eye."

### 2.6 Camera — drifts, never stops, never cuts **[M]**

The character brief's stillness suggests a lock; the world brief forbids full stops and hard
cuts at confidence 1.00.

**Ruling:** the camera holds an **imperceptibly slow continuous drift** and never arrests.
No shake, no hand-hold, no dolly, no snap, no cut. Reframes slide at `t.primary` and settle
by drifting.

### 2.7 Grain — scene-level, not material **[M]** + **[D]**

⚠️ *New conflict, from a defining signal the truncated brief omitted.*

**[M]** *"A steady grain sits over gloss finishes"* — **defining**, 100% of corpus,
confidence 0.93. Paired with high reflectivity and a **gloss** finish, which both briefs
independently ask for. The tactile↔polished tension reads *polished, low grain* — so the
grain is **present but subtle**, over a reflective surface. Not matte paper texture.

**[D]** The character brief forbids texture breaking the silhouette. So grain is a
**full-frame post-process**, uniform over the whole image — never a material texture on the
character. The silhouette stays one solid shape; the grain is the surface of the *image*,
not of the *mark*. It sits above everything, at low amplitude, and never varies across a
character's fill.

---

## 3. Shared law — where both briefs agree **[M]**

Non-negotiable, no arbitration needed:

- **No rectilinear geometry with hard edges.** Both briefs, confidence 1.00.
- **No neon or saturated color.** Both briefs. World: 4% against an 87% majority, conf 0.96.
- **Gloss and reflective finish** over flat matte. Both briefs pair this with muted
  saturation and mark the pairing as one to keep intact.
- **Type is sparse; the image leads.** Both briefs.
- **`icon` is the primary graphic mark.** Both briefs.
- **Generous negative space.** Both briefs.
- **One subject.** Both briefs.

## 4. The graphic layer **[M]**

The world brief's **#1 defining signal**, 100% of corpus, confidence 1.00 — and the earlier
truncated brief omitted two thirds of it:

> *A heavy graphic language, mostly small **icons, hairline rules and thin borders**.*

Mark set is `icon`, `ruleLine`, `border`, at coverage 1.0. Directives: *"let small,
self-contained icon marks"* carry it, and *"reserve a single hairline rule to divide the
frame."*

**[D]** For us, that means the HUD, minimap, and emote wheel are built from **icons, hairline
rules, and thin borders — and nothing else.** No filled panels, no cards, no shadows under
UI, no new mark types. The minimap gets a hairline border and a single dividing rule; emotes
are icon marks. Introducing an unrepresented graphic vocabulary breaks the system.

## 5. Type **[M]**

- **No uppercase. Anywhere.** Confidence 1.00, 0 of 14 applicable references. Every string in
  the product: HUD, buttons, room codes, tooltips, the title. A room code renders `xkcd`.
- **Wordmark** — rounded slab serif, title case, bold, normal tracking. Chunky, with a
  looping ligature; playful and retro, reading as *illustration* rather than UI text.
- **Everything else** — grotesque sans, regular ~400, strong size contrast, used sparingly.
  Marked *incidental* (conf 0.38, "preserve: no"), so this is the one type decision genuinely
  open to us.

## 6. Palette, applied

World values are **[M]** from the measured export. Assignments are **[D]**.

| Surface | Value | Notes |
|---|---|---|
| World ground | `#b6b6af` → `#c2c2bb` | Mid-toned neutral, targeting `groundLuma 0.74` |
| Terrain, scatter units | `#92928e`, `#666764` | The bulk of the frame |
| Linework, deep marks | `#353534` | The darkest the environment goes |
| Highlights, light-struck | `#e9ebe9` | Light role — highlights, not ground |
| **Character body** | `#080808` | The only near-black. Matches the world's rare `#0c0d0d`. Clearcoat gloss. |
| **Character eye** | `#f4f3ef` | Knockout — negative space punched through the fill |
| Accent | `#fb5429` | **Retired for now — user decision (2026-08-17): the experience is fully black and white.** Token stays defined; nothing may reference it until color returns. Former uses (hatch ring, minimap self-marker) render in ink/light values. **Exception (user decision, same day): emoji inside speech bubbles render in native color.** |

**On `#fb5429`:** it appears in the character brief's palette and nowhere in the world's.
Both briefs constrain neon saturation, and the character brief's own wording — *"the palette
stays quiet even where warmth appears"* — is the instruction for it. **[D]** At most one
accent element on screen at a time. Reserved for the hatch moment and *your* marker on the
minimap. It never touches terrain, props, or UI chrome.

## 7. Verification gates **[D]**

Built as dev tools, not review checklists — a constraint that isn't a button doesn't survive
a build. All live in the Ghost Panel `refworld.taste` skill.

| Gate | Check |
|---|---|
| **Achromatic** | Desaturate the frame. Everything must still read. Only `#fb5429` may depend on hue. Frame saturation ≈ 0.188. |
| **Value histogram** | Ground ≈ 0.74 luma. Nothing environmental below ≈ `#353534`. Only characters in the near-black band, at low coverage. |
| **Damping audit** | Every registered spring has ζ ≥ 1.0. Fails the build otherwise. |
| **Uppercase scan** | Lint every user-facing string for `A-Z` runs. Fails the build. |
| **Stillness probe** | Sample any element over 2s of idle — nonzero motion required. |
| **Density probe** | Global coverage ≈ 0.39; character exclusion radii stay clear. |
| **Mark-set lint** | UI uses only `icon`, `ruleLine`, `border`. Flags filled panels and new mark types. |
| **Grain check** | Grain is uniform across the frame and does not vary within a character's fill. |

## 8. Open

- **`fidelity` default** for drawing→character interpretation — a taste call to make against
  real P1 output, not now.
- **Body type family** — the grotesque-sans read is *incidental* (conf 0.38), so it's open.
- **1823ms** — confidence 0.06. Tune against the built thing.
