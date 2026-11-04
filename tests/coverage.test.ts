/**
 * Mod coverage tests.
 *
 * `partial` means "at least one line of this mod is not understood", which makes a result a
 * lower bound. Utility lines (range, secondary-weapon buffs, Tennokai, armour chipping) are out
 * of scope, not unknown: marking them partial hid the real gaps and made good builds look weak.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadSnapshot } from '../src/data.ts';

const snapshot = loadSnapshot();

test('bow and melee utility mods are not marked partial', () => {
  for (const name of ['Split Flights', 'Plan B', 'Spring-Loaded Blade', 'Stand Ground', 'Tek Gravity', 'Shattering Impact', "Truth's Flame"]) {
    assert.equal(snapshot.mods[name]?.partial, false, `${name} should be fully understood`);
  }
  // Split Flights' multishot is the reason it matters, and it is applied.
  const split = snapshot.mods['Split Flights'];
  assert.ok(split.effects.some((effect) => effect.target === 'multishot' && effect.value === 1));
  // The only remaining partial Melee mod is Strain Infection (crit damage per Cyst), which is
  // a real conditional damage effect that still needs a flag.
  assert.equal(snapshot.mods['Strain Infection'].partial, true);
  const partials = (classes: string) => Object.values(snapshot.mods)
    .filter((mod) => (mod.classes ?? []).includes(classes) && mod.partial).length;
  assert.equal(partials('Bow'), 0);
  assert.equal(partials('Melee'), 1);
});

test('weapon mods the wiki module lacks come from WFCD (issue #31)', () => {
  const blunderbuss = snapshot.mods['Primed Blunderbuss'];
  assert.deepEqual(blunderbuss.effects.map((e) => [e.target, e.value]), [['critChance', 1.65]]);
  assert.equal(blunderbuss.maxRank, 10);
  assert.ok(blunderbuss.incompatible.includes('Blunderbuss') && snapshot.mods['Blunderbuss'].incompatible.includes('Primed Blunderbuss'));
  assert.ok(snapshot.mods['Critical Deceleration'].incompatible.includes('Primed Blunderbuss'));
  const chamber = snapshot.mods['Primed Charged Chamber'];
  assert.deepEqual(chamber.effects.map((e) => [e.target, e.value, e.condition]), [['baseDamage', 1.1, 'firstShot']]);
  assert.ok(snapshot.mods['Charged Chamber'].incompatible.includes('Primed Charged Chamber'));
  // Syndicate stats ('Purity', 'Truth', 'Blight', ...) are out of scope, not unknown.
  const soaring = snapshot.mods['Soaring Truth'];
  assert.equal(soaring.partial, false);
  assert.deepEqual(soaring.outOfScopeLines, ["+1 'Purity'"]);
  assert.equal(snapshot.mods['Bright Purity'].partial, false);
});
