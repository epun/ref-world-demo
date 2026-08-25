"""
Turn harvested silhouettes into a session log the world can restore.

The ids are new — the originals are gone with the handsets — so the world
names these itself from the id, deterministically. They are marked
`recovered` in the config so nobody later mistakes this for the original
log: these are rebuilds traced from a recording, not the drawings.
"""
import json, os

HERE = os.path.dirname(os.path.abspath(__file__))
HATCH_MS = 20000

rows = json.load(open(os.path.join(HERE, 'harvest.json')))

# Names the FOOTAGE shows, bound to a creature by provenance — the same blob
# in the same frame under the hover label, not a shape that looked similar.
# Only bindings that are exact go in. A guessed name would put a real
# person's word on somebody else's creature, which is worse than the honest
# generated one.
try:
    BOUND = json.load(open(os.path.join(HERE, 'bound-names.json')))
except Exception:
    BOUND = {}
BY_INDEX = {v: k for k, v in BOUND.items()}

# A rectangle simplifies to a handful of points; a creature does not. This
# catches the frame-clip artefacts that survived the earlier filters.
rows = [r for r in rows if len(r['stroke']['pts']) >= 14]
# Biggest first is also cleanest first, but spawn order drives the placement
# spiral, so shuffle deterministically by frame to avoid size-sorted rings.
rows.sort(key=lambda r: (r['frame'], r['index']))

events = []
for n, r in enumerate(rows):
    t = n * 40
    events.append({
        't': t, 'k': 'drawing',
        'id': f'rec-{n:03d}',
        # A name only when the recording proves it; otherwise the world
        # names it from the id (src/creatures/naming.ts).
        'name': BY_INDEX.get(r['index']),
        'personality': None,
        'source': 'phone',
        'strokes': [{
            'pts': [[p[0], p[1], 1] for p in r['stroke']['pts']],
            'w': 0.022,
        }],
        'hatchMs': HATCH_MS,
        'disposition': 'admitted', 'verdict': 'allow',
        'reason': None, 'confidence': 1,
    })
    events.append({'t': t + 1, 'k': 'hatch', 'id': f'rec-{n:03d}', 'cause': 'forced'})

log = {
    'schema': 'refworld.session',
    'version': 1,
    'epoch': 'recovered',
    'room': 'zkyz',
    'startedAt': '2026-08-24T00:00:00.000Z',
    'config': {
        'hatchMs': HATCH_MS,
        'maxPopulation': 64,
        'recovered': True,
        'recoveredFrom': 'screen recording — silhouettes traced, not original strokes',
    },
    'events': events,
}
out = os.path.join(HERE, 'recovered-from-video.json')
json.dump(log, open(out, 'w'))
print(f'{len(rows)} creatures -> {out}')
