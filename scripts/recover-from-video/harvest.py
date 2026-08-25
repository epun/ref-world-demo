"""
Harvest every distinct creature from the recording.

A creature appears in many frames, at many sizes, mid-walk. We want ONE
trace per creature, and we want the best one — the largest, least occluded
instance, since that is the most faithful silhouette.

So: segment every sampled frame, normalise each silhouette to a fixed grid,
cluster by overlap, and keep the biggest member of each cluster. Clustering
on the normalised mask (not on position) is what makes this robust to the
camera moving and the creatures wandering.
"""
import os, sys, json, math
import numpy as np
from PIL import Image
import av

sys.setrecursionlimit(100_000)
import segment

# The recording to salvage. Pass a path as the second argument to override.
SRC = sys.argv[2] if len(sys.argv) > 2 else os.environ.get('REFWORLD_RECORDING', '')
OUT = os.path.dirname(os.path.abspath(__file__))

GRID = 28          # signature resolution
SAME = 0.82        # IoU above this = the same creature
MIN_AREA = 700     # below this is the mouse cursor and grass


def signature(mask):
    """Normalised occupancy grid — scale- and position-invariant."""
    img = Image.fromarray((mask * 255).astype(np.uint8))
    img = img.resize((GRID, GRID), Image.BILINEAR)
    return np.asarray(img, dtype=np.float32) / 255.0 > 0.45


def iou(a, b):
    inter = np.logical_and(a, b).sum()
    union = np.logical_or(a, b).sum()
    return float(inter) / float(union) if union else 0.0


def match(a, b):
    """IoU, mirror-aware.

    A creature turns around. Facing left and facing right give MIRRORED
    silhouettes that never match each other, so one creature came back as
    several — the single biggest source of duplicates in the first pass.
    Comparing against the flip as well collapses them.
    """
    return max(iou(a, b), iou(a, b[:, ::-1]))


def main():
    if not SRC or not os.path.exists(SRC):
        sys.exit('usage: python3 harvest.py [frame-step] <recording.mp4>')
    step = int(sys.argv[1]) if len(sys.argv) > 1 else 12
    container = av.open(SRC)
    stream = container.streams.video[0]
    clusters = []          # {'sig','best_area','best_mask','seen'}
    frames_done = 0
    for i, frame in enumerate(container.decode(stream)):
        if i % step:
            continue
        img = frame.to_image()
        frames_done += 1
        for blob in segment.blobs_from_frame(img, min_area=MIN_AREA):
            sig = signature(blob['mask'])
            if sig.sum() < 12:
                continue
            hit = None
            for c in clusters:
                if match(sig, c['sig']) >= SAME:
                    hit = c
                    break
            x0, y0, bw, bh = blob['bbox']
            crop = img.crop((x0 - 6, y0 - 6, x0 + bw + 6, y0 + bh + 6))
            if hit is None:
                clusters.append({'sig': sig, 'best_area': blob['area'],
                                 'best_mask': blob['mask'], 'seen': 1,
                                 'frame': i, 'crop': crop,
                                 'instances': [(sig, blob['area'], blob['mask'], crop, i)]})
            else:
                hit['seen'] += 1
                if len(hit['instances']) < 40:
                    hit['instances'].append((sig, blob['area'], blob['mask'], crop, i))
                if blob['area'] > hit['best_area']:
                    # A bigger view of the same creature is a better trace,
                    # and its signature is the more trustworthy one.
                    hit['best_area'] = blob['area']
                    hit['best_mask'] = blob['mask']
                    hit['sig'] = sig
                    hit['frame'] = i
                    hit['crop'] = crop
        if frames_done % 20 == 0:
            print(f'  frame {i}: {len(clusters)} distinct so far', flush=True)
    container.close()

    # A creature seen in only one sampled frame is usually a merge artefact
    # (two overlapping creatures) or a half-occluded edge case.
    # Three sightings, not two. A cluster seen twice is as likely to be the
    # mouse cursor sitting on a creature, or a half-occluded pass behind a
    # tree, as it is a real animal — and with only two instances the medoid
    # below has nothing to vote against.
    keep = [c for c in clusters if c['seen'] >= 3]

    # THE MEDOID, not the biggest. "Largest instance" sounds like the best
    # view and is not: the largest is often the one the mouse cursor is
    # sitting on, or the one merged with a prop, because those add pixels.
    # The instance that agrees most with all the others is the typical one,
    # and an outlier cannot win by being big.
    for c in keep:
        inst = c['instances']
        if len(inst) > 2:
            best, score = None, -1.0
            for cand in inst:
                s_ = sum(match(cand[0], o[0]) for o in inst if o is not cand) / (len(inst) - 1)
                # Break ties toward the larger view — same shape, more detail.
                s_ += cand[1] * 1e-9
                if s_ > score:
                    best, score = cand, s_
            c['sig'], c['best_area'], c['best_mask'], c['crop'], c['frame'] = best
    for c in keep:
        del c['instances']

    # A second, agglomerative pass: greedy one-pass clustering assigns to the
    # FIRST match, so two clusters can end up as neighbours that would have
    # merged had they met. Now that each has a settled representative, merge
    # what matches.
    # STRICTER than the first pass, not looser. Loosening it collapsed a
    # third of the population into one cluster with 985 sightings: a small
    # silhouette resampled to 28x28 is coarse enough that any two blobby
    # shapes overlap well, so a low threshold merges creatures that are not
    # remotely alike. Aspect ratio is the extra guard — a tall thin creature
    # and a wide squat one are never the same animal, whatever the overlap.
    def aspect(sig):
        ys, xs = np.nonzero(sig)
        if ys.size == 0:
            return 1.0
        return (ys.max() - ys.min() + 1) / float(xs.max() - xs.min() + 1)

    merged = []
    for c in sorted(keep, key=lambda c: -c['seen']):
        ac = aspect(c['sig'])
        for m in merged:
            am = aspect(m['sig'])
            if match(c['sig'], m['sig']) >= SAME + 0.03 and 0.78 <= ac / am <= 1.28:
                m['seen'] += c['seen']
                break
        else:
            merged.append(c)
    print(f'{len(keep)} after medoid, {len(merged)} after the second pass')
    keep = merged
    keep.sort(key=lambda c: -c['best_area'])
    print(f'\n{len(clusters)} clusters, {len(keep)} seen more than once')

    # Contact sheet of what we are about to rebuild.
    cols = 10
    cell = 110
    rows = (len(keep) + cols - 1) // cols
    sheet = Image.new('RGB', (cols * cell, rows * cell), 'white')
    for n, c in enumerate(keep):
        m = Image.fromarray((~c['best_mask'] * 255).astype(np.uint8)).convert('RGB')
        m.thumbnail((cell - 8, cell - 8))
        sheet.paste(m, ((n % cols) * cell + 4, (n // cols) * cell + 4))
    sheet.save(os.path.join(OUT, 'harvest-sheet.png'))

    # SOURCE vs TRACE, side by side, so the trace can be checked against the
    # footage it came from rather than taken on trust.
    cw, ch = 116, 128
    pair = Image.new('RGB', (cols * cw * 2, rows * ch), 'white')
    from PIL import ImageDraw
    dr = ImageDraw.Draw(pair)
    for n, c in enumerate(keep):
        cx = (n % cols) * cw * 2
        cy = (n // cols) * ch
        src = c['crop'].convert('RGB').copy()
        src.thumbnail((cw - 8, ch - 20))
        pair.paste(src, (cx + 4, cy + 16))
        m = Image.fromarray((~c['best_mask'] * 255).astype(np.uint8)).convert('RGB')
        m.thumbnail((cw - 8, ch - 20))
        pair.paste(m, (cx + cw + 4, cy + 16))
        dr.text((cx + 4, cy + 3), f"#{n}  seen {c['seen']}  f{c['frame']}", fill=(180, 40, 40))
        dr.line([cx, cy, cx, cy + ch], fill=(210, 210, 210))
    pair.save(os.path.join(OUT, 'compare-source-vs-trace.png'))
    os.makedirs(os.path.join(OUT, 'crops'), exist_ok=True)
    for n, c in enumerate(keep):
        c['crop'].save(os.path.join(OUT, 'crops', f'{n:03d}.png'))

    strokes = []
    for n, c in enumerate(keep):
        s = segment.blob_to_stroke({'mask': c['best_mask']})
        if s:
            strokes.append({'index': n, 'area': c['best_area'],
                            'seen': c['seen'], 'frame': c['frame'], 'stroke': s})
    print(f'{len(strokes)} traced')
    with open(os.path.join(OUT, 'harvest.json'), 'w') as f:
        json.dump(strokes, f)


if __name__ == '__main__':
    main()
