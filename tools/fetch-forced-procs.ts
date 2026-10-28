/**
 * Guaranteed (forced) status procs per weapon attack, from the wiki's weapon database
 * (Module:Weapons/data, `ForcedProcs` on each attack: Daikyu's Impact, Epitaph's Cold...).
 *
 * Only damage statuses are kept; Lifted, Knockdown, Ragdoll and Stagger move enemies without
 * any damage effect. The default profile (no fire mode picked) is the first attack plus the
 * attacks that hang off it (its explosion: `AttackParentIndex`).
 *
 *   node tools/fetch-forced-procs.ts            read data/raw/module-weapons-*.lua, write into data/snapshot.json
 *   node tools/fetch-forced-procs.ts --check    report only
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseLuaModule } from './parse-lua.ts';
import { DAMAGE_TYPES, type DamageType, type Snapshot } from '../src/types.ts';

const ROOT = new URL('..', import.meta.url).pathname;
const SNAPSHOT = join(ROOT, 'data/snapshot.json');
const FILES = ['module-weapons-primary.lua', 'module-weapons-secondary.lua', 'module-weapons-melee.lua'];
const check = process.argv.includes('--check');

type Loose = Record<string, any>;
const list = (value: unknown): any[] => (Array.isArray(value) ? value : value && typeof value === 'object' ? Object.values(value) : []);
const damageType = (proc: string): DamageType | null => {
  const key = proc.trim().toLowerCase() as DamageType;
  return (DAMAGE_TYPES as readonly string[]).includes(key) ? key : null;
};

/** weapon -> attack name -> forced damage procs; `''` is the default profile. */
export function forcedProcsFromModules(modules: Loose[]): Record<string, Record<string, DamageType[]>> {
  const out: Record<string, Record<string, DamageType[]>> = {};
  for (const module of modules) {
    for (const weapon of list(module)) {
      if (!weapon?.Name) continue;
      const attacks = list(weapon.Attacks);
      const byAttack: Record<string, DamageType[]> = {};
      const procsOf = (attack: Loose): DamageType[] => list(attack.ForcedProcs).map(String).map(damageType).filter((type): type is DamageType => type !== null);
      attacks.forEach((attack) => {
        const procs = procsOf(attack);
        if (procs.length && attack.AttackName) byAttack[String(attack.AttackName)] = procs;
      });
      // Default: attack 1 and the attacks whose parent it is (its AoE).
      const first = attacks[0];
      if (first) {
        const index = Number(first.AttackIndex ?? 1);
        const family = attacks.filter((attack, i) => i === 0 || Number(attack.AttackParentIndex) === index);
        const procs = family.flatMap(procsOf);
        if (procs.length) byAttack[''] = procs;
      }
      if (Object.keys(byAttack).length) out[String(weapon.Name)] = byAttack;
    }
  }
  return out;
}

const modules = FILES.map((file) => parseLuaModule(readFileSync(join(ROOT, 'data/raw', file), 'utf8')) as Loose);
const table = forcedProcsFromModules(modules);
const snapshot = JSON.parse(readFileSync(SNAPSHOT, 'utf8')) as Snapshot;
const unknown = Object.keys(table).filter((name) => !snapshot.weapons[name]);
for (const name of unknown) delete table[name];
const withDefault = Object.values(table).filter((entry) => entry['']).length;
console.log(`${Object.keys(table).length} weapons with forced damage procs (${withDefault} on the default profile); ${unknown.length} not in the snapshot`);
if (!check) {
  snapshot.forcedProcs = table;
  writeFileSync(SNAPSHOT, JSON.stringify(snapshot));
  console.log('written to data/snapshot.json');
}
