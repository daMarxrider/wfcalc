/**
 * JSON API tests.
 *
 * `wfcalc serve` is the interface an agent is most likely to drive, so the endpoints that
 * mirror the CLI's `search` and `ability` commands must exist and answer on their own.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const PORT = 7913;

async function withServer(run: (base: string) => Promise<void>): Promise<void> {
  const child = spawn(process.execPath, [join(ROOT, 'src/server.ts'), '--port', String(PORT)], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('server did not start')), 15_000);
      child.stdout.on('data', (chunk) => {
        if (/wfcalc web UI/.test(String(chunk))) {
          clearTimeout(timer);
          resolve();
        }
      });
      child.on('error', reject);
    });
    await run(`http://127.0.0.1:${PORT}`);
  } finally {
    child.kill();
  }
}

test('GET /api/ability answers a cast on a target', async () => {
  await withServer(async (base) => {
    const response = await fetch(`${base}/api/ability?name=Miasma&enemy=Bombard&level=150&strength=200`);
    assert.equal(response.status, 200);
    const body = (await response.json()) as any;
    assert.equal(body.ability, 'Miasma');
    assert.equal(body.strength, 200);
    // 150 Viral per second at 100% strength, doubled at 200%.
    assert.equal(body.scaledDamage, 300);
    assert.equal(body.target.enemy, 'Bombard');
    assert.ok(body.target.castsToKill > 0);

    const missing = await fetch(`${base}/api/ability?name=NotAnAbility`);
    assert.equal(missing.status, 404);

    const abilities = (await (await fetch(`${base}/api/abilities`)).json()) as any[];
    assert.ok(abilities.some((ability) => ability.ability === 'Avalanche' && ability.armorStrip), 'the strip picker needs abilities');
  });
});

test('POST /api/calc resolves the armour-strip fields the same way the CLI does', async () => {
  await withServer(async (base) => {
    const calc = async (extra: object) => {
      const response = await fetch(`${base}/api/calc`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ weapon: 'Kuva Bramma', enemy: 'Bombard', level: 150, ...extra }),
      });
      return (await response.json()) as any;
    };
    const plain = await calc({});
    assert.equal(plain.target.armor, 2700);
    // 60% + one Corrosive Projection (18%) is additive: 22% of the armour is left.
    const stripped = await calc({ armorStripPercent: 60, corrosiveProjections: 1 });
    assert.ok(Math.abs(stripped.target.armor - 2700 * 0.22) < 1e-6,
      `expected 594 armour, got ${stripped.target.armor}`);
    assert.ok(stripped.target.timeToKill < plain.target.timeToKill);

    const invalid = await calc({ corrosiveProjections: 9 });
    assert.match(String(invalid.error), /0 to 4/);

    // A build the player sent must come back with its fit and its arcane, not just damage.
    const eximus = await calc({ eximus: true });
    assert.equal(eximus.target.overguard, 281865);
    assert.ok(eximus.target.timeToKill > plain.target.timeToKill);

    const attenuated = await calc({ attenuation: 'archon' });
    assert.equal(attenuated.target.attenuation.id, 'archon');
    assert.equal(attenuated.target.attenuation.mdpi, 460000);

    const fitted = await calc({ mods: [{ name: 'Serration' }], arcanes: [{ name: 'Primary Merciless' }] });
    assert.equal(fitted.capacity, 60);
    assert.ok(fitted.capacityUsed > 0);
    assert.equal(fitted.fits, true);
    assert.deepEqual(fitted.arcanes.map((arcane: any) => arcane.name), ['Primary Merciless']);
  });
});

test('POST /api/search returns a build and accepts the /api/calc shape', async () => {
  await withServer(async (base) => {
    const response = await fetch(`${base}/api/search`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        weapon: 'Soma Prime',
        objective: 'dps',
        enemy: 'Bombard',
        level: 150,
        limit: 1,
        base: { arcanes: [{ name: 'Primary Merciless' }], conditions: { onKill: 12 } },
      }),
    });
    assert.equal(response.status, 200);
    const body = (await response.json()) as any;
    assert.equal(body.weapon, 'Soma Prime');
    assert.equal(body.objective, 'dps');
    assert.equal(body.builds.length, 1);
    assert.equal(body.builds[0].mods.length, 8);
    assert.ok(body.builds[0].totalDps > 0);

    // The arcane in `base` reaches the result instead of being dropped by the search.
    const plain = await fetch(`${base}/api/search`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ weapon: 'Soma Prime', objective: 'dps', enemy: 'Bombard', level: 150, limit: 1 }),
    });
    const withoutBase = (await plain.json()) as any;
    assert.ok(body.builds[0].totalDps > withoutBase.builds[0].totalDps,
      `Primary Merciless at 12 stacks should help: ${body.builds[0].totalDps} vs ${withoutBase.builds[0].totalDps}`);

    const unknown = await fetch(`${base}/api/search`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ weapon: 'NotAWeapon' }),
    });
    assert.equal(unknown.status, 404);
  });
});

test('POST /api/calc rejects a duplicate mod with 400 and a code', async () => {
  await withServer(async (base) => {
    const response = await fetch(`${base}/api/calc`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        weapon: 'Soma Prime',
        mods: [{ name: 'Serration' }, { name: 'Serration' }],
        enemy: 'Bombard',
        level: 150,
      }),
    });
    assert.equal(response.status, 400);
    const body = (await response.json()) as any;
    assert.equal(body.code, 'duplicate_mod');
    assert.match(body.error, /duplicate mod/);
  });
});

test('GET /api/riven-stats lists the riven ids the UI autocompletes', async () => {
  await withServer(async (base) => {
    const stats = (await (await fetch(`${base}/api/riven-stats`)).json()) as any[];
    assert.ok(stats.some((stat) => stat.id === 'crit-chance' && stat.label === 'Critical Chance'));
  });
});
