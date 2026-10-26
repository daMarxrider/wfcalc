/**
 * Weapon stats straight from DE's official Public Export.
 *
 * The snapshot's weapons come from WFCD/warframe-items, which is itself built from this export.
 * This tool goes to the source: it downloads the export index from origin.warframe.com
 * (LZMA-compressed), then ExportWeapons_en.json from content.warframe.com, and checks every
 * snapshot weapon's arsenal stat block against it.
 *
 *   node tools/public-export.ts           report differences and write them into the snapshot
 *   node tools/public-export.ts --check   report only, exit 1 when anything differs
 *
 * Only the fields the export defines for the primary attack are touched: the damage
 * distribution, crit chance and multiplier, status chance, fire rate, multishot, magazine,
 * reload and Mastery Rank. Two sources win over the export:
 *   - data/weapon-overrides.json, the verified corrections of known export quirks (Felarx's
 *     per-shell reload, Fulmin Prime's magazine);
 *   - the snapshot's riven disposition: the export's `omegaAttenuation` is 1.2 for every weapon,
 *     a placeholder rather than the live disposition.
 * Non-positive values (a charge weapon's `fireRate: 0`) are never applied.
 *
 * Stack caps come from the same export: ExportUpgrades (mods) and ExportRelicArcane (arcanes)
 * carry DE's own effect text ("Stacks up to 12x"). It is parsed with the snapshot's parser and
 * every conditional effect's `maxStacks` is checked against it: a missing cap is filled, a
 * different one is replaced, and a cap DE does not state is reported but kept. A weapon whose export damage total differs from
 * the snapshot by more than 1% is reported and left alone: that is almost always a different
 * attack (charged shot, alt-fire, a bow's full draw), not a balance change. Weapons the export
 * has but the snapshot lacks are listed; they cannot be added here because the export carries
 * no polarities or mod classes.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { decompressLzma } from './lib/lzma.ts';
import { parseModEffects } from '../src/mods/parse.ts';
import { DAMAGE_TYPES, type DamageType, type Snapshot, type WeaponData } from '../src/types.ts';

const ROOT = new URL('..', import.meta.url).pathname;
const SNAPSHOT = join(ROOT, 'data/snapshot.json');
const OVERRIDES = join(ROOT, 'data/weapon-overrides.json');
const RAW = join(ROOT, 'data/raw');
const INDEX_URL = 'https://origin.warframe.com/PublicExport/index_en.txt.lzma';
const MANIFEST_URL = 'http://content.warframe.com/PublicExport/Manifest';
const check = process.argv.includes('--check');

/** `damagePerShot` is a fixed-order array of 20 damage types; these are the ones the engine models. */
const EXPORT_DAMAGE_ORDER: Array<DamageType | null> = [
  'impact', 'puncture', 'slash', 'heat', 'cold', 'electricity', 'toxin', 'blast', 'radiation', 'gas',
  'magnetic', 'viral', 'corrosive', 'void', 'tau', null, null, null, null, 'true',
];

/** productCategory → snapshot category, to tell apart weapons that share a name. */
const CATEGORY: Record<string, string> = {
  LongGuns: 'primary',
  Pistols: 'secondary',
  Melee: 'melee',
  SpaceGuns: 'archgun',
  SpaceMelee: 'archmelee',
  SentinelWeapons: 'sentinel',
};

interface ExportWeapon {
  name: string;
  uniqueName: string;
  productCategory?: string;
  damagePerShot?: number[];
  totalDamage?: number;
  criticalChance?: number;
  criticalMultiplier?: number;
  procChance?: number;
  fireRate?: number;
  multishot?: number;
  magazineSize?: number;
  reloadTime?: number;
  masteryReq?: number;
}

async function download(url: string): Promise<Uint8Array> {
  const res = await fetch(url, {
    headers: { 'user-agent': 'wfcalc/0.1 (personal offline damage calculator)' },
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
  return new Uint8Array(await res.arrayBuffer());
}

/** DE's JSON occasionally carries raw control characters inside strings; JSON.parse rejects them. */
function parseExport(text: string): { ExportWeapons: ExportWeapon[] } {
  try {
    return JSON.parse(text);
  } catch {
    return JSON.parse(text.replace(/[\u0000-\u001f]/g, (char) => (char === '\n' || char === '\r' || char === '\t' ? ' ' : '')));
  }
}

const close = (a: number, b: number): boolean => Math.abs(a - b) <= 1e-4 * Math.max(1, Math.abs(a), Math.abs(b));
const total = (stats: Partial<Record<DamageType, number>>): number => DAMAGE_TYPES.reduce((sum, type) => sum + (stats[type] ?? 0), 0);

async function main(): Promise<void> {
  const index = new TextDecoder().decode(decompressLzma(await download(INDEX_URL)));
  const entry = index.split(/\r?\n/).find((line) => line.startsWith('ExportWeapons_en.json'));
  if (!entry) throw new Error('ExportWeapons_en.json is missing from the Public Export index');
  const text = new TextDecoder().decode(await download(`${MANIFEST_URL}/${entry.trim()}`));
  mkdirSync(RAW, { recursive: true });
  writeFileSync(join(RAW, 'ExportWeapons_en.json'), text);
  const exported = parseExport(text).ExportWeapons;
  console.log(`Public Export: ${exported.length} weapons (${entry.trim()})`);

  const snapshot = JSON.parse(readFileSync(SNAPSHOT, 'utf8')) as Snapshot & { publicExport?: unknown };
  const overrides = JSON.parse(readFileSync(OVERRIDES, 'utf8')) as Record<string, Record<string, unknown>>;
  // Archwing guns and melee are exported as "<ARCHWING> Velocitus".
  const plainName = (name: string): string => name.replace(/^<ARCHWING>\s*/, '').toLowerCase();
  const byName = new Map<string, ExportWeapon[]>();
  for (const weapon of exported) {
    const key = plainName(weapon.name);
    byName.set(key, [...(byName.get(key) ?? []), weapon]);
  }

  const changes: Array<{ weapon: string; field: string; from: number; to: number }> = [];
  const profileMismatch: string[] = [];
  const unmatched: string[] = [];
  for (const weapon of Object.values(snapshot.weapons) as WeaponData[]) {
    const options = byName.get(weapon.name.toLowerCase()) ?? [];
    const source = options.find((candidate) => CATEGORY[candidate.productCategory ?? ''] === weapon.category) ?? (options.length === 1 ? options[0] : undefined);
    if (!source) { unmatched.push(weapon.name); continue; }

    const damage: Partial<Record<DamageType, number>> = {};
    (source.damagePerShot ?? []).forEach((value, i) => {
      const type = EXPORT_DAMAGE_ORDER[i];
      if (type && value) damage[type] = value;
    });
    const exportTotal = total(damage);
    const snapshotTotal = total(weapon.stats);
    if (!exportTotal || Math.abs(exportTotal - snapshotTotal) > 0.01 * snapshotTotal) {
      profileMismatch.push(`${weapon.name} (export ${exportTotal.toFixed(1)} vs snapshot ${snapshotTotal.toFixed(1)})`);
      continue;
    }

    const stats = weapon.stats as unknown as Record<string, number>;
    const corrected = new Set(Object.keys(overrides[weapon.name] ?? {}));
    const set = (field: string, value: number | undefined, target: Record<string, number> = stats): void => {
      if (value === undefined || !Number.isFinite(value) || value < 0) return;
      if (corrected.has(field)) return;
      if (value === 0 && field !== 'masteryRank' && !(DAMAGE_TYPES as readonly string[]).includes(field)) return;
      const from = target[field] ?? 0;
      if (close(from, value)) return;
      changes.push({ weapon: weapon.name, field, from, to: value });
      target[field] = value;
    };
    for (const type of DAMAGE_TYPES) set(type, damage[type] ?? 0);
    set('critChance', source.criticalChance);
    set('critMultiplier', source.criticalMultiplier);
    set('statusChance', source.procChance);
    set('fireRate', source.fireRate);
    set('multishot', source.multishot);
    set('magazineSize', source.magazineSize);
    set('reloadTime', source.reloadTime);
    set('masteryRank', source.masteryReq, weapon as unknown as Record<string, number>);
  }
  const known = new Set(Object.keys(snapshot.weapons).map((name) => name.toLowerCase()));
  const missing = exported
    .filter((weapon) => CATEGORY[weapon.productCategory ?? ''] && weapon.damagePerShot && !known.has(plainName(weapon.name)))
    .map((weapon) => weapon.name);

  // ---- stack caps from DE's mod and arcane text
  const stackChanges: Array<{ item: string; effect: string; from: number | null; to: number }> = [];
  const stackUnconfirmed: string[] = [];
  const exportFile = async (name: string, key: string): Promise<Array<{ name: string; levelStats?: Array<{ stats: string[] }> }>> => {
    const line = index.split(/\r?\n/).find((row) => row.startsWith(`${name}_en.json`));
    if (!line) throw new Error(`${name}_en.json is missing from the Public Export index`);
    const body = new TextDecoder().decode(await download(`${MANIFEST_URL}/${line.trim()}`));
    writeFileSync(join(RAW, `${name}_en.json`), body);
    return (parseExport(body) as unknown as Record<string, Array<{ name: string; levelStats?: Array<{ stats: string[] }> }>>)[key] ?? [];
  };
  const upgrades = await exportFile('ExportUpgrades', 'ExportUpgrades');
  const relicArcane = await exportFile('ExportRelicArcane', 'ExportRelicArcane');
  const effectKey = (effect: { target: string; condition?: string; element?: string }): string =>
    `${effect.target}|${effect.condition ?? ''}|${effect.element ?? ''}`;
  for (const [list, items] of [[upgrades, snapshot.mods], [relicArcane, snapshot.arcanes]] as const) {
    const deByName = new Map(list.filter((item) => item.levelStats?.length).map((item) => [item.name.toLowerCase(), item]));
    for (const item of Object.values(items) as Array<{ name: string; effects: Array<{ target: string; condition?: string; element?: string; maxStacks?: number; raw: string }> }>) {
      const de = deByName.get(item.name.toLowerCase());
      if (!de) continue;
      const parsed = parseModEffects(de.levelStats!.map((rank) => rank.stats)).effects;
      for (const effect of item.effects) {
        if (!effect.condition) continue;
        const match = parsed.find((candidate) => effectKey(candidate) === effectKey(effect));
        if (match?.maxStacks !== undefined && match.maxStacks !== effect.maxStacks) {
          stackChanges.push({ item: item.name, effect: effect.raw, from: effect.maxStacks ?? null, to: match.maxStacks });
          effect.maxStacks = match.maxStacks;
        } else if (match && match.maxStacks === undefined && effect.maxStacks !== undefined) {
          stackUnconfirmed.push(`${item.name}: ${effect.raw} (snapshot ${effect.maxStacks}x, DE states no cap)`);
        }
      }
    }
  }
  for (const change of stackChanges) console.log(`  ${change.item}: ${change.effect} stacks ${change.from ?? 'none'} -> ${change.to}`);
  console.log(`stack caps: ${stackChanges.length} set from DE text, ${stackUnconfirmed.length} not stated by DE (kept)`);
  changes.push(...stackChanges.map((change) => ({ weapon: change.item, field: 'maxStacks', from: change.from ?? 0, to: change.to })));

  for (const change of changes) console.log(`  ${change.weapon}: ${change.field} ${change.from} -> ${change.to}`);
  console.log(`${changes.length} field(s) differ across ${new Set(changes.map((change) => change.weapon)).size} weapon(s)`);
  if (profileMismatch.length) console.log(`kept (different attack profile): ${profileMismatch.length}, see data/public-export-report.json`);
  if (unmatched.length) console.log(`not in the export under the same name: ${unmatched.length}`);
  if (missing.length) console.log(`in the export but not in the snapshot: ${missing.length}`);

  writeFileSync(join(ROOT, 'data/public-export-report.json'), JSON.stringify({
    source: entry.trim(), checkedAt: new Date().toISOString(), changes, profileMismatch, unmatched, missing, stackUnconfirmed,
  }, null, 2) + '\n');
  if (check) {
    process.exitCode = changes.length ? 1 : 0;
    return;
  }
  if (!changes.length) {
    console.log('snapshot already matches the Public Export');
    return;
  }
  snapshot.publicExport = { source: entry.trim(), appliedAt: new Date().toISOString(), changedFields: changes.length };
  writeFileSync(SNAPSHOT, JSON.stringify(snapshot));
  console.log('snapshot updated');
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
