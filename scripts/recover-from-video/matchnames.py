"""
Attach the names the footage actually shows to the creatures they belong to.

The world writes a creature's name above it on hover, and that is the ONLY
place in the recording where a name and a silhouette appear together. Three
such moments exist in twenty seconds: `matt`, `wonder`, `gary`.

For each, take the creature under the label, and match its silhouette
against the 68 traced ones — rasterising each trace back to a mask and
comparing by mirror-aware IoU, the same measure the harvest clusters with.
The match tells us which entry in the log that name belongs to.

Everything else keeps its generated name. A guessed name would be worse
than an honest generated one: it would be a real person's creature wearing
somebody else's word.
"""
import json, os, sys
import numpy as np
from PIL import Image, ImageDraw
import av
sys.setrecursionlimit(100_000)
import segment
from harvest import signature, match

D = '/root/.claude/uploads/e77b8da4-722b-5820-bdef-2fb6625a8af3'
SRC = os.path.join(D, '7599eb03-Ref_Demo.mp4')

# frame, label position (x, y), the word — read off the footage.
SIGHTINGS = [
    (324, 461, 450, 'matt'),
    (396, 507, 228, 'wonder'),
    (370, 395, 417, 'gary'),
]


def frames_of_interest(want):
    out = {}
    c = av.open(SRC)
    s = c.streams.video[0]
    for i, f in enumerate(c.decode(s)):
        if i in want:
            out[i] = f.to_image()
        if len(out) == len(want):
            break
    c.close()
    return out


def stroke_mask(stroke, size=96):
    """Rasterise a traced outline back to a filled mask, to compare shapes."""
    img = Image.new('L', (size, size), 0)
    d = ImageDraw.Draw(img)
    pts = [(p[0] * size, p[1] * size) for p in stroke['pts']]
    if len(pts) >= 3:
        d.polygon(pts, fill=255)
    return np.asarray(img) > 127


def main():
    rows = json.load(open('harvest.json'))
    z = np.load('masks.npz')
    sigs = [signature(z[f'm{n}']) for n in range(len(rows))]

    imgs = frames_of_interest({s[0] for s in SIGHTINGS})
    assigned = {}
    for (fi, lx, ly, name) in SIGHTINGS:
        img = imgs.get(fi)
        if img is None:
            print(f'{name}: frame {fi} not decoded')
            continue
        blobs = segment.blobs_from_frame(img, min_area=400, reject_border=False)
        # The label sits just above its creature, roughly centred on it.
        best, bestd = None, 1e9
        for b in blobs:
            x0, y0, bw, bh = b['bbox']
            cx = x0 + bw / 2
            # the label's baseline is above the creature's top
            # The label sits directly above its creature. Horizontal
            # agreement is what identifies it; a blob whose top is far below
            # the label, or that sits above the label, is somebody else.
            if abs(cx - (lx + 14)) > 45:
                continue
            if not (0 <= y0 - ly <= 60):
                continue
            d = abs(cx - (lx + 14)) + (y0 - ly) * 0.3
            if d < bestd:
                best, bestd = b, d
        if best is None:
            print(f'{name}: no creature under the label')
            continue
        sig = signature(best['mask'])
        scores = [(match(sig, s), i) for i, s in enumerate(sigs)]
        scores.sort(reverse=True)
        top, idx = scores[0]
        runner = scores[1][0] if len(scores) > 1 else 0.0
        print(f'{name}: best trace #{idx} iou {top:.3f} (runner-up {runner:.3f}) '
              f'bbox {best["bbox"]}')
        assigned[name] = {'index': idx, 'iou': round(top, 3),
                          'runnerUp': round(runner, 3)}
        Image.fromarray((~best['mask'] * 255).astype(np.uint8)).save(f'named-{name}.png')

    json.dump(assigned, open('names.json', 'w'), indent=2)
    print('\n', json.dumps(assigned, indent=2))


if __name__ == '__main__':
    main()
