# The phone stage — one surface, updated

> User ruling, 2026-08-18: *"i don't think we should be swiping to change screen
> states. we should be animating the elements and states of each screen on and off
> elegantly such that the user feels like they are on the same screen, but its
> getting updated as they progress through the flow."*

This is the contract two halves of the mobile flow build against. It is a layout and
timing spec, not an implementation — where it names a value, that value is binding,
because the two halves have to agree pixel-for-pixel across a page navigation.

## 1. What was wrong

The audience path is four steps and it cut three times:

| step | page | paper | transition in |
|---|---|---|---|
| draw | `/draw/` | `#dfdfdf` | — |
| (send) | → `/phone.html` | **`#e9ebe9`** | **full page reload** |
| wait | `/phone.html` | `#dfdfdf` | — |
| alive | `/phone.html` | **`#e9ebe9`** | **whole screen slides ±100%** |

Three papers, one document reload, and a horizontal screen slide. Every one of those
reads as "a different screen", and the slide in particular reads as swiping — which
is the thing the ruling names. TASTE §2.1 forbids hard cuts at confidence **1.00**;
a document navigation is the hardest cut available.

## 2. The model

**One stage. It never moves.** What changes is which elements occupy it. Elements
arrive and leave by sliding a short distance while fading. The stage itself — its
paper, its centre, its safe-area padding — is continuous from the first frame of
`/draw/` to the last frame of the companion.

The through-line is the **core**: it is the same object the whole way down.

```
the square you draw in  →  the egg it became  →  the creature that hatched
```

It stays at the centre of the stage and its content transforms. Everything else is a
**satellite** that comes and goes around it.

### Slots

```
.stage                 persistent; owns the paper, the safe-area padding, the ambient floor
├── .stage-brow        top      — status line, name chip, countdown, creature name
├── .stage-core        centre   — the one object: pad → egg → creature + emote wheel
├── .stage-tools       bottom   — undo/clear/send → hatch → (empty)
└── .stage-corner      bottom-right — minimap (alive only)
```

A slot is always present in the DOM. Empty is a state of a slot, never a removal —
removing a slot relayouts the stage, and a relayout is a cut.

### Core geometry [D]

The core is a centred square whose **side is the only thing that changes** between
states. It is driven off one custom property so both halves can set it identically:

| state | `--core-side` | what is in it |
|---|---|---|
| draw | `min(76vmin, 480px)` | the drawing pad |
| wait | `min(60vmin, 380px)` | the 3D egg |
| alive | `min(80vmin, 460px)` | the emote wheel; the portrait is 52% of it, centred |

The side transitions on the settle curve over `t.secondary`. It never jumps, and it
is never animated by `scale` — the box is really that size at every frame, so the
canvas inside it stays sharp.

### Paper [D]

**One paper for the entire mobile flow: `SURFACE.ground` (`#dfdfdf`).**

That is the value the user picked in the panel's colour picker and shipped as the
default ground, and the value they asked the draw page to match ("a slightly greyish
white background similar to the ref world background"). The pad interior keeps
`SURFACE.canvas` (`#e9ebe9`) so there is still a figure/ground separation — but the
*page* is one value from end to end, so there is nothing left to transition.

Every entry point paints it **before any script runs**, inline in the document head.
That is what makes the navigation invisible.

## 3. Choreography

A state change is a **swap**, and a swap is three overlapping moves. Nothing waits for
a previous move to fully finish — an empty frame is a cut.

1. **Satellites out** — `opacity 1 → 0`, `translateY(0 → +8px)`, over `t.tertiary`
   on the settle curve. Staggered by `STAGGER_MS` in reading order (brow, then
   tools, then corner).
2. **Core** — cross-fades its content in place over `t.secondary` while
   `--core-side` travels to the incoming measure. The core never translates and
   never scales; it is the fixed point the person's eye holds.
3. **Satellites in** — `opacity 0 → 1`, `translateY(+8px → 0)`, over `t.secondary`,
   starting at `STAGGER_MS` after the outgoing move begins, staggered in the same
   order.

```
t.tertiary   ├─ out ─┤
t.secondary        ├──────── core cross-fade ────────┤
t.secondary     ├──────────── in ────────────┤
```

`STAGGER_MS` is `MOTION.tertiaryMs / 4` (114ms) — derived from the token scale, not a
literal. Stagger is the only place a magic-looking number is allowed, and it is
derived.

### The rules this must not break

- **No `scale: 0 → 1`, ever.** Entrances slide (TASTE §2.1). A satellite that pops in
  is a bug even if it looks fine.
- **No overshoot, no bounce.** Everything on `MOTION.settleCurve`; every spring ζ ≥ 1.
- **No `display: none` toggling.** It is a cut. Opacity + `pointer-events` + `aria-hidden`.
- **No `translateX(±100%)` screen slides.** That is the swipe the ruling removed.
- **Durations come from `MOTION`.** No literals — not in the draw page either, which
  currently hard-codes a `700` before the handoff.
- **The ambient floor keeps running** under the stage the whole time (TASTE §2.1) —
  including while a swap is in flight, and including when the flow has settled.

## 4. The seam — `/draw/` → `/phone.html`

The two halves are different documents and stay that way: `/draw/` carries the
vendored feed, the name sheet and the local moderation screen; the companion carries
the world link, the 3D egg and the wheel. Merging them would be a rewrite. Instead the
navigation is made **invisible**, which is what the person actually perceives.

The contract, and both halves must hold it exactly:

1. **Identical first paint.** Both documents set `background: #dfdfdf` inline in the
   head, before any script. No flash is possible if there is nothing different to
   flash to.
2. **The core is in the same place, at the same size, on both sides of the seam.**
   `/draw/` ends its exit with `--core-side` already at the **wait** measure
   (`min(60vmin, 380px)`) and the pad content faded out. `/phone.html` boots with the
   core at that same measure and fades the egg up into it. The person sees one object
   that stayed put while its content changed — which is exactly what happened.
3. **Satellites are already gone before the navigation fires.** The draw page runs the
   satellites-out move, then navigates on the settle. The companion mounts with its
   satellites at the pre-entrance offset and runs satellites-in.
4. **The delay before navigating is `MOTION.secondaryMs`**, not `700`. It is the
   duration of the move it is waiting for.

If a reload lands mid-flow (the person backgrounds the phone and comes back), the
companion restores straight into the settled state for whatever it restores — no
entrance animation for a state the person was already looking at. An entrance replayed
on a restore reads as a glitch, not as polish.

## 5. What stays a modal

Two things are genuinely interruptions and keep sliding in over the stage rather than
swapping into it — they are not steps in the flow:

- the name sheet (`sign your drawing`)
- the guideline notice (`sorry this goes against our content guidelines`)

Both already slide up on the settle curve over `t.secondary` and both keep the stage
visible behind them, so the surface is still continuous.

## 6. How this is verified

- **No screen-slide lint**: nothing in `src/phone/` or `public/draw/` may set a
  transform of `translateX(±100%)` on a full-bleed element.
- **Token lint**: no duration literal in the phone flow; every one reads from `MOTION`.
- **Headless swap probe**: drive draw → wait → alive and assert, at every animation
  frame of the swap, that (a) the stage's background never changes value, (b) the core
  element's centre stays within 1px, (c) no satellite ever reports a computed
  `transform` containing `scale(0`, and (d) there is no frame in which both the
  outgoing and incoming satellites are at opacity 0 (the empty-frame test — that is
  the cut this whole document exists to prevent).
