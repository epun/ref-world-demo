/**
 * Skill descriptors for the ghost-panel dev surface (PLAN §10).
 *
 * Pure data, importable from node — the registration code in src/dev/index.ts
 * and the metadata test in test/dev/meta.test.ts both read from here, so the
 * catalog can be asserted (unique ids, lowercase names — TASTE §5) without a
 * DOM or the ghost-panel package.
 */

export interface DevSkillMeta {
  /** Unique skill id, namespaced `refworld.*`. */
  id: string;
  /** Human label shown in ghost-panel's suggestion ui. Lowercase (TASTE §5). */
  name: string;
  /** Grouping shared by every refworld skill. */
  category: string;
  /** One-line description, lowercase. */
  description: string;
}

export const DEV_SKILLS_META: readonly DevSkillMeta[] = [
  {
    id: 'refworld.demo',
    name: 'demo',
    category: 'refworld',
    description:
      'presentation controls (docs/generator.md) — spawn fallback creatures, hatch all, pause/resume ai, clear, reset world, wander speed, hatch timer pause.',
  },
  {
    id: 'refworld.moderation',
    name: 'moderation',
    category: 'refworld',
    description:
      'operator controls for what may become a creature — hold arrivals for approval, approve or discard the queue, remove a creature in one tap, block a drawer. the automatic screen (src/moderation/) sits under it.',
  },
  {
    id: 'refworld.session',
    name: 'session',
    category: 'refworld',
    description:
      'the recorded session log (docs/session.md) — event counts, download the session as json, and replay a saved log back into this world. the recorder itself ships in every build; only these buttons are dev-only.',
  },
  {
    id: 'refworld.environment',
    name: 'environment',
    category: 'refworld',
    description:
      'environment variables in the right-hand panel — scatter density, grain amplitude, and the ink pass (edge threshold, line width, wobble, hatch strength).',
  },
  {
    id: 'refworld.landscape',
    name: 'landscape',
    category: 'refworld',
    description:
      'the authored map behind a switch — the world opens as a flat plain and this reveals the forest, the range, the lake and its island, plus the three terrain dials (elevation, tier spacing, relief spread) for sculpting it live. carries the `scene` readout under it: what a public world is sharing and storing of that sculpting (docs/session.md §6).',
  },
  {
    id: 'refworld.paint',
    name: 'paint',
    category: 'refworld',
    description:
      'sculpt the terrain by hand (plan §7) — raise, lower, flatten and smooth over a painted height map, added to the authored land before it is terraced so a painted hill gets the same risers. envpaint\'s brush engine; dev only, and the demo build never paints.',
  },
  {
    id: 'refworld.weather',
    name: 'weather',
    category: 'refworld',
    description:
      'weather controls — clear/overcast/fog/rain/snow, time of day, intensity, wind override. no-ops gracefully when the world exposes no environment handle.',
  },
  {
    id: 'refworld.character',
    name: 'character',
    category: 'refworld',
    description: 'emote triggers for the most recently hatched character.',
  },
  {
    id: 'refworld.taste',
    name: 'taste',
    category: 'refworld',
    description:
      'verification gates from taste §7 — damping audit, achromatic check, value histogram, density probe, mark-set lint, grain check, stillness note.',
  },
];
