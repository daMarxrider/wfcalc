/**
 * Primary Compression data from the wiki's effectiveness table (Primary_Compression page).
 *
 * The arcane converts explosion radius into damage (+100% per metre lost at rank 5, 80% of the
 * radius is lost while aiming), so it needs each attack's base radius. The table also records
 * where the game reads the radius differently (effectiveness) and whether the bonus multiplies
 * or adds to Serration-type bonuses. Rows the arcane does not work on are dropped.
 *
 *   node tools/fetch-compression.ts            fetch, parse and write into data/snapshot.json
 *   node tools/fetch-compression.ts --check    report only
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { CompressionEntry, Snapshot } from '../src/types.ts';

const ROOT = new URL('..', import.meta.url).pathname;
const SNAPSHOT = join(ROOT, 'data/snapshot.json');
const URL_RAW = 'https://wiki.warframe.com/w/Primary_Compression?action=raw';
const check = process.argv.includes('--check');

/** Splits a wiki table row into cells, across `||` and line-start `|`. */
const cells = (row: string): string[] =>
  row.split(/\n\||\|\|/).map((cell) => cell.replace(/data-sort="[^"]*"\s*\|/g, '').trim()).filter(Boolean);

export function parseCompressionTable(wikitext: string): Record<string, CompressionEntry[]> {
  const start = wikitext.indexOf('Primary Compression Effectiveness');
  if (start < 0) throw new Error('Primary Compression table not found');
  const table = wikitext.slice(start, wikitext.indexOf('\n|}', start));
  const out: Record<string, CompressionEntry[]> = {};
  for (const row of table.split('\n|-').slice(1)) {
    const [weaponCell, attack, effectivenessCell, stackingCell, , radiusCell] = cells(row);
    if (!weaponCell || !radiusCell) continue;
    const effectiveness = /(\d+(?:\.\d+)?)%/.exec(effectivenessCell ?? '');
    const stacking = /multipl|both/i.test(stackingCell ?? '') ? 'multiplies' : /adds/i.test(stackingCell ?? '') ? 'adds' : null;
    if (!effectiveness || !stacking || Number(effectiveness[1]) <= 0) continue;
    // "{{Weapon|Lenz}} ({{Weapon|Prisma Lenz|Prisma}})" with "7.2 m" or "3.0 m (5.5 m)".
    const names = [...weaponCell.matchAll(/\{\{Weapon\|([^|}]+)/g)].map((match) => match[1].trim());
    const radii = [...radiusCell.matchAll(/(\d+(?:\.\d+)?)\s*m/g)].map((match) => Number(match[1]));
    if (!names.length || !radii.length) continue;
    const variantStart = weaponCell.indexOf('(');
    names.forEach((name, index) => {
      // A name inside the parentheses takes the parenthesised radius when there is one.
      const inParens = variantStart >= 0 && weaponCell.indexOf(`{{Weapon|${name}`) > variantStart;
      const radius = inParens && radii.length > 1 ? radii[1] : radii[0];
      (out[name] ??= []).push({
        attack: attack ?? '',
        effectiveness: Number(effectiveness[1]) / 100,
        stacking,
        radius,
      });
    });
  }
  return out;
}

async function main(): Promise<void> {
  const res = await fetch(URL_RAW, { headers: { 'user-agent': 'wfcalc/0.1 (personal offline damage calculator)' }, signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(`${res.status} for ${URL_RAW}`);
  const text = await res.text();
  mkdirSync(join(ROOT, 'data/raw'), { recursive: true });
  writeFileSync(join(ROOT, 'data/raw/wiki-primary-compression.wiki'), text);
  const table = parseCompressionTable(text);
  const snapshot = JSON.parse(readFileSync(SNAPSHOT, 'utf8')) as Snapshot;
  const unknown = Object.keys(table).filter((name) => !snapshot.weapons[name]);
  console.log(`Primary Compression: ${Object.keys(table).length} weapons, ${Object.values(table).flat().length} attacks`);
  if (unknown.length) console.log(`not in the snapshot under that name: ${unknown.join(', ')}`);
  if (check) return;
  snapshot.compression = table;
  writeFileSync(SNAPSHOT, JSON.stringify(snapshot));
  console.log('snapshot updated');
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
