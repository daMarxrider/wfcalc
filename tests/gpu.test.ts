import test from 'node:test';
import assert from 'node:assert/strict';
import { loadSnapshot } from '../src/data.ts';
import { bruteForce, bruteForceFromCombinations } from '../src/engine/bruteforce.ts';
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
