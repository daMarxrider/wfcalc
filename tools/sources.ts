/**
 * Where the data comes from.
 *
 * `fetch.ts` downloads these and `sync.ts` watches them for changes, so the two lists cannot
 * drift: a source added here is automatically part of the weekly change check. They used to be
 * duplicated, and the weapon modules (which carry the Incarnon forms) ended up downloaded but
 * unwatched.
 */

/** WFCD game-export datasets. `fetch.ts` saves them as `wfcd-<item>.json`. */
export const WFCD_ITEMS = [
  'Primary',
  'Secondary',
  'Melee',
  'Arch-Gun',
  'Arch-Melee',
  'Archwing',
  'Warframes',
  'Arcanes',
  'Enemy',
  'Mods',
  'SentinelWeapons',
  'Sentinels',
  'Pets',
];

/** Wiki pages worth keeping verbatim: they document the formulas we implement. */
export const WIKI_PAGE_SOURCES: Array<[page: string, file: string]> = [
  ['Module:Mods/data', 'module-mods.lua'],
  ['Module:DamageTypes/data', 'module-damagetypes.lua'],
  ['Module:Warframes/data', 'module-warframes.lua'],
  ['Damage/Calculation', 'wiki-damage-calculation.wiki'],
  ['Damage_Type_Modifier', 'wiki-damage-type-modifier.wiki'],
  ['Enemy_Level_Scaling', 'wiki-enemy-level-scaling.wiki'],
  ['Riven_Mods', 'wiki-riven-mods.wiki'],
  // Enemy factions WFCD does not export (Scaldra, Techrot, The Murmur, Anarchs), and Corpus for
  // the Treasurer: build-data takes only enemies WFCD lacks from these.
  ['Module:Enemies/data/scaldra', 'module-enemies-scaldra.lua'],
  ['Module:Enemies/data/techrot', 'module-enemies-techrot.lua'],
  ['Module:Enemies/data/themurmur', 'module-enemies-themurmur.lua'],
  ['Module:Enemies/data/anarchs', 'module-enemies-anarchs.lua'],
  ['Module:Enemies/data/corpus', 'module-enemies-corpus.lua'],
  // The wiki's weapon database. Its primary/secondary/melee subpages carry the Incarnon form
  // as an attack of its own ("Incarnon Form", or the melee "Spectral Axe/Dagger/Blade"), which
  // WFCD does not export at all.
  ['Module:Weapons/data/primary', 'module-weapons-primary.lua'],
  ['Module:Weapons/data/secondary', 'module-weapons-secondary.lua'],
  ['Module:Weapons/data/melee', 'module-weapons-melee.lua'],
];

/** Wiki categories: the wiki is the only source that says which mods are Exilus-only. */
export const WIKI_CATEGORY_SOURCES: Array<[category: string, file: string]> = [
  ['Exilus Weapon Mods', 'wiki-exilus-mods.json'],
  // Bosses take at most 4 Cold stacks and never freeze (wiki: Damage/Cold Damage).
  ['Boss', 'wiki-bosses.json'],
  ['Boss Enemies', 'wiki-boss-enemies.json'],
];
