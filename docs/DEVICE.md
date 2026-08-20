# The device — arbitration and geometry

> User ruling, 2026-08-18: *"i want to wrap the mobile interface in the same style
> as our illustrated world it should look like a hand drawn tomogatchi but it should
> retain all the functionality that we already built. it should be black and white
> like the illustrated world."*

A second ref brief (web/ui, collection `ac910602`) now governs the mobile surface
alongside the standing arbitration in [`TASTE.md`](./TASTE.md). They conflict. This
file records the conflicts and how each resolves, in the same discipline TASTE.md
uses: **[M]** measured, from a brief's own tokens; **[D]** derived, our decision.

Where they disagree, the user's ruling above decides — and it decides in favour of
the existing world every time, because it asks for *"the same style as our
illustrated world"* and *"black and white"*.

## 1. The five conflicts

### 1a. Motion — the shell is still, the screen is not **[D]**

The ui brief says *"Treat this as a static system; do not introduce motion without
new source evidence."* TASTE §2.1 ships motion tokens and an ambient drift floor
that runs under everything, forever.

**Both hold, on different objects.** The device is a physical thing: physical things
do not animate. The screen is a display: displays do. So the shell — body, bezel,
buttons, motifs — never moves, and everything inside the screen well keeps the
world's motion law unchanged, ambient floor included.

This is not a compromise. A Tamagotchi whose plastic case breathed would read as
wrong, and that reading is the whole reason the wrapper works.

### 1b. Colour — black and white, by ruling **[M user]**

The ui brief's palette carries `#9cd3d4`, a soft cyan, and `saturation 0.333`. The
world is near-achromatic at `saturation 0.188`, CLAUDE.md states *"there is no
pastel green or pink in this taste"*, and the achromatic gate fails a frame whose
luma-weighted mean saturation exceeds `COLOR_METRICS.saturation + 0.1`.

**The cyan is dropped.** The user asked for black and white explicitly. `#9cd3d4`
appears nowhere. The gate stays green and the ruling is satisfied by the same
decision — there is nothing to trade off.

### 1c. Ground — the device is light, near-black stays the creature's **[M]**

The ui brief lists a `ground` role of `#161615` — luma ~0.08. CLAUDE.md: *"Near-black
belongs to characters only. Environment never goes below ~`#353534`."*

**The standing rule wins, and the brief's own tokens agree with it.** That same
brief reports `groundLuma: 0.863` — a bright ground — so its palette entry and its
measured token point opposite ways. We follow the measured token. `#161615` is not
used. The device body is `SURFACE.canvas`, the page behind it `SURFACE.ground`, and
the darkest thing on the phone remains the creature.

### 1d. Filled forms — it is a prop, not a panel **[D]**

TASTE §4 and CLAUDE.md: *"UI is `icon` + `ruleLine` + `border` only. No filled panels,
no cards, no shadows under UI."* A device with no body is not a device.

**The device is not UI. It is a prop in the illustrated world.** GENERATOR's
ink-rendering section describes every form out there as a *"light, paper-filled shape"*
carried entirely by *"rough, wobbly dark ink outlines"* — trees are near-white blobs.
The device is built to exactly that rule, so it belongs to the same world as the
scenery rather than sitting on top of it as chrome. The ui brief independently adds
`frame` to its mark set (`["icon", "frame", "ruleLine"]`), which licenses the bezel.

The panel ban still binds everything that is genuinely ui — the notice sheets, the
name sheet, the buttons' own treatment. No drop shadow, no gradient, no card.

### 1e. Depth without shadow **[D]**

The screen must read as *set into* the body, and TASTE §2.4 allows no penumbra, no
AO, and the ui brief bans gradients outright.

**Value does the work.** Device body `SURFACE.canvas` `#e9ebe9`; screen well
`SURFACE.ground` `#dfdfdf`, one step darker. A darker field inside a lighter one
reads as inset with no shadow at all. The glass highlight is one flat, hard-edged
shape in `WORLD.light` — the ui brief pairs hard light with a reflective surface,
and TASTE §2.4 says a light shape here is cut sharp and flat-filled.

## 2. What the device is

A hand-drawn handheld, portrait, filling the viewport with paper around it — it is
an object drawn on the world's ground, not a full-bleed skin. Density `0.289` and
*"the composition always leaves room to breathe"* both want that margin.

```
        ╭─╮            lug — the nub a keyring goes through
     ╭──┴─┴──╮
    │   ref   │        word mark. lowercase, always. real text.
    │ ╭─────╮ │
    │ │     │ │        the screen well — the STAGE lives here,
    │ │     │ │        unchanged: brow · core · tools · corner
    │ ╰─────╯ │
    │  ○ ○ ○  │        three buttons
     ╰───────╯
```

**Nothing about the existing functionality changes.** The stage, its four slots, the
swap choreography, the core's travelling side, the seam across the page navigation —
all of it survives verbatim. The device is a frame around it. If any behaviour
changes, the wrapper is wrong.

### The six keys **[D]**

A physical device has fixed controls, so the keys are **always in the same places**.
What changes is what they mean, and whether they are there at all:

| state | top row | bottom row |
|---|---|---|
| draw | hidden | undo *(brush size on `/draw/`, which has no undo)* · clear · done / send |
| sign | hidden | hidden |
| egg (wait) | **hidden** | **hidden** |
| alive | wave · happy · surprised | dance · sleepy · sad |

The egg state shows **no keys at all** by ruling — *"when the egg is visible on the
tamagotchi, let's hide the buttons"* — hidden, not dimmed. The countdown line and the
manual hatch key went with them: *"I want to set the hatch timing on my end."*
`hatchInMs` still flows to the screen because it drives the shell's crack and wobble
teaser; only the readout and the control were removed, not the signal.

Hiding is opacity + `pointer-events` + `aria-hidden`, never `display` — the case is a
solid object and a removal would relayout it. A key that is present but unavailable
still dims to `opacity: 0.3` instead.

**The emote wheel is gone.** *(user ruling: "instead of having the emotes around the
actual character on the screen, we should have one row of buttons at the top … another
row of three buttons at the bottom.")* The creature is alone in the screen and the
emotes are physical keys on the case, which is what a handheld actually looks like.
Six of them, not seven — **`angry` is dropped from the phone's set**. It stays in
`EMOTE_NAMES` because the world still uses it for autonomous behaviour; this is the
phone's button set, not the protocol.

**The minimap is gone from the phone** *(user ruling: "let's also get rid of the mini
map on mobile for now")*. The `corner` slot stays in the DOM and stays empty — empty
is a state of a slot, never a removal.

### 2a. The sign state **[D]**

> *"we're also missing the 'sign your masterpiece' screen. after the user finishes the
> drawing, we should just have the input replace the drawing pad before the egg
> appears. as the user clicks in to sign their name, we should pull up the normal
> phone keyboard so that they can type their name in there."*

Signing is a **state of the stage**, not a sheet over it. The core cross-fades from
the pad to the name input on the ordinary swap (PHONE-STAGE §3) — same duration, same
curve, same fixed centre. The pad does not dim behind a card; it is replaced, because
the drawing is finished and the screen has moved on. The old `.sheet` modal goes.

- The input is a real `<input type="text">`, so the handset raises its own keyboard.
  Focus is taken **inside the tap handler** — iOS raises the keyboard only from a
  genuine user gesture, so a focus scheduled on a timer or after an `await` is
  silently ignored.
- **The keyboard covers the bottom of the viewport.** The device is centred, so an
  open keyboard can hide the very input being typed into. Track `visualViewport` and
  keep the input inside the visible band; do not assume the layout viewport.
- `enterkeyhint="go"`, `autocomplete="off"`, `autocapitalize="words"`, `maxlength=16`
  — the same input the sheet already carried.
- Skipping still means the world names the creature (`src/creatures/naming.ts`).

## 3. Geometry — binding

`public/device/shell.svg`, viewBox `0 0 100 168`. Both pages position against these
numbers, so they must not be edited on one side only.

The artwork is **generated**, not hand-authored — `scripts/gen-device-shell.mjs`, run
with `node scripts/gen-device-shell.mjs`. The first version was drawn by hand and
shipped three containment faults (the bezel was wider than the body, the ink motifs
and hatching landed inside the screen well, and the outer button rings straddled the
body's edge). Generating it makes containment correct *by construction*: the body's
half-width is a function of y, every other part is placed by asking that function how
much room there is, and the script refuses to emit a shape whose clearances fail.
Measured clearances are 5.59 / 8.80 / 7.15 units of body outside the bezel at its top,
middle and bottom. The button rings are drawn at exactly the centres in the table
below, so the interactive keys land on them with zero offset.

| part | viewBox | as % of the device box |
|---|---|---|
| screen well, usable inner area | x 15–85, y 38–124 | `left 15%` `top 22.619%` `width 70%` `height 51.190%` |
| **top** key row centre line | y 24.6 | `top 14.643%` |
| **bottom** key row centre line | y 145 | `top 86.310%` |
| key centres, both rows | x 30.5 / 50 / 70 | `left 30.5% / 50% / 70%` |
| key diameter | 14.4 | `14.4%` of width |

**Six keys now, in two rows** *(user ruling, 2026-08-18)*. The top row occupies the
band where the `ref` word mark used to sit; the bottom row is where the three keys
already were.

**The rings are DOM, not artwork.** They used to be drawn into the shell, which meant
they could never be hidden — and the egg state has to hide them completely
("when the egg is visible on the tamagotchi, let's hide the buttons"), not merely dim
them. So each key draws its own ring inside its `<button>`. The shell no longer draws
any. This also removes the alignment question permanently: a key cannot be offset from
its own ring.

Hiding is still opacity + `pointer-events` + `aria-hidden`, never `display` — the case
is a solid object and a removal would relayout it.

**The well is portrait, not square** *(user ruling, 2026-08-18: "you can make it
slightly taller if we need more space")*. The device went from `100 × 150` to
`100 × 168` for one reason: with a square well the core fills it edge to edge and the
brow has nowhere to go but on top of the drawing. At 390px wide the well is now
273 × 335, so a 259px square core leaves a 38px band above and below — the brow and
the tools get their own air, and nothing overlays the pad.

The device is sized `contain` against the viewport and centred, so it never distorts
and the hand-drawn line weight never stretches. On a tall handset the extra height
becomes paper above and below.

**The core's measures are now relative to the screen well, not the viewport.**
`CORE_SIDE` in `src/phone/states.ts` reads `min(76vmin, 480px)` and friends; inside
the well those become shares of the well's own short side. The ratios between the
three states are what matter and they are preserved:

| state | old | new — share of the well's WIDTH |
|---|---|---|
| draw | `min(76vmin, 480px)` | `95%` |
| wait | `min(60vmin, 380px)` | `75%` |
| alive | `min(80vmin, 460px)` | `100%` |

Share of the well's **width**, not its short side — the well is taller than it is
wide now, and the core is square, so width is what bounds it.

### The screen has no frame of its own **[D]**

*(user ruling: "we shouldn't see the borders of the drawing pad because it should be
the tamagotchi screen.")*

The drawing pad must not paint a background, a border or a corner radius. The bezel
in the artwork is the only frame, and the well's own value (`SURFACE.ground`, one
step darker than the body) is the only ground. A pad that carries its own card reads
as a card sitting **on** the screen instead of being the screen — which is exactly
what it looked like. The same applies to every other state's content: nothing inside
the well draws its own enclosure.

## 4. What must not regress

- The swap choreography and its empty-frame guarantee (PHONE-STAGE §3, §6).
- The seam: `/draw/` and the companion still paint the same first frame, and the
  core is still in the same place at the same size on both sides of the navigation.
  The device makes this *easier* — the shell is identical on both pages.
- Every behaviour: drawing capture, the name sheet, the local moderation screen and
  its refusal notice, one-drawing-per-handset, the stale-epoch redirect, the 3D egg,
  the emote wheel with its pressed/default states, the minimap, the hatch haptic.
- The achromatic gate, the uppercase scan, and the mark-set lint stay green.
- The drawing pad stays big enough to draw on. If the wrapper costs so much room
  that the pad becomes cramped, the wrapper is too thick — thin the bezel, do not
  shrink the pad.
