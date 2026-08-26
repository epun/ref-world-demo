# recovering a session from a screen recording

The salvage path of absolute last resort, and the one that actually worked
(2026-08-24). A session was lost with no log and no handset records left;
what survived was a 20-second screen recording of the projection.

**These are traced silhouettes, not the original drawings.** A recovered
creature is a likeness — close enough that the person who drew it recognises
it, and not the same object. Anything produced here is stamped
`config.recovered = true` in the log so it can never be mistaken for a real
session afterwards.

## why it works

The taste does the hard part. TASTE.md gives near-black to characters only
and holds the environment at or above `#353534`, so a single luma threshold
separates creatures from ground, rocks, trees, props and grass with no
segmentation cleverness at all. A rule that exists for how the world should
look turned out to be the thing that made the world recoverable.

## the three steps

```bash
pip install av pillow numpy scipy   # scipy optional, 200x on the segment pass

python3 recluster.py <recording.mp4> 8   # decode, segment, cluster → harvested/
python3 buildlog.py                      # → recovered-from-video.json
```

`harvest.py` is the ORIGINAL pass and is kept for the record. Use
`recluster.py`: the first one counted 68 creatures in a room that held about
two dozen, and the section below says why.

Then load it: `shift+d` → `session` → **restore from a log file**.

- `segment.py` — luma threshold, connected components, hole fill, Moore
  boundary trace, RDP simplify. Rejects the browser chrome, the qr code, the
  minimap, the mouse cursor, anything touching the frame edge (a creature
  half off-screen traces as a rectangle, and a rectangle would be REBUILT as
  a rectangle), and anything that fills its own bounding box.
- `recluster.py` — the counting pass. Same segmentation, same 28×28
  normalised signatures, same mirror-aware IoU; the difference is one
  constraint. See "counting each creature once" below.
- `harvest.py` — the original pass, superseded. Samples every Nth frame,
  normalises each silhouette to a
  28×28 grid, clusters by IoU, and keeps the **largest** instance of each
  cluster. Clustering on the normalised mask rather than on position is what
  survives the camera moving and the creatures wandering. A cluster seen in
  only one sampled frame is dropped: it is usually two creatures overlapping.
- `buildlog.py` — silhouettes → a `refworld.session` log, one `drawing` and
  one `hatch` per creature.

## what it cannot do

- **Recover the original strokes.** It traces the *inflated 3D* creature seen
  isometrically, so generated legs and eyes are already baked into the
  silhouette and get generated again on top. Rebuilt creatures read slightly
  leggier than the originals.
- **Recover names or ids.** Those lived on the handsets. The world names each
  rebuild from its new id instead, deterministically.
- **Tell two similar creatures apart.** The IoU threshold is a judgement
  call; set it too high and one creature comes back twice, too low and two
  become one. Look at `harvest-sheet.png` before you trust the count.

Set `SAME` in `harvest.py` and check the contact sheet. That is the dial.


## counting each creature once

The first pass returned 68 creatures. The room held 23-25.

It clustered on silhouette shape alone, deliberately — ignoring position is
what makes clustering survive a moving camera. But it also throws away the
one signal that can *prove* two blobs are different creatures, and shape
alone could not carry the weight:

| measurement | value |
| --- | --- |
| median mirror-aware IoU between two ARBITRARY detections | **0.673** |
| the threshold used for "same creature" | 0.82 |
| median blob area, early / middle / late in the clip | 840 / 1500 / 4300 px |

These are simple blobby silhouettes at small scale, so most of them look
alike — the gap between "same creature" and "any two creatures" was only
0.15 of IoU. And the camera pans and zooms, so one creature seen before and
after the zoom is a different size, a different resolution, and a different
shape once normalised. Every turn, every partial occlusion, every scale
change made a new creature.

`recluster.py` keeps all of that and adds:

> **two detections in the same frame can never be the same creature.**

True however the camera moves, which is what makes it usable here when
motion tracking is not. It is applied as a veto during average-linkage
agglomeration: the most similar pair merges unless the two were ever seen
together. Where it runs out of legal merges is the answer — not a threshold
tuned until the number looked right.

It also gives a **hard floor** for free: the most detections ever present in
one frame is a lower bound on the population, whatever else is true. The
script asserts its own result against that floor and refuses to write a
count below it.

On the demo recording:

```
1955 detections across 144 frames
hard floor: 19 creatures were on screen at once
median pair IoU 0.673 — how little shape alone tells us
30 creatures after clustering and the artefact filter
names carried across: {'wonder': 25}
```

19 ≤ **30** against the room's own 23-25. The old 68 would have needed 43
creatures the camera never once showed alongside the 19 it did, inside a
20-second clip.

**The mouse cursor.** It traces as a clean little arrow and passes every
shape filter in `segment.py` — it is compact, blobby, and does not touch
the frame edge. What separates it is size: 453px against 1554 for the
smallest real creature. `MIN_EXEMPLAR_AREA` drops it.

**Names.** A bound name points at a cluster index, and re-clustering
renumbers everything. `rebind_names` follows each old binding back to the
frame and bounding box it was proved at, and re-attaches it to whichever new
cluster holds that same observation. A name that cannot be followed is
dropped rather than guessed — a guess puts a real person's word on somebody
else's creature.
