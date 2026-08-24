"""
Pull creature silhouettes out of a frame of the projection recording.

The taste is what makes this tractable: near-black belongs to characters
only, and the environment never goes below ~#353534. So a luma threshold
separates creatures from ground, rocks, trees and props with no cleverness
at all.

What has to be excluded is the browser and the world's own ui: the url bar
across the top, the qr code bottom-left, the minimap bottom-right, and the
mouse cursor. Those are rectangles, and the grass tufts are dark but tiny,
so an area floor removes them.
"""
import sys, os, json, math
import numpy as np
from PIL import Image

# Anything at or below this luma is a creature. Environment floor is ~0.21
# (#353534); the ground is ~0.87. 0.35 sits well clear of both.
INK_MAX = 0.35
# A creature at the widest camera is ~28px tall. Grass tufts are ~10px of
# thin stroke, so area separates them cleanly.
MIN_AREA = 400
MAX_AREA = 200_000

def luma(img):
    a = np.asarray(img.convert('RGB'), dtype=np.float32) / 255.0
    return 0.2126 * a[:, :, 0] + 0.7152 * a[:, :, 1] + 0.0722 * a[:, :, 2]


def ui_mask(h, w):
    """True where the frame is chrome, not world."""
    m = np.zeros((h, w), dtype=bool)
    m[: int(h * 0.045), :] = True                       # browser url bar
    m[int(h * 0.80):, : int(w * 0.16)] = True           # qr join code
    m[int(h * 0.78):, int(w * 0.84):] = True            # minimap
    m[int(h * 0.97):, :] = True                         # window bottom edge
    return m


def components(mask):
    """Connected components, 8-connected, iterative flood fill."""
    h, w = mask.shape
    seen = np.zeros((h, w), dtype=np.int32)
    out = []
    nid = 0
    ys, xs = np.nonzero(mask)
    for y0, x0 in zip(ys, xs):
        if seen[y0, x0]:
            continue
        nid += 1
        stack = [(y0, x0)]
        seen[y0, x0] = nid
        pts = []
        while stack:
            y, x = stack.pop()
            pts.append((y, x))
            for dy in (-1, 0, 1):
                for dx in (-1, 0, 1):
                    ny, nx = y + dy, x + dx
                    if 0 <= ny < h and 0 <= nx < w and mask[ny, nx] and not seen[ny, nx]:
                        seen[ny, nx] = nid
                        stack.append((ny, nx))
        out.append(pts)
    return out


def trace_contour(sub):
    """Moore-neighbour boundary trace of a filled binary blob."""
    h, w = sub.shape
    start = None
    for y in range(h):
        xs = np.nonzero(sub[y])[0]
        if xs.size:
            start = (y, int(xs[0]))
            break
    if start is None:
        return []
    nbr = [(-1, 0), (-1, 1), (0, 1), (1, 1), (1, 0), (1, -1), (0, -1), (-1, -1)]
    contour = [start]
    cur = start
    b = 6  # came from the left
    guard = 0
    while True:
        guard += 1
        if guard > 200_000:
            break
        found = False
        for k in range(8):
            d = (b + 1 + k) % 8
            ny, nx = cur[0] + nbr[d][0], cur[1] + nbr[d][1]
            if 0 <= ny < h and 0 <= nx < w and sub[ny, nx]:
                b = (d + 4 + 1) % 8
                cur = (ny, nx)
                contour.append(cur)
                found = True
                break
        if not found:
            break
        if cur == start and len(contour) > 3:
            break
    return contour


def rdp(points, eps):
    """Ramer–Douglas–Peucker, so a 900-point boundary becomes ~40 points."""
    if len(points) < 3:
        return points
    a, b = points[0], points[-1]
    ax, ay = a
    bx, by = b
    dx, dy = bx - ax, by - ay
    n = math.hypot(dx, dy)
    worst, wi = -1.0, 0
    for i in range(1, len(points) - 1):
        px, py = points[i]
        d = abs(dy * px - dx * py + bx * ay - by * ax) / n if n > 0 else math.hypot(px - ax, py - ay)
        if d > worst:
            worst, wi = d, i
    if worst > eps:
        left = rdp(points[: wi + 1], eps)
        right = rdp(points[wi:], eps)
        return left[:-1] + right
    return [a, b]


def blobs_from_frame(img, min_area=MIN_AREA, reject_border=True):
    L = luma(img)
    h, w = L.shape
    ui = ui_mask(h, w)
    mask = (L <= INK_MAX) & ~ui
    # The world area, for the border test below.
    top = int(h * 0.045)
    bottom = int(h * 0.97)
    found = []
    for pts in components(mask):
        if not (min_area <= len(pts) <= MAX_AREA):
            continue
        ys = np.array([p[0] for p in pts])
        xs = np.array([p[1] for p in pts])
        y0, y1, x0, x1 = ys.min(), ys.max(), xs.min(), xs.max()
        bh, bw = y1 - y0 + 1, x1 - x0 + 1
        if bh < 18 or bw < 12:
            continue
        # A creature running off the edge of the frame traces as a shape with
        # a ruler-straight side — the frame's, not the drawing's. Those came
        # back as rectangles and half-discs, which is worse than missing the
        # creature: it would be REBUILT wrong. It will be caught in another
        # frame where it is fully in view.
        if reject_border and (
            x0 <= 2 or y0 <= top + 2 or x1 >= w - 3 or y1 >= bottom - 3
        ):
            continue
        # A creature is roughly upright and compact. A long thin run is a
        # rule, a shadow edge, or two creatures merged by an overlap.
        if bw / bh > 3.0 or bh / bw > 4.5:
            continue
        # A silhouette that fills its own bounding box is a rectangle, and
        # the only rectangles here are frame clips and ui the mask missed.
        # Real creatures are blobby: they fill 0.45–0.85 of their box.
        if len(pts) / float(bh * bw) > 0.92:
            continue
        sub = np.zeros((bh, bw), dtype=bool)
        sub[ys - y0, xs - x0] = True
        # Fill interior holes (the eye whites) — the silhouette is the shape.
        filled = fill_holes(sub)
        found.append({
            'bbox': (int(x0), int(y0), int(bw), int(bh)),
            'area': int(len(pts)),
            'mask': filled,
        })
    return found


def fill_holes(sub):
    h, w = sub.shape
    out = sub.copy()
    outside = np.zeros((h, w), dtype=bool)
    stack = []
    for x in range(w):
        for y in (0, h - 1):
            if not sub[y, x] and not outside[y, x]:
                outside[y, x] = True
                stack.append((y, x))
    for y in range(h):
        for x in (0, w - 1):
            if not sub[y, x] and not outside[y, x]:
                outside[y, x] = True
                stack.append((y, x))
    while stack:
        y, x = stack.pop()
        for dy, dx in ((-1, 0), (1, 0), (0, -1), (0, 1)):
            ny, nx = y + dy, x + dx
            if 0 <= ny < h and 0 <= nx < w and not sub[ny, nx] and not outside[ny, nx]:
                outside[ny, nx] = True
                stack.append((ny, nx))
    out[~sub & ~outside] = True
    return out


def blob_to_stroke(blob, eps=1.2):
    """Silhouette → one closed stroke in the kit's 0..1 wire shape."""
    sub = blob['mask']
    contour = trace_contour(sub)
    if len(contour) < 12:
        return None
    pts = [(float(x), float(y)) for (y, x) in contour]
    simp = rdp(pts, eps)
    if len(simp) < 8:
        return None
    bh, bw = sub.shape
    # Fit into the pad's 0..1 box with a margin, preserving aspect — the
    # rasterizer normalises anyway, but a centred shape reads better.
    side = max(bw, bh)
    ox = (side - bw) / 2.0
    oy = (side - bh) / 2.0
    wire = [[round((x + ox) / side * 0.86 + 0.07, 4),
             round((y + oy) / side * 0.86 + 0.07, 4)] for (x, y) in simp]
    if wire[0] != wire[-1]:
        wire.append(wire[0])
    return {'color': '#111111', 'width': 7, 'pts': wire}


if __name__ == '__main__':
    img = Image.open(sys.argv[1])
    bs = blobs_from_frame(img)
    print(f'{len(bs)} blobs')
    for b in sorted(bs, key=lambda b: -b['area'])[:60]:
        print(' ', b['bbox'], b['area'])
