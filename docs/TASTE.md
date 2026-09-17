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

**User override (2026-08-18) [D]:** the shipped ground is `#dfdfdf` — luma ~0.87, lighter
than the measured 0.74 — chosen in the ghost panel's color picker and handed over as the
default configuration. The measured token stays as recorded; `valueHistogramGate` measures
the frame against the *configured* paper (its invariant is "the paper dominates the frame,
near-black is rare") and prints the distance from the measured reference in every readout,
so the drift is stated rather than buried.

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

## 7a. Derived decisions — the environment brush kit **[D]**

Three calls made while building the planting brushes (2026-09-09 user ask, GENERATOR
§motif library). All **[D]**: nothing in either brief speaks to any of them, and none of
them is attributable to the measured taste.

- **Clouds float at 16 u** (+ a hashed 0–5 u spread), as an offset above the sampled
  Surface rather than an absolute height. Chosen against the isometric camera: high enough
  to clear every tree and the terrain's own relief, level with the range's summits, and far
  enough above its own shadow stamp that the two read as a pair rather than as one object.
- **Clouds are exempt from the creature exclusion radii, from colliders, and from the
  water and mountain cut-outs.** §2.3's exclusion is a character's negative space on the
  *ground*; a cloud does not occupy it, and one blinking out because a creature walked
  underneath would be absurd — the same reasoning that already exempts mountains.
- **Flowers are ink lines only** — closed loops with an open centre, no fill and no new
  colour. §1 keeps near-black for characters and §6 has six greys; a filled flower head
  would put a second light-albedo lump on a field whose only light lumps are eggs, and the
  ref brief's shading is density of mark rather than value anyway.

## 8. Open

- **`fidelity` default** for drawing→character interpretation — a taste call to make against
  real P1 output, not now.
- **Body type family** — the grotesque-sans read is *incidental* (conf 0.38), so it's open.
- **1823ms** — confidence 0.06. Tune against the built thing.


---

## 8. The creature brief supersedes the character brief for the creature *(2026-09-15)*

**User ruling.** A third brief arrived — [`taste/creature.md`](./taste/creature.md), a
Pikmin-inspired board of 45 references — with the ask: *"change the style of the characters
… keep the same mechanics for character generation … the drawing can inform the color of the
character as well as the silhouette … at the top, where the antenna is for most Pikmin, they
have a flower. We should have the drawing or the shape of that drawing be the flower."*

What changes, and what it overrides in §1–§7:

- **The creature is coloured.** [M] Each figure is a near-monochrome fill in red, blue,
  yellow, purple, pink or grey (brief saturation 0.609). §1's "the character is the only
  near-black on screen" no longer holds for the body — the pupils and the eye's dark are the
  creature's darks now. The **environment rules are unchanged**: it stays achromatic, the
  ground stays the paper, near-black is still never environmental. The achromatic gate is
  now a gate on the *environment*, not the frame.
- **Colour comes from the drawing.** [D] `src/character/palette.ts`: the type is read off
  the drawing's measured motifs (archetype, crown count, aspect, lumpiness), never a seed.
- **The body is the brief's soft ovoid, informed by the drawing.** [D] `BODY_OVOID` in
  `src/character/interpret.ts` blends the §1a body halfway toward an egg of its own bounds.
  GENERATOR §1a's "drawn objects keep their shape" is softened, not revoked: at 0 it is the
  old body, and a wide drawing is still a wide creature.
- **The drawing is the topper.** [M] The brief's species marker is the thing on the stalk;
  here that thing is the person's own drawing (`src/character/topper.ts`). The drawing is
  still projected onto the egg; the back marking stays as a quieter second channel.
- **Two eyes.** [M] *"two dot or oval eyes"* — supersedes the standing one-eye ruling in
  `docs/reference/character-designs.md`.
- **Still held from the world brief:** all motion (ζ ≥ 1, no cuts), the mark set, no
  uppercase, hard flat shadows, the full-frame grain, no rectilinear geometry. The creature
  brief agrees on every one of these.

Tagging discipline is unchanged: the six body hexes are **[D]** (the brief's tokens are the
sheets' palette, not the creatures'), the stalk length and topper size are **[D]** starting
points to tune in the ghost panel, and nothing here is attributed to the brief that the
brief does not show.


---

## 9. Ghibli style — user override *(2026-09-15)* **[D]**

**User decision, recorded as one.** The world `valiocon` renders in envpaint's `ghibli-toon`
look instead of the shipped ink look: a green meadow ground, a warm sun and a cool sky, flat
two-tone shading whose shadow is *hue-shifted* rather than merely darker, a hard sun-coloured
rim on the shade side, a blue sky field, and envpaint's violet-blue `#2a2340` on the contour
lines. The palette and the lighting model are ported verbatim
(`src/taste/tokens.ts` `GHIBLI`, `src/world/toon.ts`).

**Nothing here is attributable to the taste.** Neither brief shows a saturated cel palette;
§3's *"no neon or saturated color"* and §2.2's near-achromatic ground are measured, and this
override sits on top of them for one deployment. It is tagged **[D]** and it is a preference,
not evidence — the tokens above are untouched, `COLOR_METRICS` still records the measured
`saturation 0.188`, and the public world and `meridian` render exactly as they did.

**What the override relaxes — and only these two:**

- **The achromatic palette.** The ground is green, the props take canopy and stone colours,
  water is blue. §1's environmental near-black floor is replaced by the cel shadow: the
  darkest environmental value becomes the meadow under `shadowTint`, which is a tinted mid,
  not a near-black.
- **The six-luma quantize.** The ink pass's snap onto the measured palette anchors is off
  (`uQuantize`), because the cel bands now come from the material lighting. Snapping a
  two-tone cel frame onto six greys would delete the thing the override exists to show.

**What still holds, unchanged:**

- **All motion.** ζ ≥ 1, no overshoot, no bounce, no cut, no abrupt stop, the ambient drift
  floor. §2.1 is confidence 1.00 and a palette has nothing to say about it.
- **Stamped shadows.** Three.js shadow mapping stays off; the toon shadow term is a constant
  1.0 and the flat hard-edged stamps (§2.4) are still the cast shadows. They lerp between the
  meadow and the meadow's own cel shadow instead of the grey pair — one flat value, cut sharp.
- **Grain is a post-process.** envpaint's painterly per-material grain is deliberately *not*
  ported: §2.7 puts grain over the whole image, never on the mark.
- **No uppercase, the `icon`/`ruleLine`/`border` mark set, no rectilinear geometry, the
  isometric grid placing and never forming.** §2.5, §4, §5 are untouched.

**The gates.** The **achromatic** and **value histogram** buttons report
`n/a — ghibli style (user override)` and pass under this style — a gate that prints a failure
for a decision made on purpose sends an operator hunting a bug. Every other gate (damping,
uppercase, stillness, density, mark set, grain) still runs, because the override relaxes
nothing any of them measure.

**Where it lives.** `worlds.json` carries `"style": "ghibli"` per world; the build injects
`<meta name="refworld:style">` only for a world that asked, so the public html stays
byte-identical (`test/worlds/build.test.ts`). `?style=ink|ghibli` overrides it on the address
and the ghost panel's *shader style* folder switches it live, so the two frames can be put
side by side rather than argued about.

### 9a. The minimap's painted body — user override *(2026-09-16)* **[D]**

**User decision, recorded as one:** *"The mini map should update to be in the more colored
style."* On the `ghibli` style the world minimap's FIELD is painted from the landscape's own
region query in the world's own colours — the sea in three flat bands off the coast, a sand
ring on the beach, the meadow green, the forest in the canopy's shade green, the range in
rock, the ponds and the lake in the water value with a pale rim, a painted trail in dirt.
Flat fills on a quantised grid, off `GHIBLI` tokens only; nothing is interpolated, so a
shoreline stays a cut edge and never becomes a gradient.

**It relaxes nothing new.** The colour is §9's palette relaxation, already granted for this
one deployment; the map body takes the same tokens the ground and the water shaders take, so
the map cannot hold a colour the world does not. On `ink` — the public world and `meridian`
— the map is byte-identical, and a golden draw-call sequence in `test/ui/minimap.test.ts`
pins that.

**The mark set is untouched (§4).** The border, the coast and shore hairlines, the prop dots,
the eggs, the creature dots, you, and the camera diamond and wedge are the same marks in the
same order. Only their VALUE moves, and only as far as legibility forces: the interior marks
take `GHIBLI.ink`, and the BORDER takes `GHIBLI.foam`, because the paper under it is now a
dark sea rather than a light field — ink on the deep sea measures 1.2:1 and foam on it 12:1.
That is the same argument §4 already accepts for the self ring: a value is only a mark where
there is range under it.

**Where it lives.** `src/ui/minimap.ts` — `bodyKindAt` is the region read (pure, from
`sampleLandscape` and `coastInland`, so it follows a coast that moves), `sampleBodyGrid` the
raster, and `mapPalette` the two mark values. The body repaints once per map revision (the
scatter's `rebuildVersion`, plus the landscape and island switches) and blits per frame.

### 9a (continued). The leaderboard's paper, and its one capital — user override *(2026-09-17)* **[D]**

**Two user decisions, recorded as two.** They arrived together, about the projection's top
ten (`src/ui/leaderboard.ts`, the same day's earlier ask): *"let's title it 'Leaderboard'.
Give it a white background and style it in the same style as we've done for the rest of ref,
with the doodle lines."* — and the title was asked for a second time with the capital after
it was first set in lowercase.

**1. The paper box relaxes §4's "no filled panels" for this element.** The board stands on
paper inside the project's own wavering hand-drawn hairline: `wavyBorderPoints` +
`wavyBorderPath` from `src/phone/minimap.ts`, at `mapBorderInset` off `mapMarkScale` and a
1.25 stroke — the identical generator, inset and weight the join code's frame
(`src/ui/joinqr.ts`) and the minimap's border already use, emitted as an svg path because
this box is type in the dom rather than a canvas (`src/phone/worldlink.ts` draws its button
the same way).

It is **the same override those two corners are already under**, not a new one: the join
code's field is `WORLD.light` and the minimap's is `SURFACE.ground`, both paper inside a
wavering hairline, and the mark-set lint has carried the minimap's as a ruled exemption since
the qa audit (p8). This box takes the **join code's** value — `WORLD.light`, the whitest paper
in the palette — because the join code is the other thing on that screen that is a card of
paper laid on the world rather than a window into it. **Nothing else comes with it:** no
shadow, no radius, no second fill, no new mark type. `MARK_LINT_TARGETS` in `src/dev/index.ts`
samples `.world-leaderboard` and reports its fill as this ruling, so the gate stays a button
rather than a memo.

**2. The title carries the one capital in the product.** `Leaderboard` is a recorded override
of §5 (*no uppercase, anywhere*, confidence 1.00) for **exactly one string**, held in
`LEADERBOARD_TITLE` with the static gate's own scoped `gate-allow-uppercase` hatch on its
line — the scan is not widened for anybody else. Everything around it is untouched: room
codes still render `xkcd`, the way out of the device still says `view world`, the ball readout
still says `34cm 5mm`, and every creature name on this very board is still lowercased at its
source (`src/creatures/naming.ts`).

**Where it lives.** `src/ui/leaderboard.ts` — `framePath`/`frameInset` are the pure border
(so the loop is testable without a browser and identical on every device), `boardHeight` is
the paper's size for a field of *n*, and the box's height rides a ζ≥1 spring so it grows and
shrinks with the field instead of standing at ten rows over an empty world. Katamari worlds
only, projection only, behind a dynamic import: `test/ui/leaderboard.test.ts` pins all of it,
and the public build is byte-identical.
