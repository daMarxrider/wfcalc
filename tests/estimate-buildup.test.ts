import test from 'node:test';
import assert from 'node:assert/strict';
import { findEnemy, loadSnapshot } from '../src/data.ts';
import { resolveBuild } from '../src/engine/build.ts';
import { hitEnemy } from '../src/engine/damage.ts';
import { scaleEnemy } from '../src/engine/enemy.ts';

const snapshot = loadSnapshot();

// #73: while the statuses build up, a long step priced their kink at its midpoint (Viral 0.51% mean error, Blast 0.19%).
test('estimate follows the simulation through the build-up: Soma Prime vs Bombard, pools x0.5-2', () => {
  const rest = ['Serration', 'Split Chamber', 'Vital Sense', 'Point Strike', 'Hellfire', 'Infected Clip', 'Primed Cryo Rounds', 'Vile Acceleration'];
  const viral = rest.map((mod) => (mod === 'Hellfire' ? 'Heavy Caliber' : mod));
  const meanError = (mods: string[]): number => {
    const build = { weapon: 'Soma Prime', mods, stackMode: 'max' as const };
    const resolved = resolveBuild(snapshot, build);
    const errors: number[] = [];
    for (let x = 0.5; x <= 2.001; x += 0.1) {
      const scaled = scaleEnemy(snapshot, findEnemy(snapshot, 'Bombard').item!, 150, {});
      scaled.health *= x;
      scaled.shield *= x;
      scaled.pools = scaled.pools.map((pool) => ({ ...pool, current: pool.current * x }));
      const estimate = hitEnemy(snapshot, resolved, scaled, { steadyStatus: true }).timeToKill!;
      errors.push(Math.abs(estimate / hitEnemy(snapshot, resolved, scaled, { simulate: true, input: build }).timeToKill! - 1));
    }
    return errors.reduce((a, b) => a + b) / errors.length;
  };
  assert.ok(meanError(viral) < 0.0035, `Viral ${meanError(viral)}`);
});
