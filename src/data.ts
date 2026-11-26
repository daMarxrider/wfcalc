/**
 * Snapshot loading and name lookup.
 *
 * The snapshot is a single JSON file built by `npm run update`. It is loaded once
 * and kept in memory; lookups are case-insensitive and tolerant of partial names
 * ("lex prime", "LEX P", "kuva bramma").
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { addModularWeapons } from './engine/modular.ts';
import { necrophagicVigor } from './engine/traits.ts';
import type { EnemyData, ModData, Snapshot, WarframeData, WeaponData } from './types.ts';

const DEFAULT_PATH = new URL('../data/snapshot.json', import.meta.url).pathname;

let cached: Snapshot | null = null;

export function loadSnapshot(path: string = DEFAULT_PATH): Snapshot {
  if (cached && path === DEFAULT_PATH) return cached;
  const snapshot = JSON.parse(readFileSync(path, 'utf8')) as Snapshot;
  addModularWeapons(snapshot);
  // The card text has no flat stat, so the parser finds none (engine/traits.ts). Search and the GPU
  // path read mod.effects: give them the max-rank bonus for a 300 Health frame; resolveBuild
  // swaps in the equipped rank and the real frame's health.
  const vigor = snapshot.mods['Necrophagic Vigor'];
  if (vigor) { vigor.effects = necrophagicVigor(vigor.maxRank, 300); vigor.partial = false; }
  if (path === DEFAULT_PATH) cached = snapshot;
  return snapshot;
}

/** Normalises a name for matching: lowercase, no punctuation, single spaces. */
export function normalizeName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[''`]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

interface LookupOptions {
  /** Show "did you mean" candidates. */
  limit?: number;
}

/** The exact or normalised name only, no partial match: for builds, where a typo must not pick another item. */
export function byExactName<T extends { name: string }>(items: Record<string, T>, name: string): T | undefined {
  if (items[name]) return items[name];
  const wanted = normalizeName(name);
  return wanted ? Object.values(items).find((item) => normalizeName(item.name) === wanted) : undefined;
}

/** Generic fuzzy lookup over a name-keyed record. */
export function findByName<T extends { name: string }>(
  items: Record<string, T>,
  query: string,
  options: LookupOptions = {},
): { item: T | null; suggestions: string[] } {
  const wanted = normalizeName(query);
  if (!wanted) return { item: null, suggestions: [] }; // empty query matches nothing
  const exact = byExactName(items, query);
  if (exact) return { item: exact, suggestions: [] };
  // Prefix / substring matches, shortest name first (so "lex" finds "Lex" before "Lex Prime").
  const partial = Object.values(items)
    .filter((item) => normalizeName(item.name).includes(wanted))
    .sort((a, b) => a.name.length - b.name.length);
  if (partial.length && normalizeName(partial[0].name).startsWith(wanted)) {
    return { item: partial[0], suggestions: partial.slice(0, options.limit ?? 5).map((i) => i.name) };
  }
  return { item: null, suggestions: partial.slice(0, options.limit ?? 5).map((i) => i.name) };
}

// Modular weapons are not enumerable (engine/modular.ts): only their exact "A / B / C" name finds them.
export const findWeapon = (snap: Snapshot, query: string) => {
  const modular = query.includes('/') ? snap.weapons[query.split('/').map((part) => part.trim()).join(' / ')] : undefined;
  return modular ? { item: modular, suggestions: [] } : findByName(snap.weapons, query);
};
export const findMod = (snap: Snapshot, query: string) => findByName(snap.mods, query);
export const findEnemy = (snap: Snapshot, query: string) => findByName(snap.enemies, query);
export const findWarframe = (snap: Snapshot, query: string) => findByName(snap.warframes, query);

// Variant words seen on augment-compatible weapons (wiki augment pages); Dual Skana is its own weapon, not a variant.
const VARIANT = /^(?:(?:kuva|tenet|coda|prisma|rakta|vaykor|sancti|synoid|secura|carmine|mara|dex) )?(.+?)(?: (?:prime|vandal|wraith))?$/;
/**
 * Mod classes a weapon takes beyond its own `modClasses`. Weapon augments carry the weapon's name as
 * their class; variants take them too (Ballistica -> Rakta Ballistica, Ballistica Prime). "Assault
 * Rifle" mods (Tainted Mag, Spring-Loaded Chamber) fit every plain rifle, not bows or snipers (wiki).
 * shortcut: launchers are left out, the wiki is unclear on them; add them if a mod page says they fit.
 */
export function augmentFits(weapon: WeaponData, modClass: string): boolean {
  const name = weapon.name.toLowerCase();
  const key = modClass.toLowerCase();
  if (key === 'assault rifle') return weapon.category === 'primary' && weapon.type === 'Rifle';
  // Glaive mods (Power Throw, Whirlwind, Rebound) fit every weapon the data gives a throw.
  if (key === 'thrown melee' || key === 'thrown') return weapon.modes.some((mode) => mode.trigger === 'Thrown');
  return name === key || name.match(VARIANT)?.[1] === key;
}

/** Mods that fit a weapon, cheapest filter to build pickers from. */
export function modsForWeapon(snap: Snapshot, weapon: WeaponData): ModData[] {
  const classes = new Set(weapon.modClasses.map((c) => c.toLowerCase()));
  // No wildcard for the bare "Mod" and "Antique" classes: those are fusion cores, transmute
  // cores and Operator focus arcanes, none of which can be equipped on a weapon. Letting them
  // through put 28 unmodellable entries in a rifle's candidate list.
  const wildcards = new Set<string>();
  const categoryWildcards: Record<string, string[]> = {
    primary: ['primary'],
    secondary: ['secondary'],
    melee: ['melee'],
    archgun: ['archgun'],
    archmelee: ['archmelee'],
    sentinel: ['companion', 'companion weapon', 'sentinel', 'robotic'],
  };
  const extra = (categoryWildcards[weapon.category] ?? []).map((c) => c.toLowerCase());

  return Object.values(snap.mods).filter((mod) =>
    // Flawed mods are obsolete beginner variants and only clutter the picker.
    !/^Flawed /.test(mod.name) &&
    mod.classes.some((c) => {
      const key = c.toLowerCase();
      return classes.has(key) || wildcards.has(key) || extra.includes(key) || augmentFits(weapon, c);
    }),
  );
}

export type { EnemyData, ModData, Snapshot, WarframeData, WeaponData };
export { join as _join };
