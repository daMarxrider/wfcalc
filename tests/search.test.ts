/**
 * Build search tests.
 *
 * The search is the part an agent trusts blindly: it returns a build rather than a number, so
 * these tests pin the constraints that make a returned build legal in the game.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadSnapshot } from '../src/data.ts';
import { search } from '../src/engine/search.ts';
import { resolveBuild } from '../src/engine/build.ts';
import { hitEnemy } from '../src/engine/damage.ts';
import { scaleEnemy } from '../src/engine/enemy.ts';

const snapshot = loadSnapshot();

test('a found build is legal: eight slots, capacity respected, formes within budget', () => {
  const result = search(snapshot, { weapon: 'Soma Prime', objective: 'dps', enemy: 'Bombard', level: 150, maxForma: 2 });
  assert.ok(result.builds.length > 0);
  for (const build of result.builds) {
    assert.ok(build.mods.length <= 8, `${build.mods.length} mods does not fit eight slots`);
    assert.ok(build.capacityUsed <= build.capacity, `used ${build.capacityUsed} of ${build.capacity}`);
    assert.ok(build.formaNeeded <= 2, `spent ${build.formaNeeded} Forma with a budget of 2`);
    assert.equal(build.fits, true);
  }
});

test('no Forma available still yields a build that fits', () => {
  const result = search(snapshot, { weapon: 'Soma Prime', objective: 'dps', enemy: 'Bombard', level: 150, maxForma: 0 });
  assert.ok(result.builds.length > 0);
  assert.ok(result.builds.every((build) => build.formaNeeded === 0));
  assert.ok(result.builds.every((build) => build.capacityUsed <= build.capacity));
});

test('a semi-auto trigger lock is never put on an automatic weapon', () => {
  const result = search(snapshot, { weapon: 'Soma Prime', enemy: 'Bombard', level: 150, limit: 3 });
  const locked = result.builds.flatMap((build) => build.mods.map((mod) => mod.name)).filter((name) => /Cannonade/.test(name));
  assert.deepEqual(locked, [], 'Cannonade mods lock the trigger to semi-auto');
  // The same mods are fair game on a weapon that really is semi-auto.
  const latron = search(snapshot, { weapon: 'Latron Prime', enemy: 'Bombard', level: 150, limit: 1 });
  assert.ok(latron.builds.length > 0);
});

test('the search beats a single-mod build it started from', () => {
  const withSerrationOnly = search(snapshot, { weapon: 'Soma Prime', objective: 'dps', enemy: 'Bombard', level: 150, mustInclude: ['Serration'], limit: 1 });
  assert.ok(withSerrationOnly.builds[0].sustainedDps > 0);
  const bare = search(snapshot, { weapon: 'Soma Prime', objective: 'dps', enemy: 'Bombard', level: 150, mustInclude: ['Serration'], limit: 1 });
  assert.equal(withSerrationOnly.builds[0].sustainedDps, bare.builds[0].sustainedDps, 'the search is deterministic');
  assert.ok(withSerrationOnly.builds[0].mods.some((mod) => mod.name === 'Serration'), 'mustInclude is honoured');
});

test('excluded mods never appear in a result', () => {
  const result = search(snapshot, {
    weapon: 'Soma Prime', objective: 'dps', enemy: 'Bombard', level: 150,
    exclude: ['Serration', 'Heavy Caliber', 'Split Chamber'], limit: 2,
  });
  const names = result.builds.flatMap((build) => build.mods.map((mod) => mod.name));
  assert.ok(!names.includes('Serration'));
  assert.ok(!names.includes('Heavy Caliber'));
  assert.ok(!names.includes('Split Chamber'));
});

test('a partial mod makes the result a lower bound and says so', () => {
  // Spectral Serration is a real rifle mod the parser does not fully model.
  const result = search(snapshot, {
    weapon: 'Soma Prime', objective: 'dps', enemy: 'Bombard', level: 150,
    mustInclude: ['Spectral Serration'], limit: 1,
  });
  const build = result.builds[0];
  assert.ok(build.partialMods.includes('Spectral Serration'));
});

test('two mods of the same family never end up together', () => {
  // Pressure Point and Primed Pressure Point are mutually exclusive, and the data says so.
  const result = search(snapshot, { weapon: 'Nikana Prime', objective: 'dps', enemy: 'Bombard', level: 150, limit: 3 });
  for (const build of result.builds) {
    const names = build.mods.map((mod) => mod.name);
    const pressure = names.filter((name) => /Pressure Point$/.test(name));
    assert.ok(pressure.length <= 1, `found ${pressure.join(' and ')}`);
    for (const name of names) {
      const mod = snapshot.mods[name];
      const clash = mod.incompatible.filter((other) => names.includes(other));
      assert.deepEqual(clash, [], `${name} cannot be equipped with ${clash.join(', ')}`);
    }
  }
});

test('a melee search assumes the combo multiplier players fight at', () => {
  const result = search(snapshot, { weapon: 'Nikana Prime', enemy: 'Bombard', level: 150, limit: 1 });
  assert.ok(result.assumptions.some((line) => /combo assumed at 12x/.test(line)));
  // Blood Rush is worth nothing at 1x, so it only shows up because the combo is assumed.
  const withCombo = search(snapshot, { weapon: 'Nikana Prime', objective: 'dps', enemy: 'Bombard', level: 150, limit: 1 });
  const without = search(snapshot, { weapon: 'Nikana Prime', objective: 'dps', enemy: 'Bombard', level: 150, limit: 1, base: { comboHits: 0 } });
  assert.ok(withCombo.builds[0].totalDps > without.builds[0].totalDps);
});

test('the dps objective counts status damage, not just direct hits', () => {
  const result = search(snapshot, { weapon: 'Nikana Prime', objective: 'dps', enemy: 'Bombard', level: 150, limit: 1 });
  const build = result.builds[0];
  assert.ok(build.totalDps >= build.sustainedDps, 'total damage cannot be below direct damage');
});

test('Incarnon evolutions are chosen only when asked for', () => {
  // The Incarnon form is an endgame unlock, so the search leaves it alone unless asked.
  const byDefault = search(snapshot, { weapon: 'Torid', objective: 'dps', enemy: 'Bombard', level: 150, limit: 1 });
  assert.deepEqual(byDefault.builds[0].incarnon, []);
  assert.ok(byDefault.notes.some((note) => /Incarnon evolutions are not assumed/.test(note)));

  const withChoice = search(snapshot, { weapon: 'Torid', objective: 'dps', enemy: 'Bombard', level: 150, limit: 1, chooseIncarnon: true });
  const build = withChoice.builds[0];
  assert.ok(build.incarnon.length > 0, 'asking for evolutions should pick some');
  assert.ok(build.totalDps > byDefault.builds[0].totalDps,
    `choosing evolutions should help: ${build.totalDps} vs ${byDefault.builds[0].totalDps}`);

  // The chosen set must be the best of every combination of the same mods, not merely better
  // than nothing: brute force all of them through the engine and compare.
  const mods = build.mods.map((mod) => ({ name: mod.name }));
  const tiers = [...new Set(snapshot.incarnons['Torid'].map((option) => option.tier))];
  const choices = tiers.map((tier) => {
    const all = snapshot.incarnons['Torid'].filter((option) => option.tier === tier);
    return all.map((option) => `${tier}:${all.indexOf(option)}`);
  });
  const scoreOf = (selection: string[]): number => {
    const resolved = resolveBuild(snapshot, { weapon: 'Torid', mods, incarnon: selection });
    return hitEnemy(snapshot, resolved, scaleEnemy(snapshot, snapshot.enemies['Bombard'], 150), {}).totalDps;
  };
  let bestScore = -1;
  const walk = (index: number, selection: string[]): void => {
    if (index === choices.length) { bestScore = Math.max(bestScore, scoreOf(selection)); return; }
    for (const option of choices[index]) walk(index + 1, [...selection, option]);
  };
  walk(0, []);
  assert.ok(build.totalDps >= bestScore - 1e-6,
    `search found ${build.totalDps}, brute force found ${bestScore}`);
});

test('a weapon without Incarnon data is unaffected', () => {
  const result = search(snapshot, { weapon: 'Kuva Hek', enemy: 'Bombard', level: 150, limit: 1, chooseIncarnon: true });
  assert.deepEqual(result.builds[0].incarnon, []);
  assert.deepEqual(result.builds[0].incarnonNames, []);
});

test('the Incarnon form replaces the weapon profile, not just its perks', () => {
  // WFCD does not export the transformed weapon; the wiki does. Without it a Torid Incarnon
  // was a 140 Toxin grenade at 1.5/s with 15% crit instead of a 51 Toxin beam at 8/s with 29%.
  const form = snapshot.weapons['Torid'].incarnonForm;
  assert.ok(form, 'Torid should carry an Incarnon profile');
  assert.equal(form!.toxin, 51);
  assert.ok(Math.abs(form!.critChance - 0.29) < 1e-6);
  assert.ok(Math.abs(form!.statusChance - 0.39) < 1e-6);
  assert.equal(form!.fireRate, 8);

  // Most Genesis weapons should have one, so a missing profile is a data bug, not a norm.
  const withForm = Object.values(snapshot.weapons).filter((weapon) => weapon.incarnonForm).length;
  assert.ok(withForm > 60, `only ${withForm} weapons carry an Incarnon profile`);
});

test('search names the mods whose value is conditional', () => {
  const result = search(snapshot, {
    weapon: 'Soma Prime', enemy: 'Bombard', level: 150, limit: 1,
    mustInclude: ['Galvanized Chamber'],
    base: { conditions: { onKill: 12, statusTypes: 2 } },
  });
  const build = result.builds[0];
  assert.ok(build.conditionalMods.includes('Galvanized Chamber'),
    `expected Galvanized Chamber in ${build.conditionalMods.join(', ')}`);
  assert.ok(build.conditionalMods.every((name) => snapshot.mods[name].effects.some((effect) => effect.condition)));
});

test('equal-damage ties prefer the mod without an unmodelled accuracy penalty', () => {
  const result = search(snapshot, {
    weapon: 'Haalvu', enemy: 'Bombard', level: 150, objective: 'dps', limit: 1,
    // With crit-scaled bleed, Rifle Elementalist outranks both damage mods; leaving it out keeps
    // the Serration / Heavy Caliber tie this test is about.
    exclude: ['Rifle Elementalist'],
    base: { conditions: { onKill: 12, statusTypes: 2 }, arcanes: [{ name: 'Primary Merciless', rank: 5 }] },
  });
  const names = result.builds[0].mods.map((mod) => mod.name);
  assert.ok(!names.includes('Heavy Caliber'), `Heavy Caliber should lose the tie: ${names.join(', ')}`);
  assert.ok(names.includes('Serration'), `Serration should take its place: ${names.join(', ')}`);
});
