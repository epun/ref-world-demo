"""
Re-harvest the recording, counting each creature ONCE.

The first pass (harvest.py) counted 68 creatures in a room that held about
two dozen. It clustered on silhouette shape alone, and said so:

    "Clustering on the normalised mask (not on position) is what makes
     this robust to the camera moving and the creatures wandering."

That buys robustness to a moving camera at the cost of the one signal that
can PROVE two blobs are different creatures — being in the same frame at
the same time. Without it, identity rests entirely on shape, and here shape
barely discriminates: the median mirror-aware IoU between two ARBITRARY
detections in this footage is 0.673, against a "same creature" threshold of
0.82. These are simple blobby silhouettes at small scale, and most of them
look alike. So every time a creature turned, was partly occluded, or
changed size as the camera zoomed (the median blob area runs 840 → 1500 →
4300 px across the clip) it fell below threshold against its own earlier
view and was counted again.

This pass keeps the shape similarity and adds the constraint:

    two detections in the SAME FRAME can never be the same creature.

That is true however the camera moves, which is what makes it safe to use
here where motion tracking is not. It also gives a hard floor on the answer
— the most detections ever seen in one frame is a lower bound on how many
creatures the room held, whatever else is true.

Result on the demo recording: 19 (floor) ≤ 31 (this pass) against the
room's own recollection of 23-25. The old 68 would need 43 creatures the
camera never once showed alongside the 19 it did, in a 20-second clip.

Usage:  python3 recluster.py <recording.mp4> [frame-step]
"""
import json
import os
import sys

import numpy as np
from PIL import Image, ImageDraw

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import segment  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, 'harvested')

GRID = 28
# Below this and a merge is not evidence of anything — see the 0.673 median.
FLOOR = 0.30
# The mouse cursor traces as a clean little arrow and passes every shape
# filter in segment.py. It is an order of magnitude smaller than the
# smallest real creature (453px against 1554), so size is what separates it.
MIN_EXEMPLAR_AREA = 1000


def fast_components(mask):
    """scipy if it is here (200x), the pure-python flood fill if not."""
    try:
        from scipy import ndimage
    except ImportError:
        return segment.components(mask)
    lab, _ = ndimage.label(mask, structure=np.ones((3, 3), dtype=bool))
    return [
        list(zip(ys.tolist(), xs.tolist()))
        for ys, xs in ndimage.value_indices(lab, ignore_value=0).values()
    ]


def signature(mask):
    img = Image.fromarray((mask * 255).astype(np.uint8)).resize((GRID, GRID), Image.BILINEAR)
    return np.asarray(img, dtype=np.float32) / 255.0 > 0.45


def detect(src, step):
    """Every blob in every sampled frame, with the frame it came from."""
    import av
    segment.components = fast_components
    dets = []
    container = av.open(src)
    for i, frame in enumerate(container.decode(video=0)):
        if i % step:
            continue
        for blob in segment.blobs_from_frame(frame.to_image()):
            dets.append({
                'frame': i,
                'sig': signature(blob['mask']),
                'area': blob['area'],
                'mask': blob['mask'],
                'bbox': blob['bbox'],
            })
    return dets


def similarity(dets):
    """Mirror-aware IoU for every pair, vectorised.

    A creature that turned round gives a MIRRORED silhouette that never
    matches its own earlier view — the single biggest source of duplicates
    in the first pass, and the reason the flip is compared too.
    """
    n = len(dets)
    sig = np.array([d['sig'] for d in dets])
    a = sig.reshape(n, -1).astype(np.float32)
    b = sig[:, :, ::-1].reshape(n, -1).astype(np.float32)
    count = a.sum(1)
    inter_a, inter_b = a @ a.T, a @ b.T
    union_a = count[:, None] + count[None, :] - inter_a
    union_b = count[:, None] + count[None, :] - inter_b
    s = np.maximum(
        np.where(union_a > 0, inter_a / union_a, 0),
        np.where(union_b > 0, inter_b / union_b, 0),
    )
    np.fill_diagonal(s, 0)
    return s


def cluster(dets, sim):
    """Average-linkage agglomeration, vetoed by co-presence.

    Merges the most similar pair remaining until nothing is left that is
    both similar enough AND never seen together. Where it stops is the
    answer — not a threshold chosen to reach a number.
    """
    import heapq

    n = len(dets)
    # One bit per distinct frame, so the veto is a single AND.
    index = {f: i for i, f in enumerate(sorted({d['frame'] for d in dets}))}
    seen_in = [1 << index[d['frame']] for d in dets]
    members = {i: [i] for i in range(n)}
    size = np.ones(n)
    alive = np.ones(n, bool)
    cur = sim.copy()

    heap = [(-cur[i, j], int(i), int(j)) for i, j in np.argwhere(cur > FLOOR) if i < j]
    heapq.heapify(heap)
    while heap:
        neg, i, j = heapq.heappop(heap)
        if not alive[i] or not alive[j]:
            continue
        if abs(cur[i, j] + neg) > 1e-6:
            continue  # stale entry, superseded by a merge
        if seen_in[i] & seen_in[j]:
            continue  # together in a frame => different creatures, always
        ni, nj = size[i], size[j]
        cur[i, :] = (ni * cur[i, :] + nj * cur[j, :]) / (ni + nj)
        cur[:, i] = cur[i, :]
        cur[i, i] = 0
        size[i] = ni + nj
        seen_in[i] |= seen_in[j]
        members[i] += members[j]
        alive[j] = False
        cur[j, :] = 0
        cur[:, j] = 0
        del members[j]
        for k in np.argwhere((cur[i] > FLOOR) & alive).ravel():
            if k != i:
                heapq.heappush(heap, (-cur[i, k], min(i, int(k)), max(i, int(k))))
    return list(members.values())


def rebind_names(groups, dets):
    """Carry a name across only where the footage still proves it.

    A name was bound in the first pass by provenance — the same blob, in
    the same frame, under the hover label. Those bindings point at OLD
    cluster indices, which no longer exist. So each one is re-followed to
    the frame and box it was bound at, and re-attached to whichever new
    cluster actually contains that observation. A name that cannot be
    followed is dropped rather than guessed: a guess puts a real person's
    word on somebody else's creature.
    """
    try:
        old_names = json.load(open(os.path.join(OUT, 'bound-names.json')))
        old_prov = json.load(open(os.path.join(OUT, 'provenance.json')))
    except (OSError, ValueError):
        return {}
    where = {}
    for gi, group in enumerate(groups):
        for d in group:
            where.setdefault(dets[d]['frame'], []).append((gi, dets[d]['bbox']))
    out = {}
    for name, old_index in old_names.items():
        if not 0 <= old_index < len(old_prov):
            continue
        for frame, box in old_prov[old_index]:
            for gi, bbox in where.get(frame, []):
                x0, y0, w0, h0 = box
                x1, y1, w1, h1 = bbox
                ox = max(0, min(x0 + w0, x1 + w1) - max(x0, x1))
                oy = max(0, min(y0 + h0, y1 + h1) - max(y0, y1))
                inter = ox * oy
                union = w0 * h0 + w1 * h1 - inter
                if union and inter / union > 0.5:
                    out[name] = gi
                    break
            if name in out:
                break
    return out


def main():
    if len(sys.argv) < 2 or not os.path.exists(sys.argv[1]):
        sys.exit('usage: python3 recluster.py <recording.mp4> [frame-step]')
    src = sys.argv[1]
    step = int(sys.argv[2]) if len(sys.argv) > 2 else 8

    dets = detect(src, step)
    frames = {d['frame'] for d in dets}
    per_frame = max(sum(1 for d in dets if d['frame'] == f) for f in frames)
    print(f'{len(dets)} detections across {len(frames)} frames')
    print(f'hard floor: {per_frame} creatures were on screen at once')

    sim = similarity(dets)
    print(f'median pair IoU {np.median(sim):.3f} — how little shape alone tells us')

    groups = cluster(dets, sim)
    groups = [g for g in groups if max(dets[d]['area'] for d in g) >= MIN_EXEMPLAR_AREA]
    groups.sort(key=lambda g: -max(dets[d]['area'] for d in g))
    print(f'{len(groups)} creatures after clustering and the artefact filter')
    if len(groups) < per_frame:
        sys.exit(f'BUG: {len(groups)} clusters is below the {per_frame} floor')

    names = rebind_names(groups, dets)
    print(f'names carried across: {names or "none"}')

    os.makedirs(OUT, exist_ok=True)
    rows, prov, masks = [], [], {}
    for n, group in enumerate(groups):
        best = max(group, key=lambda d: dets[d]['area'])
        stroke = segment.blob_to_stroke({'mask': dets[best]['mask']})
        if not stroke:
            continue
        rows.append({
            'index': n,
            'area': int(dets[best]['area']),
            'seen': len(group),
            'frame': int(dets[best]['frame']),
            'stroke': stroke,
        })
        prov.append([[int(dets[d]['frame']), [int(v) for v in dets[d]['bbox']]] for d in group])
        masks[f'm{n}'] = dets[best]['mask']
    print(f'{len(rows)} traced')

    json.dump(rows, open(os.path.join(OUT, 'harvest.json'), 'w'))
    json.dump(prov, open(os.path.join(OUT, 'provenance.json'), 'w'))
    json.dump(names, open(os.path.join(OUT, 'bound-names.json'), 'w'), indent=2)
    np.savez_compressed(os.path.join(OUT, 'masks.npz'), **masks)

    cols, cell = 8, 130
    sheet = Image.new('L', (cols * cell, ((len(rows) + cols - 1) // cols) * cell), 223)
    draw = ImageDraw.Draw(sheet)
    for n, key in enumerate(masks):
        img = Image.fromarray(np.where(masks[key], 30, 223).astype(np.uint8))
        img.thumbnail((cell - 22, cell - 22))
        x, y = (n % cols) * cell, (n // cols) * cell
        sheet.paste(img, (x + (cell - img.width) // 2, y + (cell - img.height) // 2))
        draw.text((x + 4, y + 4), str(n), fill=90)
    sheet.save(os.path.join(OUT, 'harvest-sheet.png'))
    print('wrote harvested/ — run buildlog.py next')


if __name__ == '__main__':
    main()
