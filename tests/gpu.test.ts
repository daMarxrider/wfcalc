import test from 'node:test';
import assert from 'node:assert/strict';
import { loadSnapshot } from '../src/data.ts';
import { bruteForce, bruteForceFromCombinations, gpuPlan, scoreCombinations } from '../src/engine/bruteforce.ts';
import { gpuModel } from '../src/engine/gpu-model.ts';
import { cpuSearch, proxyScore } from '../src/web/gpu-search.js';

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
