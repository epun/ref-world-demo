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
    id: 'refworld.environment',
    name: 'environment',
    category: 'refworld',
    description:
      'environment variables in the right-hand panel — scatter density, grain amplitude, and the ink pass (edge threshold, line width, wobble, hatch strength).',
  },
  {
    id: 'refworld.weather',
    name: 'weather',
    category: 'refworld',
    description:
      'weather controls — clear/overcast/fog/rain/snow, time of day, intensity. no-ops gracefully when the world exposes no environment handle.',
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
      'verification gates from taste §7 — damping audit, achromatic check, value histogram, stillness note.',
  },
];
