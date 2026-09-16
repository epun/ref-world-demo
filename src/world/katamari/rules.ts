/**
 * HOW THE LIBRARY IS CURATED — the rules, by themselves (user ask,
 * 2026-09-16: *"bring as many katamari objects in from the library as
 * possible, minus the main characters. I do like the animals in there."*).
 *
 * WHAT CHANGED. The first pass was 82 rows written out by hand, one at a
 * time, with an eyeballed height on each. That does not scale to 1,703
 * models and the user asked for all of them, so the table became DERIVED:
 * `scripts/katamari-curate.mjs --all` reads the library's `manifest.json`,
 * measures each glb's real bounds out of its own json chunk, and applies the
 * rules in THIS file to get a kind, a tier, a height and the region flags.
 * The rules live here rather than in the script because the runtime reads
 * some of them too (the height bands, the tier kinds) and because a rule with
 * a reason written next to it is the thing to review — not 1,600 generated
 * rows.
 *
 * WHAT IS EXCLUDED, and it is a short list: the game's own CHARACTERS. Every
 * cousin is `OUJI<n>` internally (the Prince is `OUJI01`; the King and the
 * Queen are not in the object set at all), so one internal-name prefix takes
 * the lot — far safer than matching the display names, where "Strawberry" is
 * `ICHIGO01` and a cousin is called Ichigo. Plus the manifest's own
 * `no_model` rows, anything the glTF validator flagged, and models too big to
 * be props at all (see `MAX_SOURCE_HEIGHT_M`).
 *
 * The ANIMALS STAY, because the user likes them, and so do the people-objects
 * (Fat Businessman and his colleagues), the food, the vehicles, the shops and
 * the islands. A katamari is made of everything.
 *
 * PURE AND IMPORT-FREE at runtime (`import type` only), so the curate script
 * can load it straight through node's type stripping.
 */

import type { Tier } from '../../creatures/sticky';
import type { PropKind } from '../props';

/**
 * The katamari's own tiers of junk — kinds this world had no motif for. They
 * ADD to `PropKind` on a katamari world rather than replacing anything; the
 * wiring seam is `docs/katamari-props.md` §a.
 */
export const KATAMARI_NEW_KINDS = ['small', 'medium', 'large'] as const;
export type KatamariNewKind = (typeof KATAMARI_NEW_KINDS)[number];

/**
 * The authored kinds a library model may stand in for. Declared as a local
 * `PropKind[]` rather than imported at runtime: typescript still checks every
 * name against `PropKind`, and this file stays free of three.js so the curate
 * script can read it.
 *
 * `cloud` is deliberately absent — it is scenery in the sky with no collider
 * and no katamari object reads as one. So is `mountain` (2026-09-16, off a
 * frame): the game's island masses are floating hexagonal slabs and a range
 * built of them read as platforms hovering over the meadow, so the mountain
 * stays the authored inflated lump and the prop source mixes.
 */
const REPLACED_KINDS: readonly PropKind[] = [
  'tree',
  'conifer',
  'bush',
  'rock',
  'stump',
  'cactus',
  'monolith',
  'building',
  'palm',
  'picnicTable',
  'waterTower',
];
export const KATAMARI_REPLACED_KINDS = REPLACED_KINDS;

/** Every kind a catalog row may name. */
export type KatamariKind = PropKind | KatamariNewKind;

export interface KatamariEntry {
  /** The game's hexadecimal object id, and this row's primary key. */
  id: string;
  /** The manifest's object name, verbatim. A key and a provenance trail,
   * never rendered — anything shown is `label`. */
  name: string;
  /** The manifest's internal (game) name — the second half of the trail, and
   * what the character exclusion matches on. */
  internalName: string;
  /** The manifest filename, which is also the published path under
   * `public/katamari/models/`. */
  file: string;
  /** The `PropKind` this model stands in for, or a katamari tier kind. */
  kind: KatamariKind;
  /** The `src/creatures/sticky.ts` tier. Must match `STICKY[kind]` for a
   * replacement kind. */
  tier: Tier;
  /** World height at instance scale 1 — the model's own measured height in
   * metres through `WORLD_SCALE`, clamped into its kind's band. */
  heightUnits: number;
  /** In the ground: knocked loose before it can be carried. Must match
   * `STICKY[kind].rooted` for a replacement kind. */
  rooted: boolean;
  /** Belongs on the sand. Inland is a row's default home, so this is the flag
   * that MOVES one to the beach. */
  beach?: boolean;
  /** Belongs inland as well; the default is `!beach`. A few things are
   * honestly both — a stone, a brick, a shell somebody carried up from the
   * tideline. */
  inland?: boolean;
  /** Lowercase display name (TASTE §5) — the only string here this world
   * would ever show. */
  label?: string;
}

// ── exclusions ───────────────────────────────────────────────────────────────

/**
 * Internal-name prefixes that are the game's CHARACTERS, not its objects.
 *
 * `OUJI` is the Prince and all twenty-odd cousins (`OUJI02_D` is Lalala,
 * `OUJI17B_D` is Ichigo's second pose). The other two never appear in this
 * archive and are listed anyway, so a future extraction that includes them
 * excludes them without a second thought.
 */
export const EXCLUDED_INTERNAL_PREFIXES: readonly string[] = ['OUJI', 'OUSAMA', 'OHIME'];

/**
 * …and a display-name net under it, for the same reason. Matched
 * case-insensitively as whole words so "Parking" never reads as a prince and
 * "Strawberry" never reads as the cousin called Ichigo.
 */
export const EXCLUDED_NAME_WORDS: readonly string[] = [
  'prince',
  'king of all cosmos',
  'queen of all cosmos',
  'katamari damacy',
];

/**
 * Too big to be a prop. **[D]**
 *
 * The library's tail is level geometry — whole countries, continents and the
 * Earth, hundreds of metres across. Normalised into a prop's height they
 * become flat slabs twenty units wide, which is scenery this world already
 * has (the island, the range) and draws its own way. 30 m keeps every
 * building, the town blocks and the small islands and drops the map pieces.
 */
export const MAX_SOURCE_HEIGHT_M = 30;

/** A model with no geometry at all is not a prop either. */
export const MIN_SOURCE_HEIGHT_M = 0.01;

// ── metres → world units ─────────────────────────────────────────────────────

/**
 * The one scale factor between the library's metres and this world's units.
 * **[D]**
 *
 * The extraction is in real metres (a brick is 0.2 m, a car 1.7 m), and the
 * world's own scale is set by the props it already had: the hand-curated
 * Japanese Car sat at 1.6 units and a person has to read as about that. 0.94
 * puts a 1.7 m adult at 1.6 units and leaves everything else in proportion to
 * it — ONE factor, so a mug and a factory keep their relative sizes instead
 * of each being eyeballed.
 */
export const WORLD_SCALE = 0.94;

/**
 * Height in units below / above which a model falls into each junk tier.
 * **[D]** — the brief's own numbers, in metres of the source: a thing you
 * could put in a pocket, a thing you could carry, a thing you could not.
 */
export const TIER_BANDS: readonly { tier: KatamariNewKind; maxHeightM: number }[] = [
  { tier: 'small', maxHeightM: 0.6 },
  { tier: 'medium', maxHeightM: 2.2 },
  { tier: 'large', maxHeightM: 6 },
];

/** Above the last band a model is a `building`: the kind, not just the tier. */
export const TIER_BUILDING_KIND: PropKind = 'building';

/**
 * The height band each kind's variants are held to, in world units.
 *
 * Two jobs. It CLAMPS a computed height into the range the kind's neighbours
 * live in — the library has a mushroom twenty metres tall and it must not
 * stand in for a tree at twenty units — and it is what
 * `test/world/katamari/catalog.test.ts` measures the generated table against,
 * so the bands have one home rather than two. Read off `PROP_VARIANT_DEFS`
 * for the replacement kinds and off the tiers for the junk.
 */
export const KIND_HEIGHT_BANDS: Readonly<Record<string, readonly [number, number]>> = {
  tree: [3, 8],
  conifer: [4, 8],
  bush: [0.6, 2],
  rock: [0.6, 2],
  stump: [0.6, 2],
  cactus: [1.5, 4],
  monolith: [3, 6],
  building: [2.4, 12],
  palm: [4, 8],
  picnicTable: [1, 3],
  waterTower: [5, 8],
  small: [0.1, 0.8],
  medium: [0.6, 3],
  large: [1, 7],
};

// ── name rules ───────────────────────────────────────────────────────────────

/**
 * Which REPLACEMENT kind a model's name puts it in, tried in order.
 *
 * Name-driven and not size-driven, because this is the one thing the size
 * cannot say: a "Cherry Tree" and a "Traffic Light" are both four metres
 * tall and only one of them is a tree. The patterns are deliberately narrow —
 * a miss costs a model a tier, a false positive costs the world a palm tree
 * made of vending machine.
 *
 * Order matters: `stump` before `tree`, `palm` before `tree`, and the shops
 * before the generic `building`.
 */
export const KIND_NAME_RULES: readonly { kind: PropKind; pattern: RegExp }[] = [
  { kind: 'stump', pattern: /\b(stump|log)\b/i },
  // "palm" alone, not "coconut" — the library has a Coconut Crab, and the
  // first pass made it a palm tree.
  { kind: 'palm', pattern: /\b(palm|coconut tree)\b/i },
  { kind: 'conifer', pattern: /\b(pine|fir|cedar|cypress|x'?mas tree|christmas tree)\b/i },
  { kind: 'tree', pattern: /\btrees?\b/i },
  { kind: 'bush', pattern: /\b(bush|shrub|hedge|plant|flower|sapling|seedling|grass)\b/i },
  { kind: 'rock', pattern: /\b(rock|stone|boulder|pebble)\b/i },
  { kind: 'cactus', pattern: /\b(cactus|daruma)\b/i },
  { kind: 'monolith', pattern: /\b(statue|monument|obelisk|jizo|pagoda|torii)\b/i },
  { kind: 'waterTower', pattern: /\b(water tower|tank|silo|chimney|weather station)\b/i },
  { kind: 'picnicTable', pattern: /\b(picnic|stall|bench table|table)\b/i },
  {
    kind: 'building',
    pattern:
      /\b(building|house|residence|home|store|shop|market|factory|school|hotel|hospital|temple|shrine|church|station|garage|apartment|mansion|castle|tower|warehouse|barn|shed|hut|shack|cabin|cottage|kiosk|inn|ryokan|dojo|gym|hall|bank|office|museum|library|theater|theatre|cinema|restaurant|cafe|bakery|clinic|dorm|villa)\b/i,
  },
];

/**
 * Names that belong on the SAND. Boats, shells, sea life, everything a
 * beach has on it — and the islands, which is where the game's own outcrops
 * ended up after they stopped being mountains.
 */
export const BEACH_NAME_PATTERN =
  /\b(boat|ship|yacht|sail|canoe|kayak|raft|buoy|shell|clam|conch|ammonite|fish|crab|shrimp|lobster|squid|octopus|starfish|urchin|seaweed|algae|coral|parasol|surf|sand|sea|beach|island|lifeguard|swim|snorkel|anchor|lighthouse|pier|dock|driftwood|palm|turtle|whale|dolphin|shark|penguin|seal|jellyfish)\b/i;

/** …and the ones that are honestly BOTH (see `KatamariEntry.inland`). */
export const BOTH_REGIONS_NAME_PATTERN = /\b(rock|stone|boulder|pebble|brick|shell|fish)\b/i;

/**
 * Kinds whose members are planted in the ground.
 *
 * Everything else is loose — which is the honest default for a library of
 * junk, and the one the pickup rules want: a bench, a can, a bicycle and a
 * cow are all things a pile can take without knocking them out of anything.
 * A prop's own kind can still overrule this per model through the catalog's
 * `rooted` (that is what `stickyFor` reads).
 */
export const ROOTED_KINDS: readonly string[] = [
  'tree',
  'conifer',
  'bush',
  'stump',
  'cactus',
  'monolith',
  'building',
  'palm',
  'picnicTable',
  'waterTower',
];

/**
 * Names that are planted even though their kind is not — a `large` lamp post
 * is in the pavement, a `medium` vending machine is bolted down. **[D]**
 *
 * Read for the `medium`, `large` and `building` kinds only: a `small` thing is
 * junk lying on the ground by definition, and the first pass had a telephone
 * BOOK planted in the pavement because "telephone" is in this list.
 */
export const ROOTED_NAME_PATTERN =
  /\b(post|pole|sign|signal|light|lamp|hydrant|mailbox|postbox|vending|gate|fence|wall|banner|curtain|tent|pylon|antenna|mast|flag|statue|monument|shrine|torii|well|bridge|tracks|rail|stairs|steps|escalator|elevator|billboard|booth|phone|telephone)\b/i;

// ── the active set ───────────────────────────────────────────────────────────

/**
 * HOW MANY VARIANTS OF EACH KIND THE WORLD ACTUALLY DRAWS. **[D]**
 *
 * The admitted set is over 1,500 models and the scatter draws one
 * `InstancedMesh` per (kind, variant): drawing all of them is 1,500-odd draw
 * calls before the ink pass doubles them, on a frame that already spends four
 * full-screen passes. So the catalog that ships is an ACTIVE SET — this many
 * per kind, chosen by a seeded shuffle of the admitted rows (`ACTIVE_SEED`),
 * which is a pure function of the manifest and the rules and is materialised
 * into `catalog.data.ts`, so every device draws the identical world.
 *
 * More variants is more VARIETY, not more objects: the scatter's per-kind
 * densities are unchanged, so the same number of things stand in the field —
 * they just repeat far less.
 */
/**
 * The share of a kind's active budget reserved for BEACH rows (`beach: true`)
 * before the seeded shuffle fills the rest [D]. At 120 small variants the
 * shuffle always carried a few shells; at 32 (2026-09-16, the phone's draw
 * calls) it carried none, and a beach with nothing on it is not a beach.
 */
export const BEACH_RESERVE = 0.25;

export const ACTIVE_BUDGET: Readonly<Record<string, number>> = {
  // 120 / 80 until 2026-09-16: a draw call is one (kind, variant) pair that
  // got a placement, so at 120 the world placed 96 small variants = 96 calls a
  // pass, on a phone that could not hold the frame. 32 / 24 places every one
  // of them (−89 calls a pass, −41%) and is still four times the variety the
  // authored world had. Two numbers to reverse.
  small: 32,
  medium: 24,
  large: 40,
  building: 24,
  // Every other replacement kind: a dozen is already three times what the
  // authored world had, and these are the kinds whose silhouette has to read
  // as one motif (a wood of twelve different trees is a wood; of forty, an
  // arboretum).
  tree: 12,
  conifer: 12,
  bush: 12,
  rock: 12,
  stump: 12,
  cactus: 12,
  monolith: 12,
  palm: 12,
  picnicTable: 12,
  waterTower: 12,
};

/** The shuffle's constant seed. Changing it re-picks the whole active set,
 * which is a visible change to the world and wants a commit of its own. */
export const ACTIVE_SEED = 20260916;

/** Budgets the ACTIVE set is held to (the published bytes and the triangles
 * a frame can afford). */
export const ACTIVE_MAX_TRIANGLES = 300_000;
export const ACTIVE_MAX_BYTES = 7 * 1024 * 1024;

/** Where the curate script writes, and where the loader reads. */
export const KATAMARI_BASE_URL = '/katamari';
export const KATAMARI_MODELS_DIR = 'models';
export const KATAMARI_CATALOG_FILE = 'catalog.json';

/**
 * The order the tiers LOAD in, and so the order the props appear in: the junk
 * first, the buildings last. Small models are small files, so the field fills
 * in with cans and cups within a second or two and the skyline arrives while
 * the room is already looking at something (docs/katamari-props.md §e).
 */
export const TIER_LOAD_ORDER: readonly Tier[] = ['small', 'medium', 'large', 'building'];

/** True for one of the three katamari tier kinds (not a `PropKind`). */
export function isKatamariNewKind(kind: KatamariKind): kind is KatamariNewKind {
  return (KATAMARI_NEW_KINDS as readonly string[]).includes(kind);
}

/** The band a kind's heights are clamped into, or null for a kind with no
 * band (nothing generated should land there). */
export function kindHeightBand(kind: string): readonly [number, number] | null {
  return KIND_HEIGHT_BANDS[kind] ?? null;
}
