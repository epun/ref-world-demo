# QA + performance audit — 2026-08-17

Auditor: automated QA pass (Claude), production build served via `npx vite preview`.
Method per `.claude/skills/threejs-qa-release` / `threejs-debug-profiler` (rAF probes,
GL-object counters injected before page scripts, canvas-pixel checks, console inventory).

## Audit target and caveats

- **Build audited:** production `npx vite build` (121 modules) at commit **`0e7c3a5`+
  (tour, hatch-all moment, test-blob removal) including what later landed as `4dea839`**
  (per-kind density sliders were present in the panel). During the audit these were
  *uncommitted concurrent edits*; they landed as `f1e6202`, `63f7b03`, `4dea839` mid-audit.
  Still-uncommitted at audit end: `src/character/interpret.ts`, `src/dev/index.ts`,
  `src/shape/{analyze,contour,raster}.ts`, `src/world/{props,scatter}.ts`, tests. The
  console/perf/memory data therefore **predates `f1e6202`'s ink-edge-threshold default
  and `63f7b03`/`4dea839`** by one working-tree snapshot; nothing in those diffs touches
  the render-loop structure the perf findings are about.
- The first perf stage (desktop baseline) ran one build earlier (pre-tour, test blob
  still present); it was re-measured on the audited build — both numbers are reported.
- `gate:static` — clean (78 files, 0 violations). `tsc --noEmit` — clean (pre-edit tree;
  the sandbox permission layer blocked a re-run after the tour/blob edits, but
  `vite build` compiled the final tree without errors).
- **All timings are SwiftShader software GL** (sandbox has no GPU;
  `ANGLE (Google, Vulkan SwiftShader)`). Costs are inflated far beyond the task's quoted
  5–10× — the empty world renders at ~1–2 fps here. Only **relative** numbers
  (population scaling, resolution scaling, before/after clear) are meaningful; no
  absolute fps verdicts are drawn. A side effect worth knowing: with frames ≥100 ms the
  `dt` clamp (see finding D3) stretches all spring motion ~9× wall-clock, so animation
  waits in the repro steps below assume that.

Screenshots referenced below live in the session scratchpad
(`/tmp/claude-0/-home-user-ref-world-demo/e77b8da4-722b-5820-bdef-2fb6625a8af3/scratchpad/`).

---

## 1. Performance under population

rAF-delta probe via `page.evaluate`, 10–30 s windows. Population spawned through the
ghost panel's `demo` skill (`spawn fallback creatures` ×n, `hatch all`) exactly as a
presenter would.

### Desktop 1280×800, DPR 1

| stage | pop | avg ms | p50 | p95 | max | frames |
|---|---|---|---|---|---|---|
| baseline, empty world, no panel | 0 | 925 | 883 | 1050 | 1050 | 6 |
| 6 hatched, panel open | 6 | 819 | 800 | 983 | 1000 | 31 |
| 12 hatched, panel open | 12 | 1271 | 1350 | 1600 | 1600 | 4 |
| 24 hatched (cap), panel open | 24 | 1600 | 1583 | 1717 | 1717 | 5 |

(Earlier build with test blob: baseline 927 ms — identical; the blob was never a cost.)

### Phone viewport 390×844, DPR 2 (drawing buffer 780×1688)

Note: a *real* coarse-pointer phone never sees this page — `src/main.ts` redirects it to
`/draw/`. This measures world render cost at phone resolution with a fine pointer.

| stage | pop | avg ms | p95 | frames |
|---|---|---|---|---|
| baseline, empty, no panel | 0 | 632 | 733 | 13 |
| 6 hatched, panel open | 6 | 883 | 983 | 32 |
| 12 hatched, panel open | 12 | 1150 | 1933 | 10 |
| 24 hatched, panel open | 24 | 1180 | 1300 | 10 |
| 24 hatched, panel hidden | 24 | 1135 | 1183 | 9 |
| after `clear creatures` | 0 | 605 | 750 | 13 |

### Resolution/fixed-cost probe (same session, sequential)

| viewport | pop | avg ms |
|---|---|---|
| 480×320 | 0 | 319 |
| 480×320 | 12 | 824 |
| 1280×800 | 0 | 545 |

### Reading

- **The empty world costs as much as a 6-creature world.** The frame is dominated by a
  fixed full-frame pipeline: the scene is rendered **twice** per frame (color pass, then
  a normal-override pass) plus the fullscreen ink composite plus the grain compose —
  `src/world/ink.ts:434–447`, `src/world/scene.ts:167–168`. 6.7× more pixels only takes
  the empty frame from 319→545 ms under software GL (vertex/draw overhead dominates
  there), but on real GPUs the four full-res passes are fill-rate, and at DPR 2 on a mid
  phone that is ~5.3 MP of shaded pixels per frame before any creature exists.
- **Population scales sub-linearly and within bounds:** 0→24 creatures adds ~0.7× of
  baseline (925→1600 ms desktop; 632→1180 phone-viewport), i.e. ~25–40 ms per creature
  under SwiftShader ≈ **~3% of baseline each**. The `MAX_POPULATION = 24` guard
  (`src/creatures/manager.ts:43`) plus sink-and-fade retirement worked as designed.
- **Panel cost is small**: 24-pop with panel hidden vs open: 1135 vs 1180 ms (~4%).
- **What is controllable at runtime:** ink params (edge threshold / line width / wobble /
  hatch strength sliders) — yes; grain — **no** (see D5); pass-level toggles — none, so
  per-pass isolation beyond the resolution probe above was not measurable in-browser.

---

## 2. Console hygiene

Collected across world (with panel + spawn + hatch + emotes + overlay), `/draw/`, and
`/phone.html` flows. Excluding the two known sandbox artifacts (unreachable
`wss://broker.emqx.io:8084/mqtt`, `/favicon.ico` 404 — but see finding P1):

| page | type | message | verdict |
|---|---|---|---|
| world | warning | "Automatic fallback to software WebGL has been deprecated…" | sandbox artifact (headless flag) |
| world | warning ×4 | "GL Driver Message … GPU stall due to ReadPixels" | sandbox artifact — appears on a bare load with no app readbacks; it is the headless compositor reading back the SwiftShader canvas, not app code (no `readPixels`/`drawImage(webglCanvas)` outside the panel's gate buttons) |
| world (after shift+d) | requestfailed | `https://fonts.googleapis.com/css2?family=IBM+Plex+Mono…` `ERR_CONNECTION_RESET` | **real**: `ghost-panel/styles.js:11` `@import`s Google Fonts — external network dependency in every deployed build's panel (finding P2) |
| world (after shift+d) | info ×2 | `[Ghost Panel][diagnostics] Auto-corrected: no-workflow` | vendored panel log noise in production console (minor) |
| /draw/ | — | clean | |
| /phone.html | — | clean (plus favicon 404) | |

**No Three.js warnings** (no shader-compile, texture-size, or deprecation messages) and
**no page errors** in any exercised flow, including 8× replace-by-id, mid-hatch
disposal, and the full mobile handoff.

---

## 3. Memory / leaks

Live GL objects counted by wrapping `create*/delete*` on the WebGL context prototypes
before page load (renderer.info is not reachable — the renderer is not exposed on
`window`; `window.__refworldCreatures` from `src/creatures/manager.ts:635` drove the
cycles). Baseline: **8 tex / 127 buf / 10 prog / 6 fbo / 2 rbo**.

| protocol | end state | verdict |
|---|---|---|
| 8 × spawn **same id** (`leak-test`) → hatch → respawn (replace-by-id path) | steady 9 tex / 135 buf / 11 prog throughout; after `clearAll` **exactly baseline** | clean |
| 10 distinct ids → hatch all → `clearAll` | 18 tex / 207 buf at pop 10 (+1 tex, +8 buf per creature); after clear **exactly baseline** | clean |
| 3 × clear **mid-hatch** (dispose while the hatch animation owns the egg) | **exactly baseline** | clean |
| panel path: spawn 24 → hatch → `clear creatures` (phone-viewport run) | 8/127/10 after clear | clean |

JS heap (`performance.memory`): oscillated 18→36 MB across the cycles and 18→113 MB at
pop 24 with panel — **no monotone growth**; post-clear plateaus are GC lag, not
retention. **No geometry/texture/program leak found.** The disposal chains
(`manager.disposeSlot` → `hatch.dispose`/`egg.dispose`/`character.dispose`,
`FlatShadows.removeShadow`) are airtight in practice.

---

## 4. Bundle

`vite build` (production defines confirmed: no `__IS_DEV__` in output; ghost panel does
**not** mount at boot — verified 0 `.ghost-panel` nodes until shift+d):

| chunk | size | gzip | role |
|---|---|---|---|
| `lighting-*.js` | 777.9 kB | 210.2 kB | **three.js core** + shared world modules (shared by both entries) |
| `index-ZdSTuZAp.js` | 554.7 kB | 152.3 kB | **ghost-panel** — lazy: loaded only via `world-*.js` → dynamic `import()` chain on first shift+d (verified in dist import graph + at runtime) |
| `world-*.js` | 69.4 kB | 26.1 kB | world entry |
| `GLTFLoader/GLTFExporter/PLYLoader/OBJExporter-*.js` | 88.9 kB total | 27.2 kB | ghost-panel features, lazy behind the panel chunk |
| `phone-*.js` | 20.3 kB | 7.4 kB | phone entry (also pulls `lighting-*`) |
| `index-Bu0Bi-21.js` | 10.2 kB | 4.1 kB | `src/dev` wrapper (lazy) |
| `client-*.js`, `draw-feed-*.js` | ~5 kB | — | net, lazy |

- World first load ≈ **848 kB JS (236 kB gzip)**; phone ≈ 798 kB (218 kB gzip). The
  >500 kB warning is the known three.js chunk; nothing else exceeds it.
- **Ghost-panel laziness confirmed** — production pays 0 bytes for it until shift+d.
- The three.js chunk being named `lighting-*` is cosmetic (first module in chunk); a
  `manualChunks: { three: ['three'] }` would give it a stable, cache-friendly name.

---

## 5. Flow spot-checks

| check | result | evidence |
|---|---|---|
| `d` opens draw overlay (slides, doesn't pop) | pass | `qa-flow-draw.png` |
| draw → done → egg (overlay closes, egg painted with drawing, marking visible) | pass | `qa-flow-egg.png`, `positions() → kind:'egg'` |
| `h` → hatch → character | pass — `kind:'character'`, solid near-black body + white marking, tiny legs | `qa-flow-hatched.png` |
| character walks | **not confirmed live** — position unchanged over 20 s wall. At ~1 fps the dt clamp compresses 20 s wall to ~2 s of sim, and stillness-as-a-state makes idling expected. Not evidence of a bug, but locomotion rests on unit tests, not this run (see D3) | |
| emotes 1–7 → color-emoji bubble | pass mechanically — bubble appears, emoji in color; **but ~15 px tall at the default framing, illegible** (finding D4) | `qa-flow-emote-1/4/7.png` |
| shift+d panel, right-docked, all skills | pass — `demo` (spawn/hatch/pause/resume/clear/reset, wander speed, pause hatch timers, camera mode, dwell length, hatch-all moment), `environment` (per-kind density/scale ×9 kinds, scatter density, ink sliders), `character` (7 emotes), `taste` (3 gates + stillness note). `weather` folder wired per `src/dev/index.ts:367` (select/sliders — not button-probed) | `qa-gates-panel.png` |
| plain `d` vs shift+d separation | pass (overlay did not open on shift+d) | |
| weather glides (no snap) | pass — `setWeather('rain',1)`: rainAmt 0.100→0.245→0.359→0.436→0.483→0.512→0.528→0.538 over ~9.6 s wall, monotone spring approach; wind 0.373→0.691; exposure 0.975→0.863 | `qa-flow-rain.png` |
| wind sways scatter | pass — 1.6–1.9% frame-to-frame pixel change at static camera, visible sway in trees | `qa-flow-wind-a/b/c.png` |
| day/night shadow stretch | pass — morning (t=0.3): sun altitude 0.29 rad, long stretched stamps; noon: 0.93 rad, short tucked stamps; night (t=0.05): altitude −0.88, presence 0 → stamps gone | `qa-flow-morning/noon/night.png` |
| night look | **moiré risk** — see D7 | `qa-flow-night.png` |
| collision vs props | no violations: 540 samples × 12 wandering creatures, 0 with margin < −0.05 under the `resolveHard` invariant (center ≥ collider.r + 0.8·creature.r). Weak evidence though: sim-time compression kept creatures >10 units from any hard collider all run, so the contact path wasn't stressed live (unit tests cover it) | `qa-collision.png` |
| minimap click pans | pass — 5.4% view diff after click vs 1.6–1.9% ambient-drift floor; glided reframe (`frameAt`), no snap | `qa-flow-premap/postmap.png` |
| orbit both axes / shift-pan / wheel zoom | pass — drag 6.5%, shift-drag 7.1%, wheel 8.0% view diffs; all glide via springs | `qa-flow-cam-*.png` |
| mobile handoff (`refworld:handoff` → `/phone.html` → hatch → alive) | **pass** — portrait renders the creature (3001 dark samples), name shown lowercase ("bean"), 7 stroke-icon emote buttons, paper-scrap minimap; only console entry the favicon 404 | `mobile-2-wait.png`, `mobile-3-alive.png` |
| uppercase anywhere | none in app UI (join line, hints, names, room codes all lowercase). Ghost-panel chrome uses `text-transform: uppercase` in its own styles (vendored; see P3) | screenshots above |
| accent color outside bubbles | none — achromatic gate measured 0.00% warm-accent coverage; the only color on screen is the emoji inside bubbles (documented carve-out, `src/character/bubble.ts:255`) | |

## 6. Taste gates (panel `refworld.taste`, run with 3 hatched creatures on screen)

| gate | readout | verdict |
|---|---|---|
| damping audit | "pass: all registered springs run at zeta >= 1" | pass |
| achromatic | "pass: mean saturation 0.054 (target <= 0.288), warm-accent coverage 0.00% (limit 2%)" | pass |
| value histogram | "pass: histogram mode at luma 0.76 (ground target 0.74 ± 0.08), near-black coverage 0.3% (limit 15%)" | pass |
| stillness (info note) | "60 spring(s) registered — idle elements keep drifting on the ambient floor" | note only — see D6 |
| uppercase / hex / motion (build-time) | `gate:static` clean — 78 files, 0 violations | pass |
| density probe, mark-set lint, grain check | **no button, no build check** — see D6 | not runnable |

---

## Findings, ranked

### Breaks demo

None found. All primary flows (draw→egg→hatch, panel spawn/hatch/clear, emotes,
weather/day-night, camera scheme, minimap, mobile handoff) completed without errors, and
disposal is leak-free at the GL level.

### Degrades demo

**D1 — Fixed full-frame render cost dominates; the biggest P6 (60 fps mid phone) risk.**
*Observed:* empty world ≈ 6-creature world in frame cost on both viewports (§1); the
frame always pays two full scene renders + two fullscreen quads
(`src/world/ink.ts:434–447` — color pass, normal-override pass, composite;
`src/world/scene.ts:167–168` — grain compose). At DPR 2 phone resolution that is ~5.3 MP
shaded per frame before any content scales.
*Repro:* rAF probe on an empty world vs populated (§1 tables).
*Suspected cause:* ink pass architecture — normals rendered as a second full geometry
pass because `WebGLRenderTarget` was used without MRT.
*Suggested fix:* WebGL2 is already required (`WebGL 2.0` context observed) — use a
multiple-render-target (`WebGLMultipleRenderTargets` / `renderTarget.textures`) to emit
color+normal in **one** scene pass; or reconstruct normals from depth in the composite
shader and drop the second pass entirely. Also consider capping `setPixelRatio` below 2
on small screens (`src/world/scene.ts:40`) and merging the grain compose into the ink
composite (one fullscreen pass instead of two).

**D2 — No pass-level perf controls or fallback tier.** *Observed:* grain and the ink
chain cannot be disabled or degraded at runtime — no handle exists (see D5), so a
struggling device has no ladder to fall down, and pass costs can't be isolated in the
field. *Suggested fix:* expose `ink`/`grain` enable flags + a half-resolution render
scale option on `WorldHandles`, wire them into the panel's environment folder.

**D3 — `dt` clamp turns low fps into slow motion.** *Observed:* every spring, gait, and
behavior advances on `dt = min(frame, 100 ms)` (`src/world/scene.ts:153`); below 10 fps
the world runs slower than wall-clock (~9× stretch at the sandbox's ~1 fps: a hatch takes
~30 s wall; a 20 s emote/walk window advances ~2 s of sim). On a mid phone dipping to
5–8 fps during a hatch burst, motion (and the *feel* of the 1823 ms token) stretches
2–3×. *Repro:* any measurement above; `qa-flows` hatch timings.
*Suspected cause:* deliberate anti-lurch clamp, tuned for ≥10 fps.
*Suggested fix:* keep the clamp for the behavior/physics step but let springs integrate
the real elapsed time (they're unconditionally stable at ζ≥1 — no explosion risk), or
substep springs 2–3× when dt clamps. Worth a design pass rather than a blind change.

**D4 — Emote bubbles are illegible at the default framing.** *Observed:* the
color-emoji bubble renders ~12–16 px tall at the default camera distance on 1280×800 —
the emote lands as an unreadable speck (`qa-flow-emote-1/4/7.png`); the "legible emote
signal at world scale" (`src/character/bubble.ts`) doesn't hold on the big screen, which
undercuts the phone→world emote demo beat. *Repro:* hatch a creature, press 1–7 at
default zoom. *Suspected cause:* bubble scale is proportional to the (intentionally
tiny, 1–3% of viewport) creature. *Suggested fix:* give the bubble a screen-space
minimum size (scale the sprite by distance so it never drops below ~40–48 px), or zoom
the camera's emote framing; keep the ζ≥1 entrance as is.

**D5 — Grain has no runtime handle; panel's grain slider silently absent.**
*Observed:* the panel supports a grain-amplitude slider
(`src/dev/index.ts:310–320`) but `src/main.ts` never passes `setGrainAmplitude`, and
`GrainPass` is a local in `start()` (`src/world/scene.ts:54`) — not on `WorldHandles`.
Confirmed live: no "grain amplitude" control in the mounted panel. The same applies to
`environment.setWindOverride` (`src/world/environment.ts:288`) — built for "a panel
slider" that isn't wired (`hasWindSlider: false`). *Suggested fix:* add `grain` (or a
`setGrainAmplitude` closure) to `WorldHandles` and forward it in `main.ts:mountPanel`;
add the wind-override slider to the weather folder.

**D6 — TASTE §7 gate coverage is 6 of 8; two gates aren't buttons or build checks.**
*Observed:* runnable: damping/achromatic/value-histogram (panel, all pass) +
uppercase/hex/motion (`gate:static`, clean). Not runnable anywhere: **density probe**
and **mark-set lint**; **grain check** is impossible without a grain handle (D5);
**stillness probe** is an info note (60 springs registered), not a measurement.
`densityGate`/`stillnessGate` implementations already exist unwired in
`src/taste/gates.ts:205,231`. TASTE's own rule: "a constraint that isn't a button
doesn't survive a build." *Suggested fix:* wire `densityGate` to a coverage readback
(the achromatic readback path in `src/dev/index.ts:173` already grabs frames),
`stillnessGate` to a 2 s two-sample probe of a few scene positions, and add the grain
uniformity check once D5 lands.

**D7 — Night rendering aliases into full-frame moiré and eats the character
silhouette.** *Observed:* at `timeOfDay 0.05` the whole frame — ground and the
character's near-black mass included — is covered by dense diagonal hatching that
aliases into a corduroy/moiré pattern (`qa-flow-night.png`); the "one solid shape"
silhouette read is lost and the value structure inverts (mid-grey stripes everywhere).
Measured under SwiftShader at DPR 1; real displays may shimmer worse in motion.
*Repro:* panel weather folder → time of day ≈ 0.05, or `__refworldEnv.setTimeOfDay(0.05)`.
*Suspected cause:* hatch-strength shading ramping toward 1 across the entire frame at
night in the ink composite (`hatchMul` path, `src/world/ink.ts` + environment `hatchMul`),
with a hatch frequency near the pixel grid. *Suggested fix:* cap night `hatchMul` so the
ground keeps ≥ ~50% plain paper, exclude the character's near-black band from hatching
(it should stay solid — mirrors the grain rule), and screen-space-quantize the hatch
frequency to avoid the interference band.

### Polish

**P1 — favicon 404 in every page's console.** No icon link in `index.html`,
`phone.html`, or `public/draw/index.html`. One-line fix in each `<head>` (keeps the
no-binary-assets stance):
`<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'><circle cx='12' cy='13' r='8' fill='%23353534'/></svg>">`
(not applied — report only).

**P2 — Ghost panel fetches Google Fonts at runtime.** `ghost-panel/styles.js:11`
`@import`s IBM Plex Mono — an external network dependency in the deployed demo's panel;
offline/firewalled venues get console noise + fallback type. Vendored dep: pin the font
locally or strip the import in the vendored copy.

**P3 — Ghost-panel chrome breaks the taste on-screen while presenting.** Uppercase
(`text-transform: uppercase`, `ghost-panel/styles.js:579` et al.), dark filled panels,
and a red filled delete button in the scene outliner (`qa-gates-panel.png`) — all three
mark-set/uppercase/accent rules, on screen during live demos since the panel ships in
every build. Vendored and presenter-facing, so severity is low, but it is the one place
an audience can see the taste violated. Option: a small CSS override layer in
`src/dev/index.ts` when mounting.

**P4 — First shift+d has no affordance.** In production the keypress triggers a
554 kB (152 kB gz) lazy chunk; on a slow link/device the panel appears seconds later
with no feedback (sandbox: ~4–5 s). Repro: fresh load, shift+d, watch nothing happen.
Fix: a tiny "loading panel…" hairline note, or preload the chunk on idle.

**P5 — World hotkeys fire while typing in panel controls.** The `keydown` handlers in
`src/main.ts:356,402` don't check `event.target` — with the panel focused, `h` hatches,
`t` toggles the tour, `1–7` emote, `d` opens the overlay. Repro: focus any panel
input/select, press `h`. Fix: bail when `event.target` is an
input/select/textarea/contentEditable.

**P6 — Console noise from the panel in production** (`[Ghost Panel][diagnostics]
Auto-corrected: no-workflow` ×2 on mount). Vendored; suppressible via its diagnostics
option if exposed.

**P7 — Stale comment.** `src/character/bubble.ts:193` still says "flatten the whole
thing to grayscale" above the code that deliberately keeps emoji in color (the carve-out
is correctly documented 60 lines later). One-line comment fix.

**P8 — Minimap is a filled panel.** `SURFACE.ground` fill inside the hand-wavering
border (`src/ui/minimap.ts:243`) — technically outside the icon/ruleLine/border mark
set; the file argues it "reads as a torn paper scrap" (`src/ui/minimap.ts:5–7`). Flagged
for a deliberate taste ruling rather than as a defect; a mark-set lint gate (D6) would
be the place to encode the verdict. Same pattern on the phone alive screen.

**P9 — three.js chunk naming/caching.** The 778 kB shared chunk is named `lighting-*`;
`manualChunks` would give it a stable name so redeploys don't bust the biggest cached
asset (cosmetic; the >500 kB warning itself is known and accepted).

---

## Summary verdicts

- **Population/leak behavior: solid.** 24-creature cap honored, replace-by-id and
  mid-hatch disposal exact to the GL object, no error spam, no monotone heap growth.
- **Flows: all pass** (with locomotion verified only indirectly — sandbox sim-time).
- **Taste: the three runnable pixel/motion gates pass on the live build**; two of the
  eight §7 gates don't exist as buttons yet (D6), and night hatching (D7) plus panel
  chrome (P3) are the only observed on-screen taste risks.
- **P6 "60 fps on a mid phone" is not demonstrable in this sandbox**, but the render
  architecture (two scene passes + two fullscreen passes at DPR 2, no degrade ladder) is
  the load-bearing risk — D1/D2 before creature-count tuning.
