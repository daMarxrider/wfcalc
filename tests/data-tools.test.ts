import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { loadSnapshot } from '../src/data.ts';
import { parseRivenStats } from '../tools/lib/riven-stats.ts';

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
