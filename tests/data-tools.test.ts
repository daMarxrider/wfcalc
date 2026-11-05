import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { loadSnapshot } from '../src/data.ts';
import { parseRivenStats } from '../tools/lib/riven-stats.ts';
import { compareSnapshots } from '../tools/guard-snapshot.ts';

const RAW = new URL('../data/raw/wiki-riven-mods.wiki', import.meta.url).pathname;

// A rebuild (tools/build-data.ts) parses the riven tables with this parser: it has to give back
// exactly what the snapshot holds, or `npm run update` silently changes every riven.
test('the riven parser reproduces the snapshot\'s riven tables', { skip: !existsSync(RAW) && 'data/raw is not downloaded' }, () => {
  const parsed = parseRivenStats(readFileSync(RAW, 'utf8'));
  const stored = loadSnapshot().rivenStats;
  for (const klass of Object.keys(stored)) {
    for (const [label, value] of Object.entries(stored[klass])) {
      assert.ok(Math.abs((parsed[klass]?.[label] ?? NaN) - value) <= 2e-3 * Math.max(1, Math.abs(value)), `${klass} ${label}: ${parsed[klass]?.[label]} vs ${value}`);
    }
  }
});

// tools/guard-snapshot.ts restores the previous snapshot when compareSnapshots says bad.
test('the snapshot guard blocks empty or shrunk sections and allows small changes', () => {
  const previous = { version: 1, weapons: Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`w${i}`, {}])), mods: { a: { effects: [1] }, b: { effects: [1] } }, rivenStats: { rifle: { x: 1, y: 2 } } };
  const ok = compareSnapshots(previous, { ...previous, weapons: Object.fromEntries(Object.entries(previous.weapons).slice(1)) });
  assert.equal(ok.bad, false);
  assert.deepEqual(ok.lines, ['   weapons: 100 -> 99 (-1)']);
  assert.equal(compareSnapshots(previous, { ...previous, weapons: Object.fromEntries(Object.entries(previous.weapons).slice(5)) }).bad, true);
  assert.equal(compareSnapshots(previous, { ...previous, mods: { a: { effects: [] }, b: { effects: [1] } } }).bad, true);
  assert.equal(compareSnapshots(previous, { ...previous, rivenStats: { rifle: { x: 1 } } }).bad, true);
  assert.equal(compareSnapshots(previous, { ...previous, enemies: {} }).bad, false);
});
