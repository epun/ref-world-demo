# Moderation — what may become a creature

> User ask: *"we shouldn't allow any explicit drawings or objects of violence."*

This is a public installation. Anyone with a phone draws, and the drawing walks around a
projected world in front of strangers. This document says exactly what the software stops on
its own, what it cannot stop, and what the person running the event has to do. It is written
to be read before an event, not after one.

## The honest summary

| Layer | Catches | Reliability |
|---|---|---|
| **Automatic screen** (`src/moderation/`) | the phallus doodle; four-fold chiral figures | measured on fixtures — one refuses, one holds |
| **Ingest gate** (`src/moderation/gate.ts`) | anything an operator blocked; everything, when hold mode is on | absolute — nothing spawns except through it |
| **Operator** (ghost panel, `moderation` section) | everything else | as reliable as the person watching |

**Automatic screening covers two marks. It does not cover "violence", weapons, blood, hate
text, or genitalia drawn any other way.** The third row is not a fallback; for a live public
event it is the primary control.

## 1. The automatic screen

`src/moderation/` is pure and deterministic — data in, verdict out. No DOM, no Three.js, no
`Math.random`, no `Date`, exactly like `src/shape/`. The same drawing screens identically on
every device and in every replay, which is what makes a decision auditable afterwards.

Three verdicts, because two would be a lie:

- **refuse** — a detector that is reliable on its fixture set fired. The drawing never
  spawns.
- **hold** — a structural detector fired that *cannot* tell the mark from innocent shapes on
  its own. The drawing waits in the operator queue; a person decides.
- **allow** — nothing fired. This is *not* a claim that the drawing is harmless. It is a
  claim that nothing measurable fired.

### `phallus` — refuses

Measures the doodle's silhouette, not its meaning: an elongated shaft, a bulge at one end,
**two round lobes with a cusp between them**, each lobe carrying a fat inscribed disc,
mirror symmetry about the shaft axis, and a far end that is *not* twin-lobed. All of it is
scale- and rotation-invariant, computed in the shape's own principal-axis frame.

Measured on `test/fixtures/moderation.ts`:

| Set | Result |
|---|---|
| 11 phallus fixtures (4 proportions, 5 rotations, 2 drawn as outlines) | **11/11 refused** |
| 56 innocent fixtures | **0 refused, 0 held** |
| the same doodle swept through 12 rotations | 12/12 refused |
| a 124-point sweep of proportions × 4 rotations, restricted to how people draw it (lobes at least as wide as the shaft, shaft ≥ 3× its width) | **101/124 refused — 81%** |
| the same sweep including degenerate proportions (lobes narrower than the shaft, near-square shapes) | 117/216 — 54% |

The cusp test is what separates it from its innocent neighbours. A tree, a mushroom, a
balloon and a spoon are all "shaft plus bulge" — they have no cusp. A standing figure with
two legs *does* have a cusp, and is separated by lobe roundness (legs are thin). A bone and a
dumbbell have cusps at **both** ends, and are separated by the far-end test.

### `four-fold chiral` — holds, never refuses

Measures quarter-turn self-similarity, chirality (it matches no mirror of itself), and
thinness. That is a swastika's structure — and also a bar-drawn pinwheel's, a four-armed
logo's, and a manji's. Nothing at mask level separates them; skeleton-level arm tracing was
tried and is too noisy at drawing resolution to carry a refusal. So it **holds for a person**
rather than throwing the drawing away.

Measured: 5/5 bent-arm crosses held (both handednesses, upright, tilted, thick, short-footed);
0/56 innocent fixtures held — including two pinwheels and a plus sign, which are the shapes
this test is most likely to confuse.

### What is deliberately not attempted

**Weapons, blood, violent scenes, hate text and slurs, and genitalia drawn any other way are
out of scope for automatic screening.** There is no model in this build, and no stroke- or
mask-level rule recognises them: a knife is a triangle on a rectangle, which is also a rocket,
a tree, a boat, a pencil and a house. A detector for them would either refuse innocent
drawings constantly or refuse nothing while *implying* coverage. Both are worse than an
honest gap, so neither ships.

### The tuning bias, stated

Thresholds were tuned so the innocent set has **zero** refusals and **zero** holds, and the
recall that cost is real: the phallus detector requires elongation ≥ 2.8 (all fixtures are
≥ 3.7), a bulge ≥ 2.0× the shaft, and a cusp ≥ 0.35 lobe-radii. A very stubby drawing, a
drawing whose lobes overlap almost completely, or one drawn with the lobes apart from the
shaft so the pieces do not touch, will pass. The 81% figure above is where that lands: the
misses are short shafts carrying lobes as big as the shaft is long, where the cusp between
the lobes all but closes. That is the deliberate trade: at a public
installation, eating a child's drawing of a cat is worse than admitting a rude doodle,
because the operator can remove the doodle in one tap and cannot un-eat the cat.

## 1a. Two things that used to decide the verdict

**The raster.** The criteria are ratios, so resolution should change
nothing — in practice it decided the outcome. One doodle was measured
hitting at 96, 128, 192 and 256 and *missing at 160*, which was the single
size the screen ran: that is how one reached the world in front of the
person who drew it (user report). Binning a hand-drawn shape into forty
width bins puts several criteria on a knife edge and the grid picks the
side. The screen now reads every drawing at four scales and takes the
strongest verdict.

**The last criterion.** Clearing six of seven tests of "shaft with twin
round lobes" used to be an admission. It is now a **hold**: not certain
enough to refuse, far too close to wave through. That is what the seven
held innocents above pay for — a bone, a two-lobed tree and a standing
figure genuinely are that shape by these measures, so they wait for a
person instead of being thrown away. Ink too small or sparse to measure is
never held on this basis: no criteria is ignorance, not a near miss.

## 2. The ingest gate — the authoritative seam

`src/moderation/gate.ts` is the single place a drawing becomes a creature. Both paths go
through it: the phone feed (`connectWorldFeed`'s `onDrawing`) and the world's own draw
overlay. Dev fallback spawns go through it too, so the operator's list is the whole
population. In order:

1. **drawer block list** — an operator decision, absolute
2. **automatic screen** — refuse / hold / allow
3. **hold-for-approval mode** — a live-event switch

**Refusal is silent.** Nothing appears on the projection, nothing goes back to the phone, no
scolding copy anywhere. A public installation must never reward the drawing with a reaction;
the only trace is the operator readout in the ghost panel.

Known gap, accepted: a phone whose drawing was refused or held still shows its own local egg
and waits — the phone is never told. Closing that would mean either replying to the drawer
(which rewards the attempt) or a phone-side screen (out of scope for this pass).

## 3. The operator layer — what actually makes it safe

Open the ghost panel with **shift+d**, section **moderation**:

- **hold arrivals** — every drawing queues instead of spawning. Turn this on for any
  event with an audience that is not being watched drawing. Approve or discard each, or
  approve/discard the whole queue.
- **the "in the world" list** — every admitted creature, newest first. **`remove` is one
  tap** and takes the creature off the projection immediately.
- **`block`** — removes what that handset made, drops anything of theirs in the queue, and
  refuses everything they send afterwards. The drawer id is stable per handset
  (`src/phone/identity.ts`), so blocking survives their next drawing.
- **the readout line** — counts plus the last decision and its reason. This is the only
  place a refusal is visible.

### Running a public event

1. Turn **hold arrivals** on before the doors open.
2. Watch the queue. Approve is one tap; so is discard.
3. If someone is testing the room, **block** them — do not just discard, or they will send
   the same drawing again.
4. If something gets through while hold mode is off, **remove** it from the "in the world"
   list. Do not clear all creatures; that punishes everybody.

Two things to accept before running unattended: nothing automatic recognises violence, and
**hold mode is the only setting that makes the world's contents entirely a human decision.**

## 4. Where the code lives

| Path | Role |
|---|---|
| `src/moderation/mask.ts` | screening raster, principal-axis frame, rotation/mirror self-similarity |
| `src/moderation/phallus.ts` | the refusing detector, with its thresholds and their justification |
| `src/moderation/fourfold.ts` | the holding detector, and why it only holds |
| `src/moderation/screen.ts` | strokes → `{ allow, verdict, reason, confidence, detectors }` |
| `src/moderation/gate.ts` | block list, hold mode, approval queue, admitted list |
| `src/dev/index.ts` | the `refworld.moderation` panel section |
| `test/fixtures/moderation.ts` | both fixture sets — the offensive set and the 56 innocents |
| `test/moderation/` | the measured claims above, as tests |

Changing a threshold means re-running `npx vitest run test/moderation`: the innocent set's
zero-refusal assertion is the gate on any retune.
