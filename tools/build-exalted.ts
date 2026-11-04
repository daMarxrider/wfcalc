/**
 * Exalted weapons (Exalted Blade, Artemis Bow, Regulators...) from the wiki's weapon database.
 *
 * WFCD leaves them out and DE's Public Export lists them at rank-0 ability values (Exalted Blade
 * 35 damage instead of 250), so the wiki modules are the source: their `Class = "Exalted Weapon"`
 * entries carry the max-rank stats at 100% Ability Strength. Strength scaling and augments are
 * applied by the engine (src/engine/exalted.ts).
 *
 *   node tools/build-exalted.ts            read data/raw/module-weapons-*.lua, write into data/snapshot.json
 *   node tools/build-exalted.ts --check    report only
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseLuaModule } from './parse-lua.ts';
import { DAMAGE_TYPES, type DamageType, type Snapshot, type WeaponData, type WeaponMode, type WeaponStats } from '../src/types.ts';

const ROOT = new URL('..', import.meta.url).pathname;
const SNAPSHOT = join(ROOT, 'data/snapshot.json');
const FILES: Array<[file: string, category: string]> = [
  ['module-weapons-primary.lua', 'primary'],
  ['module-weapons-secondary.lua', 'secondary'],
  ['module-weapons-melee.lua', 'melee'],
];
const check = process.argv.includes('--check');

type Loose = Record<string, any>;
const list = (value: unknown): any[] => (Array.isArray(value) ? value : value && typeof value === 'object' ? Object.values(value) : []);

/** Blade Storm deals Finisher damage, which ignores armour and shields like True damage. */
const DAMAGE_ALIAS: Record<string, DamageType> = { finisher: 'true' };

function statsOf(attack: Loose, entry: Loose): WeaponStats {
  const stats = {} as WeaponStats;
  for (const type of DAMAGE_TYPES) stats[type] = 0;
  for (const [key, value] of Object.entries<number>(attack.Damage ?? {})) {
    const type = DAMAGE_ALIAS[key.toLowerCase()] ?? (key.toLowerCase() as DamageType);
    if (typeof value === 'number' && type in stats) stats[type] += value;
  }
  stats.critChance = Number(attack.CritChance ?? 0);
  stats.critMultiplier = Number(attack.CritMultiplier ?? 1);
  stats.statusChance = Number(attack.StatusChance ?? 0);
  // A charged shot fires once per charge time.
  stats.fireRate = Number(attack.ChargeTime) > 0 ? 1 / Number(attack.ChargeTime) : Number(attack.FireRate ?? 1);
  stats.multishot = Number(attack.Multishot ?? 1);
  stats.magazineSize = Number(entry.Magazine ?? 0);
  stats.reloadTime = Number(entry.Reload ?? 0);
  return stats;
}

function typeOf(category: string, entry: Loose): { type: string; modClasses: string[] } {
  if (category === 'melee') return { type: 'Melee', modClasses: ['Melee'] };
  if (category === 'secondary') return { type: 'Pistol', modClasses: ['Pistol'] };
  if (entry.GripType === 'BOW') return { type: 'Bow', modClasses: ['Rifle', 'Bow'] };
  // Neutralizer is a sniper rifle (wiki: "uses Rifle Mods and can equip Sniper Mods").
  if (entry.Zoom) return { type: 'Sniper', modClasses: ['Rifle', 'Sniper'] };
  return { type: 'Rifle', modClasses: ['Rifle'] };
}

export function exaltedFromModules(modules: Array<[module: Loose, category: string]>): Record<string, WeaponData> {
  const out: Record<string, WeaponData> = {};
  for (const [module, category] of modules) {
    for (const entry of list(module.Weapons ?? module)) {
      if (entry?.Class !== 'Exalted Weapon' || !entry.Name) continue;
      const attacks = list(entry.Attacks);
      if (!attacks.length) continue;
      const name = String(entry.Name);
      // The wiki repeats a name now and then (Artemis Bow's two headshot explosions); modes need unique names.
      const seen = new Map<string, number>();
      const modes: WeaponMode[] = attacks.map((attack) => ({
        name: ((base) => { const n = (seen.get(base) ?? 0) + 1; seen.set(base, n); return n > 1 ? `${base} ${n}` : base; })(String(attack.AttackName ?? 'Attack')),
        stats: statsOf(attack, entry),
        trigger: typeof attack.ShotType === 'string' ? attack.ShotType : null,
        ...(attack.Falloff?.EndRange > 0
          ? { falloff: { start: Number(attack.Falloff.StartRange ?? 0), end: Number(attack.Falloff.EndRange), reduction: Number(attack.Falloff.Reduction ?? 0) } }
          : {}),
      }));
      const tags = list(entry.CompatibilityTags).map(String);
      out[name] = {
        id: name,
        name,
        category,
        ...typeOf(category, entry),
        masteryRank: 0,
        disposition: 0,
        dispositionMultiplier: 1,
        polarities: list(entry.Polarities).map((p) => String(p).toLowerCase()),
        exilusPolarity: null,
        trigger: String(entry.Trigger ?? ''),
        image: typeof entry.Image === 'string' ? entry.Image : null,
        stancePolarity: typeof entry.StancePolarity === 'string' ? entry.StancePolarity.toLowerCase() : null,
        description: '',
        stats: modes[0].stats,
        modes,
        hasRivenSlot: false,
        exalted: {
          frames: list(entry.Users).map(String),
          family: String(entry.Family ?? name),
          ...(tags.includes('NO_ATTACK_SPEED') ? { fixedRate: true } : {}),
        },
      };
    }
  }
  return out;
}

function main(): void {
  const modules = FILES.map(([file, category]) => [parseLuaModule(readFileSync(join(ROOT, 'data/raw', file), 'utf8')) as Loose, category] as [Loose, string]);
  const exalted = exaltedFromModules(modules);
  const names = Object.keys(exalted);
  if (names.length < 30) throw new Error(`exalted weapons: only ${names.length} found (wiki module layout changed?)`);
  console.log(`exalted weapons: ${names.length}`);
  if (check) return;
  const snapshot = JSON.parse(readFileSync(SNAPSHOT, 'utf8')) as Snapshot;
  for (const name of names) {
    if (snapshot.weapons[name] && !snapshot.weapons[name].exalted) throw new Error(`${name} is already a regular weapon in the snapshot`);
    snapshot.weapons[name] = exalted[name];
  }
  writeFileSync(SNAPSHOT, JSON.stringify(snapshot));
  console.log('snapshot updated');
}

if (import.meta.main) main();
