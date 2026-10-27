/**
 * Real-snapshot riven values.
 *
 * The wiki's base-value table changed shape once and the parser started reading near-zero
 * cells, so every riven looked like +0.02%. A synthetic test fixture could not catch that;
 * this one uses the real snapshot and checks the order of magnitude.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadSnapshot } from '../src/data.ts';
import { rivenAsMod, rivenEffects } from '../src/engine/riven.ts';

const snapshot = loadSnapshot();

test('real riven base values are percentages, not near-zero cells', () => {
  const weapon = snapshot.weapons['Soma Prime'];
  const riven = rivenEffects(snapshot, weapon, { stats: ['damage', 'multishot'] });
  assert.deepEqual(riven.warnings, []);
  const [damage, multishot] = riven.effects;
  // Base Damage 165% x disposition (Soma Prime ~1.1) x 0.99 for two bonuses.
  assert.ok(damage.value > 1 && damage.value < 2.5, `damage value ${damage.value}`);
  assert.ok(multishot.value > 0.5 && multishot.value < 1.5, `multishot value ${multishot.value}`);
  assert.match(riven.lines[0], /Damage \+\d+(\.\d+)?%/);
});

test('a riven without its card drain costs 16, a max-rank riven', () => {
  assert.equal(rivenAsMod({ stats: ['crit-chance'] }).baseDrain, 16);
  assert.equal(rivenAsMod({ stats: ['crit-chance'], drain: 12 }).baseDrain, 12);
});
