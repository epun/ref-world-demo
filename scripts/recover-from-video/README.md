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
pip install av pillow numpy

python3 harvest.py 12          # decode, segment, dedupe → harvest.json
python3 buildlog.py            # → recovered-from-video.json
```

Then load it: `shift+d` → `session` → **restore from a log file**.

- `segment.py` — luma threshold, connected components, hole fill, Moore
  boundary trace, RDP simplify. Rejects the browser chrome, the qr code, the
  minimap, the mouse cursor, anything touching the frame edge (a creature
  half off-screen traces as a rectangle, and a rectangle would be REBUILT as
  a rectangle), and anything that fills its own bounding box.
- `harvest.py` — samples every Nth frame, normalises each silhouette to a
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
