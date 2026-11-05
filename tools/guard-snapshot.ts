/**
 * Last step of `npm run rebuild`: accept or undo the rebuilt snapshot.
 *
 * build-data copies the snapshot it replaces to data/snapshot.prev.json. This compares the
 * rebuilt (and patched) data/snapshot.json with it per section and puts the old one back if a
 * section is empty, shrank, or tools/validate.ts fails.
 *
 *   node tools/guard-snapshot.ts            compare, keep or restore
 *   node tools/guard-snapshot.ts --force    keep the rebuild anyway
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
export const SNAPSHOT = join(ROOT, 'data/snapshot.json');
export const PREVIOUS = join(ROOT, 'data/snapshot.prev.json');

/** A section may lose this share of its entries (renamed or removed items) before it counts as broken. */
const MAX_SHRINK = 0.02;

/** Entry count per section: every top-level object, riven stats per class, mods whose text parsed. */
export function sectionCounts(snapshot: Record<string, any>): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const [key, value] of Object.entries(snapshot)) {
    if (value && typeof value === 'object') counts[key] = Object.keys(value).length;
  }
  for (const [klass, stats] of Object.entries(snapshot.rivenStats ?? {})) counts[`rivenStats.${klass}`] = Object.keys(stats as object).length;
  counts['mods with effects'] = Object.values(snapshot.mods ?? {}).filter((mod: any) => mod.effects?.length > 0).length;
  return counts;
}

/** One line per section that changed size; `bad` is true for those that block the rebuild. */
export function compareSnapshots(previous: Record<string, any>, next: Record<string, any>): { lines: string[]; bad: boolean } {
  const before = sectionCounts(previous);
  const after = sectionCounts(next);
  const lines: string[] = [];
  let bad = false;
  for (const section of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const old = before[section] ?? 0;
    const now = after[section] ?? 0;
    if (old === now) continue;
    const broken = (now === 0 && old > 0) || now < old * (1 - MAX_SHRINK);
    bad ||= broken;
    lines.push(`${broken ? '!!' : '  '} ${section}: ${old} -> ${now} (${now >= old ? '+' : ''}${now - old})`);
  }
  return { lines, bad };
}

function main(): void {
  const force = process.argv.includes('--force');
  if (!existsSync(PREVIOUS)) {
    console.log('guard: no data/snapshot.prev.json to compare with, nothing to do');
    return;
  }
  const { lines, bad } = compareSnapshots(JSON.parse(readFileSync(PREVIOUS, 'utf8')), JSON.parse(readFileSync(SNAPSHOT, 'utf8')));
  console.log(`\nguard: sections that changed size (!! = empty or shrank more than ${MAX_SHRINK * 100}%)`);
  console.log(lines.length ? lines.join('\n') : '   none');

  let valid = true;
  try {
    execFileSync('node', [join(ROOT, 'tools/validate.ts')], { cwd: ROOT, stdio: 'inherit' });
  } catch {
    valid = false;
    console.error('guard: tools/validate.ts failed');
  }

  if ((bad || !valid) && !force) {
    renameSync(PREVIOUS, SNAPSHOT);
    console.error('guard: rebuild rejected, previous snapshot restored (`npm run rebuild -- --force` keeps it anyway)');
    process.exitCode = 1;
    return;
  }
  rmSync(PREVIOUS);
  console.log(bad || !valid ? 'guard: --force, rebuild kept despite the above' : 'guard: rebuild accepted');
}

if (import.meta.main) main();
