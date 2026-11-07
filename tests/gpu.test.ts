import test from 'node:test';
import assert from 'node:assert/strict';
import { loadSnapshot } from '../src/data.ts';
import { bruteForce, bruteForceFromCombinations, gpuPlan, scoreCombinations } from '../src/engine/bruteforce.ts';
import { gpuModel } from '../src/engine/gpu-model.ts';
import { P, cpuSearch, proxyScore } from '../src/web/gpu-search.js';

const snapshot = loadSnapshot();

// The GPU path scores everything with a reduced model and only the best `keep` exactly. On a
// candidate set small enough for the exact search, it must still land on the same winner.
const cases: Array<[string, string, boolean]> = [
  ['Soma Prime', 'Bombard', false], ['Hek', 'Corpus Tech', false], ['Lex Prime', 'Heavy Gunner', false],
  ['Kronen Prime', 'Bombard', false], ['Soma Prime', 'Bombard', true], ['Kuva Bramma', 'Charger', true],
];
for (const [weapon, enemy, simulate] of cases) {
  test(`GPU pre-filter + exact pass finds the exhaustive winner: ${weapon} vs ${enemy}${simulate ? ', simulated' : ''}`, async () => {
    const request = { weapon, enemy, level: 150, pool: 14, simulate, limit: 1, workers: 1 };
    const exact = await bruteForce(snapshot, request);
    // 150 of the 3,003 combinations (5%) go to the exact pass; with the simulation it re-ranks 200.
    const model = gpuModel(snapshot, request, simulate ? 400 : 150);
    const shortlist = cpuSearch(model).map(({ combo }) => combo.map((i: number) => model.candidates[i]));
    const filtered = await bruteForceFromCombinations(snapshot, request, shortlist, { combinations: model.combinations, elapsedMs: 0 });
    assert.deepEqual(new Set(model.candidates), new Set(exact.candidates));
    assert.deepEqual(
      filtered.builds[0].mods.map((mod) => mod.name).sort(),
      exact.builds[0].mods.map((mod) => mod.name).sort(),
    );
  });
}

test('GPU pre-filter blends Athodai Overdrive by uptime, like the exact pass', async () => {
  const request = { weapon: 'Athodai', enemy: 'Bombard', level: 150, pool: 14, limit: 1, workers: 1, simulate: false, base: { stackMode: 'max' as const, hit: 'head' as const } };
  const model = gpuModel(snapshot, request, 150);
  assert.ok(model.params.some((value) => value === 8), 'Overdrive seconds reach the model');
  const exact = await bruteForce(snapshot, request);
  const shortlist = cpuSearch(model).map(({ combo }) => combo.map((i: number) => model.candidates[i]));
  const filtered = await bruteForceFromCombinations(snapshot, request, shortlist, { combinations: model.combinations, elapsedMs: 0 });
  assert.deepEqual(filtered.builds[0].mods.map((mod) => mod.name).sort(), exact.builds[0].mods.map((mod) => mod.name).sort());
  // Static mode uses the same formulas: within 3% (always-on Overdrive is ~7% fast here).
  const best = cpuSearch(model)[0];
  const exactTtk = exact.builds[0].timeToKill!;
  const ratio = 1 / proxyScore(model, best.combo) / exactTtk;
  assert.ok(ratio > 0.97 && ratio < 1.03, `proxy/exact kill time ${ratio}`);
});

test('GPU pre-filter scores kills per minute like the exact ranking, not 1 / kill time', () => {
  // Acceltra kills inside its first magazine, so 1 / kill time would skip the reloads (~40% high).
  const request = { weapon: 'Acceltra', enemy: 'Bombard', level: 150, pool: 14, limit: 1, workers: 1, simulate: true, objective: 'kpm' as const, base: { arcanes: ['Primary Compression'] } };
  const model = gpuModel(snapshot, request, 150);
  const best = cpuSearch(model)[0];
  const exact = scoreCombinations(snapshot, gpuPlan(snapshot, request), [best.combo.map((i: number) => model.candidates[i])], 1).top[0];
  const ratio = (60 * best.score) / exact.score;
  assert.ok(ratio > 0.99 && ratio < 1.01, `proxy/exact kills per minute ${ratio}`);
});

test('the reduced model refuses incompatible pairs and builds over the drain bound', () => {
  const model = gpuModel(snapshot, { weapon: 'Soma Prime', enemy: 'Bombard', capacity: 10 }, 10);
  const at = (name: string) => model.candidates.indexOf(name);
  assert.equal(proxyScore(model, [at('Serration'), at('Amalgam Serration')].sort((a, b) => a - b)), 0);
  // 10 capacity cannot hold eight max-rank mods even at half drain.
  assert.equal(proxyScore(model, model.candidates.slice(0, 8).map((_, i) => i)), 0);
});

test('exact passes started together each get their own builds', async () => {
  // Two requests on the warm pool at once: before the queue, both listened for the first answer.
  const exactPass = (weapon: string) => {
    const request = { weapon, enemy: 'Bombard', level: 150, pool: 14, simulate: false, limit: 1, workers: 2 };
    const model = gpuModel(snapshot, request, 3000);
    const shortlist = cpuSearch(model).map(({ combo }) => combo.map((i: number) => model.candidates[i]));
    return () => bruteForceFromCombinations(snapshot, request, shortlist, { combinations: model.combinations, elapsedMs: 0 });
  };
  const soma = exactPass('Soma Prime');
  const hek = exactPass('Hek');
  const names = (result: Awaited<ReturnType<typeof soma>>) => result.builds[0].mods.map((mod) => mod.name).sort();
  const [together, alsoTogether] = await Promise.all([soma(), hek()]);
  assert.equal(together.workers, 2);
  assert.deepEqual(names(together), names(await soma()));
  assert.deepEqual(names(alsoTogether), names(await hek()));
});

test('GPU pre-filter reloads shell by shell like the exact ranking (Strun with Primed Ammo Stock)', () => {
  const request = { weapon: 'Strun', enemy: 'Bombard', level: 150, pool: 30, limit: 1, workers: 1, simulate: false, objective: 'kpm' as const };
  const model = gpuModel(snapshot, request, 150);
  const mods = ['Primed Ammo Stock', 'Primed Tactical Pump', 'Primed Point Blank', "Hell's Chamber", 'Blaze', 'Toxic Barrage', 'Incendiary Coat', 'Shell Shock'];
  const combo = mods.map((name) => model.candidates.indexOf(name)).sort((a, b) => a - b);
  assert.ok(!combo.includes(-1), 'all mods are candidates');
  const exact = scoreCombinations(snapshot, gpuPlan(snapshot, request), [combo.map((i) => model.candidates[i])], 1).top[0];
  const ratio = (60 * proxyScore(model, combo)) / exact.score;
  assert.ok(ratio > 0.99 && ratio < 1.01, `proxy/exact kills per minute ${ratio}`);
});

// Mechanics the proxy mirrors from the exact ranking: its 20 best builds score within 1% of it.
const mirrored: Array<[string, Record<string, unknown>]> = [
  ['Cold freeze', { weapon: 'Glaxion Vandal', enemy: 'Heavy Gunner', requireStatus: ['cold'] }],
  ['Cold on Overguard', { weapon: 'Glaxion Vandal', enemy: 'Heavy Gunner', overguard: 50_000, requireStatus: ['cold'] }],
  ['Cold on a boss', { weapon: 'Glaxion Vandal', enemy: 'Phorid', requireStatus: ['cold'] }],
  ['Treasurer shields', { weapon: 'Hek', enemy: 'Treasurer' }],
  ['steps against the magazine cycle (#62)', { weapon: 'Acceltra', enemy: 'Kela De Thaym' }],
  ['beam ramp in a short fight', { weapon: 'Glaxion', enemy: 'Charger', requireStatus: ['cold'] }],
  ['Heat ramp steps (Soma Prime)', { weapon: 'Soma Prime', enemy: 'Bombard' }],
  ['Secondary Cryogenic', { weapon: 'Lex Prime', enemy: 'Heavy Gunner', base: { arcanes: ['Secondary Cryogenic'] } }],
  ['Secondary Encumber', { weapon: 'Lex Prime', enemy: 'Heavy Gunner', base: { arcanes: ['Secondary Encumber'] } }],
  ['Primary Debilitate', { weapon: 'Soma Prime', enemy: 'Bombard', base: { arcanes: ['Primary Debilitate'] } }],
  ['Archon Continuity (exalted)', { weapon: 'Dex Pixia', enemy: 'Heavy Gunner', base: { frameMods: ['Archon Continuity'] }, requireStatus: ['toxin'] }],
  ['Archon Vitality (exalted)', { weapon: 'Dex Pixia', enemy: 'Bombard', base: { frameMods: ['Archon Vitality'] }, requireStatus: ['heat'] }],
  ['Madurai Phoenix Talons', { weapon: 'Hek', enemy: 'Corpus Tech', base: { buffs: ['phoenix-talons'] } }],
  ['Infinite Ammo on hit (Chamber Cascade)', { weapon: 'Magnus Prime', enemy: 'Heavy Gunner', base: { stackMode: 'max' } }],
  ['Infinite Ammo on kill (Arcane Pistoleer)', { weapon: 'Lex Prime', enemy: 'Heavy Gunner', base: { hit: 'head', stackMode: 'max', arcanes: ['Arcane Pistoleer'] } }],
];
for (const [name, extra] of mirrored) {
  test(`GPU pre-filter scores like the exact ranking: ${name}`, () => {
    const request = { level: 150, pool: 16, limit: 1, workers: 1, simulate: true, ...extra } as Parameters<typeof gpuModel>[1];
    const model = gpuModel(snapshot, request, 20);
    const top = cpuSearch(model, 20);
    const names = top.map(({ combo }) => combo.map((i: number) => model.candidates[i]));
    const exact = new Map(scoreCombinations(snapshot, gpuPlan(snapshot, request), names, 20).top.map((build) => [build.mods.map((mod) => mod.name).sort().join(), build.score]));
    top.forEach(({ score }, i) => {
      const ratio = score / exact.get([...names[i]].sort().join())!;
      assert.ok(ratio > 0.99 && ratio < 1.01, `proxy/exact ${ratio}: ${names[i].join(', ')}`);
    });
  });
}

test('the GPU model carries the fixed build\'s timed ammo buffs', () => {
  const pistoleer = gpuModel(snapshot, { weapon: 'Lex Prime', enemy: 'Heavy Gunner', base: { hit: 'head', stackMode: 'max', arcanes: ['Arcane Pistoleer'] } }, 10);
  assert.equal(pistoleer.params[P.killBuffs], 1);
});

test('GPU pre-filter matches the exact static score: quantization and spool-up', () => {
  // Lex Prime's small Slash share moves with quantization (its ticks carry the kill through
  // armour); Soma Prime spools up after every reload.
  for (const [weapon, mods] of [['Lex Prime', ['Hornet Strike', 'Barrel Diffusion']], ['Soma Prime', ['Serration', 'Split Chamber']]] as const) {
    const request = { weapon, enemy: 'Bombard', level: 150, pool: 40, limit: 1, workers: 1, simulate: false, form: 'normal' as const };
    const model = gpuModel(snapshot, request, 5);
    const combo = mods.map((name) => model.candidates.indexOf(name)).sort((a, b) => a - b);
    const exact = scoreCombinations(snapshot, gpuPlan(snapshot, request), [[...mods]], 1).top[0];
    const ratio = proxyScore(model, combo) / exact.score;
    assert.ok(Math.abs(ratio - 1) < 1e-3, `${weapon}: proxy/exact ${ratio}`);
  }
});
