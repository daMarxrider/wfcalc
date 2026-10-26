/**
 * Sniper rifle zoom buffs and shot combo minimums from the wiki (Sniper_Rifle page, "Zoom and
 * Minimum Combo Stats" table).
 *
 * Each sniper has zoom levels with their own scoped bonus (Lanka: +20/30/50% Critical Chance)
 * and a minimum combo that sets how fast the Shot Combo Counter climbs:
 *   multiplier = 1.5 + 0.5 x floor(log3(combo / minimum combo))   (combo >= minimum)
 * Buff texts are parsed with the mod parser, so they become ordinary effects.
 *
 *   node tools/fetch-snipers.ts            fetch, parse and write into data/snapshot.json
 *   node tools/fetch-snipers.ts --check    report only
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { parseModEffects } from '../src/mods/parse.ts';
import type { SniperData, Snapshot } from '../src/types.ts';

const ROOT = new URL('..', import.meta.url).pathname;
const SNAPSHOT = join(ROOT, 'data/snapshot.json');
const URL_RAW = 'https://wiki.warframe.com/w/Sniper_Rifle?action=raw';
const check = process.argv.includes('--check');

/** Plain text of a wiki cell: links and templates reduced to their label, sort keys dropped. */
const plain = (cell: string): string => cell
  .replace(/data-sort-value="[^"]*"\s*\|/g, '')
  .replace(/(?:colspan|rowspan)="\d+"\s*/g, '')
  .replace(/^\s*\|/, '')
  .replace(/\[\[(?:[^|\]]*\|)?([^\]]+)\]\]/g, '$1')
  .replace(/\{\{[^|}]*\|([^}|]*)[^}]*\}\}/g, '$1')
  .replace(/<br\s*\/?>/g, ' ')
  .trim();

export function parseSniperTable(wikitext: string): Record<string, SniperData> {
  const start = wikitext.indexOf('==Zoom and Minimum Combo Stats==');
  if (start < 0) throw new Error('sniper zoom table not found');
  const table = wikitext.slice(start, wikitext.indexOf('\n|}', start));
  const out: Record<string, SniperData> = {};
  let current: string[] = [];
  for (const row of table.split('\n|-').slice(1)) {
    const lines = row.split('\n').map((line) => line.trim()).filter((line) => line.startsWith('|'));
    if (!lines.length) continue;
    let cells = lines;
    const names = [...lines[0].matchAll(/\{\{Weapon\|([^|}]+)/g)].map((match) => match[1].trim());
    if (names.length) {
      current = names;
      cells = lines.slice(1);
      const minimum = lines.map((line) => /(\d+)\s*shots?/.exec(plain(line))).find(Boolean);
      for (const name of names) out[name] = { minimumCombo: minimum ? Number(minimum[1]) : 1, zooms: [] };
    }
    const zoomCell = cells.find((line) => /\d(?:\.\d+)?x/.test(plain(line)));
    const buffCell = cells[cells.indexOf(zoomCell ?? '') + 1];
    if (!zoomCell || !buffCell || !current.length) continue;
    const zoom = Number(/(\d+(?:\.\d+)?)x/.exec(plain(zoomCell))![1]);
    const text = plain(buffCell);
    const lines2 = text.split(/,\s*(?=[+-]?\d)/).map((part) => part.trim()).filter(Boolean);
    const { effects } = parseModEffects([lines2]);
    for (const name of current) out[name].zooms.push({ zoom, text, effects });
  }
  return out;
}

async function main(): Promise<void> {
  const res = await fetch(URL_RAW, { headers: { 'user-agent': 'wfcalc/0.1 (personal offline damage calculator)' }, signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(`${res.status} for ${URL_RAW}`);
  const text = await res.text();
  mkdirSync(join(ROOT, 'data/raw'), { recursive: true });
  writeFileSync(join(ROOT, 'data/raw/wiki-sniper-rifle.wiki'), text);
  const table = parseSniperTable(text);
  const snapshot = JSON.parse(readFileSync(SNAPSHOT, 'utf8')) as Snapshot;
  const unknown = Object.keys(table).filter((name) => !snapshot.weapons[name]);
  const unparsed = Object.entries(table).flatMap(([name, data]) => data.zooms.filter((zoom) => !zoom.effects.length).map((zoom) => `${name} ${zoom.zoom}x: ${zoom.text}`));
  console.log(`snipers: ${Object.keys(table).length}, zoom levels: ${Object.values(table).reduce((sum, data) => sum + data.zooms.length, 0)}`);
  if (unknown.length) console.log(`not in the snapshot under that name: ${unknown.join(', ')}`);
  if (unparsed.length) console.log(`zoom buffs with no damage effect:\n  ${unparsed.join('\n  ')}`);
  if (check) return;
  snapshot.snipers = table;
  writeFileSync(SNAPSHOT, JSON.stringify(snapshot));
  console.log('snapshot updated');
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
