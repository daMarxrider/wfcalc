/**
 * Modular weapon parts from the wiki: zaw strikes/grips/links and kitgun chambers/grips/loaders
 * (Module:Modular/data), amp prisms and scaffolds (Module:Weapons/data/modular). DE's Public
 * Export lists the parts with zero stats, so the wiki is the only source. The engine assembles
 * every combination into a weapon at load time (src/engine/modular.ts).
 *
 *   node tools/fetch-modular.ts            fetch, parse and write into data/snapshot.json
 *   node tools/fetch-modular.ts --check    report only
 *   node tools/fetch-modular.ts --cached   parse the files already in data/raw
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { ModularSource, Snapshot } from '../src/types.ts';
import { parseLuaModule, type LuaTable } from './parse-lua.ts';

const ROOT = new URL('..', import.meta.url).pathname;
const SNAPSHOT = join(ROOT, 'data/snapshot.json');
const SOURCES: Array<[page: string, file: string]> = [
  ['Module:Modular/data', 'module-modular.lua'],
  ['Module:Weapons/data/modular', 'module-weapons-modular.lua'],
];
const check = process.argv.includes('--check');
const cached = process.argv.includes('--cached');

/** Lua lists come out as {1: a, 2: b}; JSON wants arrays. */
function plain(value: unknown): unknown {
  if (!value || typeof value !== 'object') return value;
  const keys = Object.keys(value);
  if (keys.length && keys.every((key, index) => key === String(index + 1))) return Object.values(value).map(plain);
  return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, plain(inner)]));
}

export function parseModular(modularData: string, weaponsModular: string): ModularSource {
  const parts = parseLuaModule(modularData) as LuaTable;
  const weapons = parseLuaModule(weaponsModular) as LuaTable;
  const amps: Record<string, unknown> = {};
  for (const [name, entry] of Object.entries(weapons)) {
    if ((entry as LuaTable)?.Class === 'Amp') amps[name] = entry;
  }
  const source = plain({ Zaw: parts.Zaw, KitgunPrimary: parts.KitgunPrimary, KitgunSecondary: parts.KitgunSecondary, Amp: amps }) as ModularSource;
  if (!Object.keys(source.Zaw?.Strike ?? {}).length || !Object.keys(source.KitgunSecondary?.Chamber ?? {}).length || !Object.keys(source.Amp).length) {
    throw new Error('modular data: a section came back empty (wiki module layout changed?)');
  }
  return source;
}

async function download(page: string): Promise<string> {
  const url = `https://wiki.warframe.com/w/${page}?action=raw`;
  const res = await fetch(url, { headers: { 'user-agent': 'wfcalc/0.1 (personal offline damage calculator)' }, signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(`${res.status} for ${url}`);
  const text = await res.text();
  if (/<!DOCTYPE html>/i.test(text)) throw new Error(`${page} is missing on the wiki (HTML error page)`);
  return text;
}

async function main(): Promise<void> {
  mkdirSync(join(ROOT, 'data/raw'), { recursive: true });
  const texts: string[] = [];
  for (const [page, file] of SOURCES) {
    const path = join(ROOT, 'data/raw', file);
    if (cached && existsSync(path)) {
      texts.push(readFileSync(path, 'utf8'));
      continue;
    }
    const text = await download(page);
    writeFileSync(path, text);
    texts.push(text);
  }
  const modular = parseModular(texts[0], texts[1]);
  const count = (table: Record<string, unknown> | undefined): number => Object.keys(table ?? {}).length;
  console.log(`modular: ${count(modular.Zaw.Strike)} strikes, ${count(modular.Zaw.Grip)} grips, ${count(modular.Zaw.Link)} links; `
    + `kitgun ${count(modular.KitgunPrimary.Chamber)}+${count(modular.KitgunSecondary.Chamber)} chambers, `
    + `${count(modular.KitgunPrimary.Loader)} loaders; ${count(modular.Amp)} amp parts`);
  if (check) return;
  const snapshot = JSON.parse(readFileSync(SNAPSHOT, 'utf8')) as Snapshot;
  snapshot.modular = modular;
  writeFileSync(SNAPSHOT, JSON.stringify(snapshot));
  console.log('snapshot updated');
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
