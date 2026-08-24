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
SAME = 0.76        # IoU above this = the same creature
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
                if iou(sig, c['sig']) >= SAME:
                    hit = c
                    break
            if hit is None:
                clusters.append({'sig': sig, 'best_area': blob['area'],
                                 'best_mask': blob['mask'], 'seen': 1,
                                 'frame': i})
            else:
                hit['seen'] += 1
                if blob['area'] > hit['best_area']:
                    # A bigger view of the same creature is a better trace,
                    # and its signature is the more trustworthy one.
                    hit['best_area'] = blob['area']
                    hit['best_mask'] = blob['mask']
                    hit['sig'] = sig
                    hit['frame'] = i
        if frames_done % 20 == 0:
            print(f'  frame {i}: {len(clusters)} distinct so far', flush=True)
    container.close()

    # A creature seen in only one sampled frame is usually a merge artefact
    # (two overlapping creatures) or a half-occluded edge case.
    keep = [c for c in clusters if c['seen'] >= 2]
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
