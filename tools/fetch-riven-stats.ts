/**
 * Riven stat base values per weapon class, from the wiki's "Base Values" tabs (Riven_Mods page:
 * Rifle, Shotgun, Pistol, Archgun, Melee Attribute Ranges).
 *
 * The wiki lists each attribute's range on a max-rank riven for every layout. The engine stores
 * one number per attribute and class: the "+3 -1 Layout" upper bound divided by what that bound
 * already contains, disposition 1.2 x layout 0.9375 x best roll 1.1 (riven.ts multiplies them back
 * for the riven at hand). Attributes that only roll negative (Chance to Gain Combo Count) come from
 * the malus column, whose layout factor is 0.75. Percentages become fractions, "x1.56" faction
 * multipliers their bonus (0.56), seconds and metres stay as they are. A class without an attribute
 * stores 0.
 *
 *   node tools/fetch-riven-stats.ts            fetch the page, write snapshot.rivenStats
 *   node tools/fetch-riven-stats.ts --offline  use data/raw/wiki-riven-mods.wiki as it is
 *   node tools/fetch-riven-stats.ts --check    compare with the snapshot, write nothing
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Snapshot } from '../src/types.ts';
import { parseRivenStats, RIVEN_CLASSES as CLASSES } from './lib/riven-stats.ts';

const ROOT = new URL('..', import.meta.url).pathname;
const SNAPSHOT = join(ROOT, 'data/snapshot.json');
// The same file tools/fetch.ts downloads (tools/sources.ts), so build-data parses what this wrote.
const RAW = join(ROOT, 'data/raw/wiki-riven-mods.wiki');
const URL_RAW = 'https://wiki.warframe.com/w/Riven_Mods?action=raw';
const offline = process.argv.includes('--offline');
const check = process.argv.includes('--check');
let text: string;
if (offline || check) text = readFileSync(RAW, 'utf8');
else {
  const response = await fetch(URL_RAW, { headers: { 'user-agent': 'wfcalc/0.1 (personal damage calculator)' } });
  if (!response.ok) throw new Error(`Riven_Mods: HTTP ${response.status}`);
  text = await response.text();
  writeFileSync(RAW, text);
}
const parsed = parseRivenStats(text);
const snapshot = JSON.parse(readFileSync(SNAPSHOT, 'utf8')) as Snapshot;
let differences = 0;
for (const klass of CLASSES) {
  for (const key of new Set([...Object.keys(parsed[klass] ?? {}), ...Object.keys(snapshot.rivenStats[klass] ?? {})])) {
    const before = snapshot.rivenStats[klass]?.[key];
    const after = parsed[klass]?.[key];
    if (before === undefined || after === undefined || Math.abs(before - after) > 2e-3 * Math.max(1, Math.abs(before))) {
      differences++;
      console.log(`${klass} ${key}: ${before ?? '(none)'} -> ${after ?? '(kept)'}`);
    }
  }
}
console.log(`${differences} difference(s) against the snapshot`);
if (!check) {
  // Attributes the table no longer has are kept, so a page edit cannot silently delete a stat.
  for (const klass of CLASSES) snapshot.rivenStats[klass] = { ...snapshot.rivenStats[klass], ...parsed[klass] };
  writeFileSync(SNAPSHOT, JSON.stringify(snapshot));
  console.log('written to data/snapshot.json');
}
