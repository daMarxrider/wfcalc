/**
 * Brute-force search tests.
 *
 * The claim the brute force makes is stronger than the greedy search's: "no build in the
 * candidate set beats this one". The first test checks exactly that against a naive enumeration
 * of every subset in every slot order; the rest pin the player's inputs (fixed mods, Steel Path)
 * on the real data.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadSnapshot } from '../src/data.ts';
import { bruteForce, planBruteForce } from '../src/engine/bruteforce.ts';
import { search } from '../src/engine/search.ts';
import { resolveBuild } from '../src/engine/build.ts';
import { hitEnemy } from '../src/engine/damage.ts';
import { scaleEnemy } from '../src/engine/enemy.ts';
import { parseModEffects } from '../src/mods/parse.ts';
import type { EnemyData, ModData, Snapshot, WeaponData } from '../src/types.ts';

function mod(name: string, topRankStats: string[], overrides: Partial<ModData> = {}): ModData {
  const { effects } = parseModEffects([topRankStats]);
  return {
    id: name, name, category: 'Primary Mod', classes: ['Rifle'], polarity: 'madurai', rarity: 'Rare',
    baseDrain: 4, maxRank: 5, description: topRankStats.join('\n'), effects, cardImage: null, partial: false,
    outOfScopeLines: [], incompatible: [], set: null, upgradeTypes: [], isAugment: false, isRiven: false,
    conclave: false, ...overrides,
  };
}

const testWeapon: WeaponData = {
  id: 'Test Rifle', name: 'Test Rifle', category: 'primary', type: 'Rifle', masteryRank: 0, disposition: 1,
  dispositionMultiplier: 1, polarities: [], exilusPolarity: null, modClasses: ['Rifle'], modes: [], hasRivenSlot: true,
  stats: {
    impact: 20, puncture: 30, slash: 50, heat: 0, cold: 0, electricity: 0, toxin: 0, blast: 0, corrosive: 0, gas: 0,
    magnetic: 0, radiation: 0, viral: 0, true: 0, void: 0, tau: 0,
    critChance: 0.25, critMultiplier: 2, statusChance: 0.2, fireRate: 8, multishot: 1, magazineSize: 40, reloadTime: 2,
  },
};

const target: EnemyData = {
  id: 'Heavy', name: 'Heavy', faction: 'grineer', healthClass: 'Grineer', kind: 'Grineer', baseLevel: 1,
  health: 300, shield: 0, armor: 500,
  pools: [{ type: 'Alloy Armor', category: 'armor', amount: 500 }, { type: 'Cloned Flesh', category: 'health', amount: 300 }],
  toxinBypassesShields: true,
};

function testSnapshot(mods: ModData[]): Snapshot {
  const byName = <T extends { name: string }>(items: T[]) => Object.fromEntries(items.map((item) => [item.name, item]));
  return {
    version: 1, generatedAt: '', gameVersion: '',
    weapons: byName([testWeapon]), mods: byName(mods), arcanes: {}, warframes: {}, abilities: {},
    enemies: byName([target]),
    modifiers: { corrosive: { Grineer: 50 }, impact: { Grineer: 50 }, slash: {}, heat: {}, cold: {}, toxin: {}, viral: {}, blast: {}, gas: {}, magnetic: {}, radiation: {}, electricity: {} },
    healthTypes: { 'Alloy Armor': 'armor', 'Cloned Flesh': 'health' },
    incarnons: {}, setBonuses: {}, rivenStats: {},
  } as unknown as Snapshot;
}

const pool = [
  mod('Serration', ['+165% Damage'], { maxRank: 10 }),
  mod('Split Chamber', ['+90% Multishot']),
  mod('Point Strike', ['+150% Critical Chance']),
  mod('Vital Sense', ['+120% Critical Damage']),
  mod('Hellfire', ['+90% Heat'], { polarity: 'naramon' }),
  mod('Cryo Rounds', ['+90% Cold'], { polarity: 'naramon' }),
  mod('Infected Clip', ['+90% Toxin'], { polarity: 'naramon' }),
  mod('Stormbringer', ['+90% Electricity'], { polarity: 'naramon' }),
  mod('Rifle Aptitude', ['+90% Status Chance']),
  mod('Speed Trigger', ['+60% Fire Rate']),
  mod('Amalgam Serration', ['+155% Damage'], { maxRank: 10, incompatible: ['Serration'] }),
];
pool[0].incompatible = ['Amalgam Serration'];

function score(snapshot: Snapshot, names: string[], level: number): number {
  const resolved = resolveBuild(snapshot, { weapon: 'Test Rifle', mods: names });
  const hit = hitEnemy(snapshot, resolved, scaleEnemy(snapshot, target, level));
  return hit.timeToKill === null ? -Infinity : 1 / hit.timeToKill;
}

function permutations<T>(items: T[]): T[][] {
  if (items.length <= 1) return [items];
  return items.flatMap((item, i) => permutations([...items.slice(0, i), ...items.slice(i + 1)]).map((rest) => [item, ...rest]));
}

test('brute force finds the same optimum as every subset in every slot order', async () => {
  const snapshot = testSnapshot(pool);
  const fixed = ['Serration', 'Split Chamber', 'Point Strike', 'Vital Sense'];
  const result = await bruteForce(snapshot, {
    weapon: 'Test Rifle', enemy: 'Heavy', level: 120, capacity: 60, fixed, limit: 3,
    // The enumeration is what is under test here; the simulated re-rank has its own test.
    simulate: false,
  });
  assert.equal(result.exhaustive, true);
  assert.equal(result.workers, 1, 'an in-memory snapshot cannot be reloaded by workers');

  // Naive: every 4-mod subset of the rest, every order of the whole build.
  const rest = pool.map((mod) => mod.name).filter((name) => !fixed.includes(name) && name !== 'Amalgam Serration');
  let best = -Infinity;
  const choose = (start: number, chosen: string[]): void => {
    if (chosen.length === 4) {
      for (const order of permutations(chosen)) best = Math.max(best, score(snapshot, [...fixed, ...order], 120));
      return;
    }
    for (let i = start; i < rest.length; i++) choose(i + 1, [...chosen, rest[i]]);
  };
  choose(0, []);

  const top = result.builds[0];
  assert.ok(top.timeToKill !== null);
  const found = 1 / top.timeToKill!;
  assert.ok(Math.abs(found - best) <= 1e-9 * best, `brute force ${found} vs naive ${best}`);
  for (const name of fixed) assert.ok(top.mods.some((mod) => mod.name === name && mod.fixed), `${name} is fixed`);
  // Ranked best first.
  for (let i = 1; i < result.builds.length; i++) {
    assert.ok((result.builds[i - 1].timeToKill ?? Infinity) <= (result.builds[i].timeToKill ?? Infinity));
  }
});

test('incompatible mods are never combined and a fixed mod excludes its family', async () => {
  const snapshot = testSnapshot(pool);
  const plan = planBruteForce(snapshot, { weapon: 'Test Rifle', enemy: 'Heavy', fixed: ['Serration'] });
  assert.ok(!plan.candidates.includes('Amalgam Serration'));
  const free = await bruteForce(snapshot, { weapon: 'Test Rifle', enemy: 'Heavy', limit: 10 });
  for (const build of free.builds) {
    const names = build.mods.map((mod) => mod.name);
    assert.ok(!(names.includes('Serration') && names.includes('Amalgam Serration')));
  }
});

test('capacity prunes: with 30 capacity and no Forma every result fits', async () => {
  const snapshot = testSnapshot(pool);
  const result = await bruteForce(snapshot, { weapon: 'Test Rifle', enemy: 'Heavy', capacity: 30, maxForma: 0, limit: 5 });
  assert.ok(result.builds.length > 0);
  for (const build of result.builds) {
    assert.ok(build.capacityUsed <= 30, `${build.capacityUsed} > 30`);
    assert.equal(build.formaNeeded, 0);
  }
});

test('bad input is an InputError with a code', () => {
  const snapshot = testSnapshot(pool);
  assert.throws(() => planBruteForce(snapshot, { weapon: 'Nope' }), { code: 'unknown_weapon' });
  assert.throws(() => planBruteForce(snapshot, { weapon: 'Test Rifle', enemy: 'Heavy', fixed: ['Not A Mod'] }), { code: 'unknown_mod' });
  assert.throws(
    () => planBruteForce(snapshot, { weapon: 'Test Rifle', enemy: 'Heavy', fixed: ['Serration', 'Amalgam Serration'] }),
    { code: 'incompatible_mods' },
  );
});

// ------------------------------------------------------------------------------- real data

const snapshot = loadSnapshot();

test('real weapon: fixed mods and their ranks are kept in every build', async () => {
  const result = await bruteForce(snapshot, {
    weapon: 'Soma Prime', enemy: 'Bombard', level: 150, fixed: [{ name: 'Serration', rank: 8 }, { name: 'Hunter Munitions' }],
    maxEvaluations: 20_000, limit: 3, workers: 2,
  });
  assert.ok(result.builds.length > 0);
  for (const build of result.builds) {
    assert.ok(build.mods.some((mod) => mod.name === 'Serration' && mod.rank === 8 && mod.fixed));
    assert.ok(build.mods.some((mod) => mod.name === 'Hunter Munitions' && mod.fixed));
    assert.ok(build.mods.length <= 8);
    assert.ok(build.capacityUsed <= build.capacity);
  }
});

test('real weapon: the brute force is never worse than the greedy search it is seeded from', async () => {
  const request = { weapon: 'Soma Prime', enemy: 'Bombard', level: 150, objective: 'dps' as const };
  const greedy = search(snapshot, { ...request, limit: 1 });
  const brute = await bruteForce(snapshot, { ...request, maxEvaluations: 20_000, limit: 1 });
  assert.ok(brute.builds[0].totalDps >= greedy.builds[0].totalDps * (1 - 1e-9),
    `brute ${brute.builds[0].totalDps} < greedy ${greedy.builds[0].totalDps}`);
});

test('real weapon: Steel Path makes the same target take longer to kill', async () => {
  const request = { weapon: 'Soma Prime', enemy: 'Bombard', level: 200, fixed: ['Serration', 'Split Chamber', 'Point Strike', 'Vital Sense', 'Hammer Shot', 'Primed Bane of Grineer'] };
  const normal = await bruteForce(snapshot, { ...request, limit: 1 });
  const steel = await bruteForce(snapshot, { ...request, steelPath: true, limit: 1 });
  assert.equal(steel.steelPath, true);
  assert.ok(Math.abs(steel.health - normal.health * 2.5) < 1e-6 * steel.health);
  assert.ok((steel.builds[0].timeToKill ?? 0) > (normal.builds[0].timeToKill ?? Infinity));
});

test('an arch-gun takes a Primary and a Secondary arcane at once (wiki: Archgun Arcane Adapter)', () => {
  const scaled = scaleEnemy(snapshot, snapshot.enemies['Bombard'], 100);
  const one = resolveBuild(snapshot, { weapon: 'Fluctus', mods: [], arcanes: ['Primary Merciless'], conditions: { onKill: 12 } });
  const two = resolveBuild(snapshot, {
    weapon: 'Fluctus', mods: [], arcanes: ['Primary Merciless', 'Secondary Merciless'], conditions: { onKill: 12 },
  });
  assert.deepEqual(two.warnings.filter((warning) => /arcane/i.test(warning)), []);
  assert.ok(hitEnemy(snapshot, two, scaled).totalDps > hitEnemy(snapshot, one, scaled).totalDps * 1.5);
  // Two of the same type still collide on an arch-gun.
  const doubled = resolveBuild(snapshot, { weapon: 'Fluctus', mods: [], arcanes: ['Primary Merciless', 'Primary Deadhead'] });
  assert.ok(doubled.warnings.some((warning) => warning.includes('one primary arcane')));
});

test('every other weapon holds a single arcane', () => {
  const resolved = resolveBuild(snapshot, { weapon: 'Soma Prime', mods: [], arcanes: ['Primary Merciless', 'Primary Deadhead'] });
  assert.ok(resolved.warnings.some((warning) => warning.includes('a weapon holds one arcane')));
});

test('brute force keeps the player arcanes and buffs on every build', async () => {
  const result = await bruteForce(snapshot, {
    weapon: 'Fluctus', enemy: 'Bombard', level: 150, maxEvaluations: 5_000, limit: 2,
    base: { arcanes: [{ name: 'Primary Merciless' }, { name: 'Secondary Merciless' }], buffs: ['roar'], abilityStrength: 180 },
  });
  assert.ok(result.assumptions.some((line) => line.includes('Primary Merciless') && line.includes('Secondary Merciless')));
  assert.ok(result.assumptions.some((line) => line.includes('roar') && line.includes('180%')));
});

test('the simulated re-rank reports the fight: stacks at the kill and damage by source', async () => {
  const result = await bruteForce(snapshot, {
    weapon: 'Soma Prime', enemy: 'Heavy Gunner', level: 150, maxEvaluations: 5_000, limit: 2,
  });
  const top = result.builds[0];
  assert.ok(top.statusAtKill && top.damageBySource);
  assert.ok((top.damageBySource!.direct ?? 0) > 0);
  assert.ok(result.notes.some((note) => note.includes('simulated')));
});

test('Primary Compression matches the wiki table: Kuva Bramma +664%, +956.16% with Primed Firestorm', () => {
  const base = { weapon: 'Kuva Bramma', arcanes: ['Primary Compression'] };
  const plain = resolveBuild(snapshot, { ...base, mods: [], quantize: false });
  const none = resolveBuild(snapshot, { weapon: 'Kuva Bramma', mods: [], quantize: false });
  // Not aiming: the arcane does nothing.
  assert.equal(plain.damage.projectileTotal, none.damage.projectileTotal);
  const aiming = resolveBuild(snapshot, { ...base, mods: [], conditions: { aiming: 1 }, quantize: false });
  assert.ok(Math.abs(aiming.damage.projectileTotal / none.damage.projectileTotal - 7.64) < 1e-9);
  const firestorm = resolveBuild(snapshot, { ...base, mods: ['Primed Firestorm'], stackMode: 'max', quantize: false });
  assert.ok(Math.abs(firestorm.damage.projectileTotal / none.damage.projectileTotal - 10.5616) < 1e-9);
});

test('sniper zoom buffs and the Shot Combo Counter follow the wiki table and formula', () => {
  const unscoped = resolveBuild(snapshot, { weapon: 'Lanka', mods: [], quantize: false });
  const zoomed = resolveBuild(snapshot, { weapon: 'Lanka', mods: [], zoom: 3, quantize: false });
  // Lanka at 8x: +50% Critical Chance on its base.
  assert.ok(Math.abs(zoomed.critChance - unscoped.critChance * 1.5) < 1e-9);
  // Minimum combo 2: 1.5x at 2 hits, +0.5x every 3x more (6, 18, ...).
  for (const [hits, multiplier] of [[1, 1], [2, 1.5], [5, 1.5], [6, 2], [17, 2], [18, 2.5]] as const) {
    assert.equal(resolveBuild(snapshot, { weapon: 'Lanka', mods: [], sniperCombo: hits }).sniperComboMultiplier, multiplier);
  }
});

test('a beam ramps up from 20%: the simulated kill is slower than the steady state for a non-status beam', () => {
  const resolved = resolveBuild(snapshot, { weapon: 'Amprex', mods: ['Serration'] });
  const scaled = scaleEnemy(snapshot, snapshot.enemies['Bombard'], 30);
  const steady = hitEnemy(snapshot, resolved, scaled);
  const simulated = hitEnemy(snapshot, resolved, scaled, { simulate: true });
  assert.ok((simulated.timeToKill ?? 0) > (steady.timeToKill ?? Infinity));
});

test('a riven with its card values: exact stats, a slot and its drain in the brute force', async () => {
  const riven = { stats: ['crit-chance', 'multishot', 'faction-grineer'], malus: 'zoom', values: { 'crit-chance': 142.3, multishot: 110.2, 'faction-grineer': 1.24, zoom: 40.1 }, drain: 18, polarity: 'madurai' };
  const plain = resolveBuild(snapshot, { weapon: 'Soma Prime', mods: [] });
  const withRiven = resolveBuild(snapshot, { weapon: 'Soma Prime', mods: [], riven });
  assert.ok(Math.abs(withRiven.critChance - plain.critChance * 2.423) < 1e-9);
  assert.ok(Math.abs(withRiven.multishot - plain.multishot * 2.102) < 1e-9);
  assert.ok(Math.abs((withRiven.factionBonus.grineer ?? 0) - 0.24) < 1e-9);

  const result = await bruteForce(snapshot, {
    weapon: 'Soma Prime', enemy: 'Bombard', level: 150, capacity: 60, maxEvaluations: 5_000, limit: 2, base: { riven },
  });
  for (const build of result.builds) {
    // Seven searched mods plus the riven, which takes a madurai slot at half drain (Soma has two).
    const rivenRow = build.mods.find((mod) => mod.name === 'Riven');
    assert.ok(rivenRow && rivenRow.fixed);
    assert.equal(rivenRow!.drain, 9);
    assert.equal(build.mods.length, 8);
    assert.ok(build.capacityUsed <= build.capacity);
    assert.ok(build.riven.some((line) => line.includes('142.3')));
  }
});
