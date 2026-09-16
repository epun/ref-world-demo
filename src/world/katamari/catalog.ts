/**
 * The katamari prop library, curated by hand (user ask, 2026-09-15: *"for the
 * buildings and the objects ... replace them with the objects from the
 * Katamari library"*).
 *
 * WHAT THIS FILE IS. One hand-written row per model taken out of the extracted
 * *Katamari Damacy* object set (1,703 `.glb`), naming the model by its game id
 * and its manifest filename, and saying three things the world needs and the
 * library cannot know:
 *
 *   - **`kind`** — which of this world's `PropKind`s the model stands in for.
 *     Most rows REPLACE an authored kind (`tree`, `building`, `rock`, …) so the
 *     scatter, the colliders, the minimap and `STICKY` all keep working
 *     unchanged: a katamari world swaps the VARIANTS of a kind, never the kind
 *     set. Three rows' worth of kinds are NEW — `small` / `medium` / `large` —
 *     and they are the katamari's own tiers of junk, the stuff a pile picks up
 *     that this world had no motif for.
 *   - **`heightUnits`** — world height at instance scale 1. Read off
 *     `PROP_VARIANT_DEFS` in `src/world/props.ts`, which is the scale the world
 *     actually uses: trees 4.4–6.4, conifers 5.2–6.4, buildings 2.4–7.2, rocks
 *     1.0–1.5, monoliths 4.0–4.5, mountains 12–17, palms 5.1–5.8, water towers
 *     6.0–6.5. **[D]** per row, by eye against the neighbours it will stand
 *     among — the glb's own metres are the PS2 game's scale and mean nothing
 *     here (a "Big Tree" and a "Brick" are both about a metre in the source).
 *   - **`tier`** — the `src/creatures/sticky.ts` tier. For a replacement row it
 *     is NOT a free choice: it must equal `STICKY[kind].tier`, and so must
 *     `rooted`, or the pickup rules and the row would disagree about the same
 *     prop. `test/world/katamari/catalog.test.ts` pins that.
 *
 * `beach: true` marks the rows that belong on the sand — parasols, boats,
 * shells, the boathouse, the palm, the two outcrops. The scatter's beach
 * region is where they go, and only they go there (docs/katamari-props.md
 * §a). A row that belongs in BOTH places carries `inland: true` beside it:
 * stones, a brick, a shell.
 *
 * NAMES ARE DATA. `name` is the manifest's own object name, verbatim, so a row
 * can be traced back to the library and to the game; it is a key, never
 * rendered. Anything this world would ever SHOW is `label`, and every label is
 * lowercase (TASTE §5).
 *
 * PROVENANCE. These models are a personal-use extraction from a retail copy of
 * *Katamari Damacy* (`SLUS-21008`). The assets remain Namco's; `valiocon` is a
 * private demo world and nothing here ships to the public deployment. See
 * `public/katamari/README.md` and `docs/katamari-props.md`.
 *
 * PURE AND TYPE-ONLY. Nothing at runtime is imported here — the two imports are
 * `import type`, so `scripts/katamari-curate.mjs` can load this file straight
 * through node's type stripping without dragging three.js into a build script.
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
 * `PropKind[]` rather than imported from `src/world/props.ts` at runtime:
 * typescript still checks every name against `PropKind`, and this file stays
 * free of three.js so the curate script can read it.
 *
 * `cloud` is deliberately absent — it is scenery in the sky with no collider
 * (`STICKY.cloud.stickiness` is 0) and no katamari object reads as one.
 */
/*
 * `mountain` LEFT THIS LIST (2026-09-16, read off a frame).
 *
 * The library's own island masses — Coral Island, Top Shell Island — are
 * floating hexagonal slabs, and a range built out of them read as stacked
 * platforms hovering over the meadow rather than as landscape. A mountain in
 * this world is the authored inflated lump and stays one: the katamari prop
 * source MIXES, keeping the stock variants for any kind this table does not
 * fill (`mountain`, and `cloud`, which no katamari object reads as). The two
 * islands moved down to the `large` tier as beached outcrops, which is the
 * size they actually read at.
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
   * never rendered — see the header. */
  name: string;
  /** The manifest filename, which is also the published path under
   * `public/katamari/models/`. */
  file: string;
  /** The `PropKind` this model stands in for, or a katamari tier kind. */
  kind: KatamariKind;
  /** The `src/creatures/sticky.ts` tier. Must match `STICKY[kind]` for a
   * replacement kind. */
  tier: Tier;
  /** World height at instance scale 1 (see the header). */
  heightUnits: number;
  /** In the ground: knocked loose before it can be carried. Must match
   * `STICKY[kind].rooted` for a replacement kind. */
  rooted: boolean;
  /** Belongs on the sand. Inland is the default home of a row, so this is
   * the flag that MOVES one to the beach — and `inland` below is what keeps
   * a row in both places (see it). */
  beach?: boolean;
  /**
   * Belongs inland as well.
   *
   * The default is `!beach`: a row is inland unless it is a beach row, and
   * the scatter's per-variant region filter admits exactly one set in each
   * region (src/world/scatter.ts). A few things are honestly both — a stone
   * is the commonest thing on a beach AND in a field, and so are a brick and
   * a shell somebody carried up from the tideline — so those rows carry
   * `beach: true` and `inland: true` together and are admitted in both.
   * **[D]**
   */
  inland?: boolean;
  /** Lowercase display name, for the new kinds — the only string here this
   * world would ever show (TASTE §5). */
  label?: string;
}

/**
 * The table.
 *
 * Chosen by name out of the manifest for a Japanese seaside town that reads as
 * anime: the tree and building families first (they are what the user asked to
 * replace), then the street furniture, the festival cloth, the fish-named
 * buildings of the game's harbour town, and the junk a pile actually rolls up.
 *
 * 82 models, ~11k triangles, ~1.4 MB copied — well inside the budget the
 * curate script prints.
 */
export const KATAMARI_CATALOG: readonly KatamariEntry[] = [
  // tree
  { id: '0114', name: "Regular Tree", file: "0114_Regular_Tree.glb", kind: 'tree', tier: 'medium', heightUnits: 5, rooted: true },
  { id: '0115', name: "Big Tree", file: "0115_Big_Tree.glb", kind: 'tree', tier: 'medium', heightUnits: 6, rooted: true },
  { id: '02fc', name: "Medium Tree", file: "02fc_Medium_Tree.glb", kind: 'tree', tier: 'medium', heightUnits: 5.2, rooted: true },
  { id: '0369', name: "Cherry Tree", file: "0369_Cherry_Tree.glb", kind: 'tree', tier: 'medium', heightUnits: 5.6, rooted: true },
  // conifer
  { id: '006d', name: "X'mas Tree", file: "006d_X_mas_Tree.glb", kind: 'conifer', tier: 'medium', heightUnits: 5.4, rooted: true },
  { id: '025b', name: "Gigantic Tree", file: "025b_Gigantic_Tree.glb", kind: 'conifer', tier: 'medium', heightUnits: 7, rooted: true },
  { id: '025a', name: "Huge Tree", file: "025a_Huge_Tree.glb", kind: 'conifer', tier: 'medium', heightUnits: 6.4, rooted: true },
  // bush
  { id: '0478', name: "Garden Plant", file: "0478_Garden_Plant.glb", kind: 'bush', tier: 'small', heightUnits: 1.4, rooted: true },
  { id: '00e9', name: "Garden Plant (M)", file: "00e9_Garden_Plant_M.glb", kind: 'bush', tier: 'small', heightUnits: 1.3, rooted: true },
  { id: '04cd', name: "Strawberry Plant", file: "04cd_Strawberry_Plant.glb", kind: 'bush', tier: 'small', heightUnits: 1, rooted: true },
  // rock
  // Three of the four stones stand on the sand as well as inland — shingle
  // is the commonest thing on a beach, and a beach with no stones on it was
  // the first thing the wired render got wrong. The big rock stays inland.
  { id: '03a9', name: "Rock", file: "03a9_Rock.glb", kind: 'rock', tier: 'small', heightUnits: 1.1, rooted: false, beach: true, inland: true },
  { id: '03aa', name: "Black Rock", file: "03aa_Black_Rock.glb", kind: 'rock', tier: 'small', heightUnits: 1, rooted: false, beach: true, inland: true },
  { id: '03ab', name: "Big Rock", file: "03ab_Big_Rock.glb", kind: 'rock', tier: 'small', heightUnits: 1.5, rooted: false },
  { id: '02f8', name: "Garden Rock", file: "02f8_Garden_Rock.glb", kind: 'rock', tier: 'small', heightUnits: 1.2, rooted: false, beach: true, inland: true },
  // stump
  { id: '02fb', name: "Tree Stump", file: "02fb_Tree_Stump.glb", kind: 'stump', tier: 'small', heightUnits: 1.2, rooted: true },
  // cactus — the library has no cactus; a daruma is the same silhouette slot,
  // a squat upright oddity standing alone in the open. [D]
  { id: '0507', name: "Giant Daruma", file: "0507_Giant_Daruma.glb", kind: 'cactus', tier: 'small', heightUnits: 2.6, rooted: true },
  // monolith — the standing-stone slot: one rock, one statue.
  { id: '03af', name: "The Oni Rock", file: "03af_The_Oni_Rock.glb", kind: 'monolith', tier: 'large', heightUnits: 4.2, rooted: true },
  { id: '03e9', name: "Fish Statue", file: "03e9_Fish_Statue.glb", kind: 'monolith', tier: 'large', heightUnits: 3.8, rooted: true },
  // building — the harbour town's fish-named blocks, plus the shops.
  { id: '026a', name: "Apartment Building", file: "026a_Apartment_Building.glb", kind: 'building', tier: 'building', heightUnits: 7.2, rooted: true },
  { id: '026c', name: "Marlin Building", file: "026c_Marlin_Building.glb", kind: 'building', tier: 'building', heightUnits: 5, rooted: true },
  { id: '026d', name: "Stingray Building", file: "026d_Stingray_Building.glb", kind: 'building', tier: 'building', heightUnits: 6, rooted: true },
  { id: '0271', name: "Coral Building", file: "0271_Coral_Building.glb", kind: 'building', tier: 'building', heightUnits: 5.4, rooted: true },
  { id: '0180', name: "Sunfish Building", file: "0180_Sunfish_Building.glb", kind: 'building', tier: 'building', heightUnits: 6.6, rooted: true },
  { id: '0439', name: "Car Wash ", file: "0439_Car_Wash.glb", kind: 'building', tier: 'building', heightUnits: 3.6, rooted: true },
  { id: '055b', name: "Factory", file: "055b_Factory.glb", kind: 'building', tier: 'building', heightUnits: 4.4, rooted: true },
  { id: '00d1', name: "Bookstore", file: "00d1_Bookstore.glb", kind: 'building', tier: 'building', heightUnits: 4, rooted: true },
  { id: '0268', name: "Ryokan", file: "0268_Ryokan.glb", kind: 'building', tier: 'building', heightUnits: 4.8, rooted: true },
  { id: '009a', name: "Boathouse", file: "009a_Boathouse.glb", kind: 'building', tier: 'building', heightUnits: 3.2, rooted: true, beach: true },
  // palm
  { id: '0105', name: "Palm Tree", file: "0105_Palm_Tree.glb", kind: 'palm', tier: 'medium', heightUnits: 5.6, rooted: true, beach: true },
  // picnicTable — the festival food stall reads as the same thing: a table
  // under a roof that a creature walks into.
  { id: '0125', name: "Street Stall", file: "0125_Street_Stall.glb", kind: 'picnicTable', tier: 'medium', heightUnits: 2, rooted: true },
  // waterTower — the tall tank slot.
  { id: '00ab', name: "Propane Tank", file: "00ab_Propane_Tank.glb", kind: 'waterTower', tier: 'large', heightUnits: 6, rooted: true },
  { id: '0085', name: "Weather Station", file: "0085_Weather_Station.glb", kind: 'waterTower', tier: 'large', heightUnits: 6.4, rooted: true },
  // small — the junk a pile starts on.
  { id: '034b', name: "Mug", file: "034b_Mug.glb", kind: 'small', tier: 'small', heightUnits: 0.4, rooted: false, label: 'mug' },
  { id: '0005', name: "Cassette Tape", file: "0005_Cassette_Tape.glb", kind: 'small', tier: 'small', heightUnits: 0.2, rooted: false, label: 'cassette tape' },
  { id: '0001', name: "Spatula", file: "0001_Spatula.glb", kind: 'small', tier: 'small', heightUnits: 0.3, rooted: false, label: 'spatula' },
  { id: '0006', name: "Peeler", file: "0006_Peeler.glb", kind: 'small', tier: 'small', heightUnits: 0.28, rooted: false, label: 'peeler' },
  { id: '0327', name: "Thumbtack", file: "0327_Thumbtack.glb", kind: 'small', tier: 'small', heightUnits: 0.15, rooted: false, label: 'thumbtack' },
  { id: '03c6', name: "Shortcake", file: "03c6_Shortcake.glb", kind: 'small', tier: 'small', heightUnits: 0.3, rooted: false, label: 'shortcake' },
  { id: '005c', name: "Hamburger", file: "005c_Hamburger.glb", kind: 'small', tier: 'small', heightUnits: 0.35, rooted: false, label: 'hamburger' },
  { id: '03ba', name: "Pizza", file: "03ba_Pizza.glb", kind: 'small', tier: 'small', heightUnits: 0.3, rooted: false, label: 'pizza' },
  { id: '03db', name: "Onigiri (Rice Ball)", file: "03db_Onigiri_Rice_Ball.glb", kind: 'small', tier: 'small', heightUnits: 0.3, rooted: false, label: 'onigiri' },
  { id: '0351', name: "Green Tea (Can)", file: "0351_Green_Tea_Can.glb", kind: 'small', tier: 'small', heightUnits: 0.35, rooted: false, label: 'green tea can' },
  { id: '0352', name: "Coffee (Can)", file: "0352_Coffee_Can.glb", kind: 'small', tier: 'small', heightUnits: 0.35, rooted: false, label: 'coffee can' },
  { id: '0030', name: "Milk Carton", file: "0030_Milk_Carton.glb", kind: 'small', tier: 'small', heightUnits: 0.4, rooted: false, label: 'milk carton' },
  { id: '0002', name: "Persimmon", file: "0002_Persimmon.glb", kind: 'small', tier: 'small', heightUnits: 0.25, rooted: false, label: 'persimmon' },
  { id: '0003', name: "Brick", file: "0003_Brick.glb", kind: 'small', tier: 'small', heightUnits: 0.3, rooted: false, beach: true, inland: true, label: 'brick' },
  { id: '04eb', name: "Ant", file: "04eb_Ant.glb", kind: 'small', tier: 'small', heightUnits: 0.2, rooted: false, label: 'ant' },
  { id: '03a7', name: "Ammonite", file: "03a7_Ammonite.glb", kind: 'small', tier: 'small', heightUnits: 0.4, rooted: false, beach: true, inland: true, label: 'ammonite' },
  { id: '0120', name: "Striped Fish", file: "0120_Striped_Fish.glb", kind: 'small', tier: 'small', heightUnits: 0.4, rooted: false, beach: true, inland: true, label: 'striped fish' },
  { id: '01dd', name: "Bonito", file: "01dd_Bonito.glb", kind: 'small', tier: 'small', heightUnits: 0.6, rooted: false, beach: true, inland: true, label: 'bonito' },
  // medium — street furniture, festival cloth, shop signs.
  { id: '0284', name: "Vending Machine ", file: "0284_Vending_Machine.glb", kind: 'medium', tier: 'medium', heightUnits: 2.2, rooted: true, label: 'vending machine' },
  { id: '0394', name: "Wooden Bench", file: "0394_Wooden_Bench.glb", kind: 'medium', tier: 'medium', heightUnits: 1, rooted: false, label: 'wooden bench' },
  { id: '0445', name: "Folding Chair", file: "0445_Folding_Chair.glb", kind: 'medium', tier: 'medium', heightUnits: 1.1, rooted: false, label: 'folding chair' },
  { id: '00ee', name: "Mailbox", file: "00ee_Mailbox.glb", kind: 'medium', tier: 'medium', heightUnits: 1.5, rooted: true, label: 'mailbox' },
  { id: '01ca', name: "Telephone", file: "01ca_Telephone.glb", kind: 'medium', tier: 'medium', heightUnits: 1.6, rooted: true, label: 'telephone' },
  { id: '00b5', name: "Trash Can", file: "00b5_Trash_Can.glb", kind: 'medium', tier: 'medium', heightUnits: 1, rooted: false, label: 'trash can' },
  { id: '00bc', name: "Bicycle", file: "00bc_Bicycle.glb", kind: 'medium', tier: 'medium', heightUnits: 1.3, rooted: false, label: 'bicycle' },
  { id: '0156', name: "Pizza Delivery Bike", file: "0156_Pizza_Delivery_Bike.glb", kind: 'medium', tier: 'medium', heightUnits: 1.5, rooted: false, label: 'delivery bike' },
  { id: '0150', name: "Paper Lantern", file: "0150_Paper_Lantern.glb", kind: 'medium', tier: 'medium', heightUnits: 1, rooted: false, label: 'paper lantern' },
  { id: '00d8', name: "Garden Lantern", file: "00d8_Garden_Lantern.glb", kind: 'medium', tier: 'medium', heightUnits: 1.8, rooted: true, label: 'garden lantern' },
  { id: '03c1', name: "Ramen Sign", file: "03c1_Ramen_Sign.glb", kind: 'medium', tier: 'medium', heightUnits: 2.2, rooted: true, label: 'ramen sign' },
  { id: '03a5', name: "Teahouse Banner", file: "03a5_Teahouse_Banner.glb", kind: 'medium', tier: 'medium', heightUnits: 2.2, rooted: true, label: 'teahouse banner' },
  { id: '053d', name: "Shop Curtain", file: "053d_Shop_Curtain.glb", kind: 'medium', tier: 'medium', heightUnits: 2, rooted: true, label: 'shop curtain' },
  { id: '00cf', name: "Matsuri Tent", file: "00cf_Matsuri_Tent.glb", kind: 'medium', tier: 'medium', heightUnits: 2.8, rooted: true, label: 'matsuri tent' },
  { id: '03a2', name: "Pedestrian Signal", file: "03a2_Pedestrian_Signal.glb", kind: 'medium', tier: 'medium', heightUnits: 2.8, rooted: true, label: 'pedestrian signal' },
  { id: '02ee', name: "Weathercock", file: "02ee_Weathercock.glb", kind: 'medium', tier: 'medium', heightUnits: 2, rooted: true, label: 'weathercock' },
  { id: '002f', name: "Compass", file: "002f_Compass.glb", kind: 'medium', tier: 'medium', heightUnits: 0.8, rooted: false, label: 'compass' },
  { id: '00c0', name: "Parasol", file: "00c0_Parasol.glb", kind: 'medium', tier: 'medium', heightUnits: 2.4, rooted: true, beach: true, label: 'parasol' },
  { id: '00aa', name: "Boat", file: "00aa_Boat.glb", kind: 'medium', tier: 'medium', heightUnits: 1.2, rooted: false, beach: true, label: 'boat' },
  { id: '0497', name: "Lifeguard's Chair", file: "0497_Lifeguard_s_Chair.glb", kind: 'medium', tier: 'medium', heightUnits: 2.6, rooted: true, beach: true, label: 'lifeguard chair' },
  // large — vehicles, poles, walls, boats.
  { id: '0091', name: "Japanese Car", file: "0091_Japanese_Car.glb", kind: 'large', tier: 'large', heightUnits: 1.6, rooted: false, label: 'japanese car' },
  { id: '02f2', name: "Froggy Car", file: "02f2_Froggy_Car.glb", kind: 'large', tier: 'large', heightUnits: 1.6, rooted: false, label: 'froggy car' },
  { id: '01ab', name: "Steamroller", file: "01ab_Steamroller.glb", kind: 'large', tier: 'large', heightUnits: 2.2, rooted: false, label: 'steamroller' },
  { id: '01e9', name: "Ox", file: "01e9_Ox.glb", kind: 'large', tier: 'large', heightUnits: 2, rooted: false, label: 'ox' },
  { id: '046a', name: "Park Entrance ", file: "046a_Park_Entrance.glb", kind: 'large', tier: 'large', heightUnits: 4, rooted: true, label: 'park entrance' },
  { id: '0279', name: "Lamp Post", file: "0279_Lamp_Post.glb", kind: 'large', tier: 'large', heightUnits: 4.4, rooted: true, label: 'lamp post' },
  { id: '00fd', name: "Telephone Pole", file: "00fd_Telephone_Pole.glb", kind: 'large', tier: 'large', heightUnits: 6, rooted: true, label: 'telephone pole' },
  { id: '00e5', name: "Wall (Long)", file: "00e5_Wall_Long.glb", kind: 'large', tier: 'large', heightUnits: 1.6, rooted: true, label: 'wall' },
  { id: '0288', name: "Small Fishing Boat", file: "0288_Small_Fishing_Boat.glb", kind: 'large', tier: 'large', heightUnits: 2.4, rooted: false, beach: true, label: 'fishing boat' },
  { id: '01b1', name: "Sailboat", file: "01b1_Sailboat.glb", kind: 'large', tier: 'large', heightUnits: 3, rooted: false, beach: true, label: 'sailboat' },
  // The two island masses, at the size they read at: an outcrop on the sand,
  // not a range. Heights chosen off their own aspect (1.6 and 1.8 wide per
  // unit of height) so the footprint lands under 6 u — 4.7 and 4.9. **[D]**
  { id: '056e', name: "Coral Island", file: "056e_Coral_Island.glb", kind: 'large', tier: 'large', heightUnits: 3, rooted: true, beach: true, label: 'coral outcrop' },
  { id: '039e', name: "Top Shell Island", file: "039e_Top_Shell_Island.glb", kind: 'large', tier: 'large', heightUnits: 2.8, rooted: true, beach: true, label: 'shell outcrop' },
];

/** Where the curate script writes, and where the loader reads. */
export const KATAMARI_BASE_URL = '/katamari';
export const KATAMARI_MODELS_DIR = 'models';
export const KATAMARI_CATALOG_FILE = 'catalog.json';

/** Rows for one kind, in table order (the scatter's variant order). */
export function katamariVariantsOf(kind: KatamariKind): KatamariEntry[] {
  return KATAMARI_CATALOG.filter((entry) => entry.kind === kind);
}

/** Every kind the table actually fills. */
export function katamariKinds(): KatamariKind[] {
  const out: KatamariKind[] = [];
  for (const entry of KATAMARI_CATALOG) if (!out.includes(entry.kind)) out.push(entry.kind);
  return out;
}

/** True for one of the three katamari tier kinds (not a `PropKind`). */
export function isKatamariNewKind(kind: KatamariKind): kind is KatamariNewKind {
  return (KATAMARI_NEW_KINDS as readonly string[]).includes(kind);
}
