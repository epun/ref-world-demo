# the harvest, kept

The intermediate results of the 2026-08-24 salvage, committed on purpose.

Re-running `harvest.py` needs the original 20-second screen recording,
which is not in this repository and may not survive anywhere. These four
files are everything the recording was reduced to, so the recovery can be
re-derived, re-tuned or re-checked without it:

| file | what it is |
|---|---|
| `harvest.json` | the 68 traced outlines, in the kit's 0..1 wire shape |
| `masks.npz` | each creature's actual silhouette mask, as cut from the footage — the ground truth the traces were simplified from |
| `provenance.json` | every sighting: which blob, in which frame, at which bbox, went into which cluster. This is what bound `wonder` to its creature by lookup rather than by resemblance |
| `bound-names.json` | the names the footage proves, by cluster index |

`buildlog.py` turns these into `public/recovered/session.json` with no
video involved. If a name later gets identified by eye, add it to
`bound-names.json` and re-run that one script.
