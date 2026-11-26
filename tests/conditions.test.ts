/**
 * Conditional and special mod effects through resolveBuild, on a synthetic weapon so every
 * number is easy to follow by hand.
 *
 * The test rifle: 100 Impact, 20% crit, 2x crit multiplier, 10% status, 2 shots/s, 10 rounds,
 * 1 s reload, multishot 1. Quantization is off so the formulas show unrounded.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveBuild as resolveQuantized, type Build } from '../src/engine/build.ts';
import { InputError } from '../src/errors.ts';
import { hitEnemy } from '../src/engine/damage.ts';
import { scaleEnemy } from '../src/engine/enemy.ts';
import type { EnemyData, ModData, WeaponData } from '../src/types.ts';
import { close, mod, snapshot, weapon } from './builders.ts';

/** Resolves on 'Test Weapon' with every given mod equipped at max rank, unless `build.mods` says otherwise. */
const resolve = (weapons: WeaponData[], mods: ModData[], build: Partial<Build>) =>
  resolveQuantized(snapshot(weapons, mods), { weapon: 'Test Weapon', mods: mods.map((entry) => entry.name), quantize: false, ...build });

const rifle = () => weapon({ impact: 100 });
const meleeWeapon = () => weapon({ impact: 100 }, { category: 'melee', type: 'Melee', modClasses: ['Melee'] });
const bow = () => weapon({ impact: 100 }, { type: 'Bow', modClasses: ['Rifle', 'Bow'] });

// Card texts as the wiki prints them.
const serration = () => mod('Serration', 10, ['+165% Damage']);
const galvanizedChamber = () => mod('Galvanized Chamber', 10, ['+80% Multishot', 'On Kill:', '+30% Multishot for 20s. Stacks up to 5x.']);
const bladedRounds = () => mod('Bladed Rounds', 5, ['On Kill:', '+120% Critical Damage when Aiming for 9s']);
const argonScope = () => mod('Argon Scope', 5, ['On Weak Point Hit:', '+135% Critical Chance when Aiming for 9s']);
const primedChamber = () => mod('Primed Chamber', 3, ['+100% Damage on first shot in Magazine'], { classes: ['Rifle'] });
const conditionOverload = () => mod('Condition Overload', 5, ['+80% Melee Damage per Status Type affecting the target'], { classes: ['Melee'] });
const galvanizedAptitude = () => mod('Galvanized Aptitude', 10, ['+80% Status Chance', 'On Kill:', '+40% Direct Damage per Status Type affecting the target for 20s. Stacks up to 2x.']);
const bloodRush = () => mod('Blood Rush', 10, ['+40% Critical Chance stacks with Combo Multiplier'], { classes: ['Melee'] });
const fervor = () => mod('Vigilante Fervor', 5, ['+45% Fire Rate (x2 for Bows)']);
const criticalDelay = () => mod('Critical Delay', 5, ['+200% Critical Chance', '-20% Fire Rate (x2 for Bows)']);

// ------------------------------------------------------------- custom mode (the default)

test('custom: an on-kill effect is off when no condition is given (Galvanized Chamber: 1 + 0.8)', () => {
  close(resolve([rifle()], [galvanizedChamber()], {}).multishot, 1.8);
});

test('custom: an off effect is listed as inactive with its card line', () => {
  assert.ok(resolve([rifle()], [galvanizedChamber()], {}).inactiveConditions.includes('Galvanized Chamber: +30% Multishot for 20s. Stacks up to 5x.'));
});

test('custom: "onKill: true" is one stack (1 + 0.8 + 0.3)', () => {
  close(resolve([rifle()], [galvanizedChamber()], { conditions: { onKill: true } }).multishot, 2.1);
});

test('custom: "onKill: 3" is three stacks (1 + 0.8 + 3 x 0.3)', () => {
  close(resolve([rifle()], [galvanizedChamber()], { conditions: { onKill: 3 } }).multishot, 2.7);
});

test('custom: stacks above the card cap stop at the cap (99 kills -> 5 stacks: 1 + 0.8 + 1.5)', () => {
  close(resolve([rifle()], [galvanizedChamber()], { conditions: { onKill: 99 } }).multishot, 3.3);
});

test('custom: "onKill: 0" turns the effect off', () => {
  close(resolve([rifle()], [galvanizedChamber()], { conditions: { onKill: 0 } }).multishot, 1.8);
});

test('custom: "onKill: false" turns the effect off', () => {
  close(resolve([rifle()], [galvanizedChamber()], { conditions: { onKill: false } }).multishot, 1.8);
});

test('custom: an effect without a stack cap counts once however many kills (Bladed Rounds: 2 x 2.2)', () => {
  close(resolve([rifle()], [bladedRounds()], { conditions: { onKill: 12, aiming: true } }).critMultiplier, 4.4);
});

test('custom: a compound condition is off when only the kill part is on (Bladed Rounds needs aiming)', () => {
  close(resolve([rifle()], [bladedRounds()], { conditions: { onKill: 1 } }).critMultiplier, 2);
});

test('custom: a compound condition is off when only the aiming part is on', () => {
  close(resolve([rifle()], [bladedRounds()], { conditions: { aiming: true } }).critMultiplier, 2);
});

test('custom: the switches decide a weak-point effect, whatever the hit zone (Argon Scope: 0.2 x 2.35)', () => {
  const resolved = resolve([rifle()], [argonScope()], { hit: 'body', conditions: { onWeakPointHit: 1, aiming: true } });
  close(resolved.critChance, 0.47);
});

test('custom: the build reports each conditional source with its cap and the stacks in use', () => {
  const [source] = resolve([rifle()], [galvanizedChamber()], { conditions: { onKill: 3 } }).conditionalSources;
  assert.deepEqual([source.name, source.cap, source.stacks], ['Galvanized Chamber', 5, 3]);
});

// ------------------------------------------------------------- none mode

test('none: every conditional effect is off even when its condition is given', () => {
  close(resolve([rifle()], [galvanizedChamber()], { stackMode: 'none', conditions: { onKill: 5 } }).multishot, 1.8);
});

test('none: unconditional effects still apply (Serration: 100 x 2.65)', () => {
  close(resolve([rifle()], [serration()], { stackMode: 'none' }).damage.projectileTotal, 265);
});

// ------------------------------------------------------------- max mode

test('max: an on-kill effect runs at its cap (1 + 0.8 + 5 x 0.3)', () => {
  close(resolve([rifle()], [galvanizedChamber()], { stackMode: 'max' }).multishot, 3.3);
});

test('max: an aiming effect stays off until the aiming switch is on (Bladed Rounds)', () => {
  close(resolve([rifle()], [bladedRounds()], { stackMode: 'max' }).critMultiplier, 2);
});

test('max: an aiming effect is on with the aiming switch (Bladed Rounds: 2 x 2.2)', () => {
  close(resolve([rifle()], [bladedRounds()], { stackMode: 'max', conditions: { aiming: true } }).critMultiplier, 4.4);
});

test('max: aiming set to false keeps an aiming effect off', () => {
  close(resolve([rifle()], [bladedRounds()], { stackMode: 'max', conditions: { aiming: false } }).critMultiplier, 2);
});

test('max: a sliding effect needs the sliding switch', () => {
  const slide = mod('Slide Test', 5, ['+100% Damage when Sliding']);
  close(resolve([rifle()], [slide], { stackMode: 'max' }).damage.projectileTotal, 100);
});

test('max: a sliding effect is on with the sliding switch (100 x 2)', () => {
  const slide = mod('Slide Test', 5, ['+100% Damage when Sliding']);
  close(resolve([rifle()], [slide], { stackMode: 'max', conditions: { sliding: true } }).damage.projectileTotal, 200);
});

test('max: an airborne effect needs the airborne switch', () => {
  const airborne = mod('Airborne Test', 5, ['While Airborne:', '+100% Damage']);
  close(resolve([rifle()], [airborne], { stackMode: 'max' }).damage.projectileTotal, 100);
});

test('max: a weak-point effect stays off on body shots, even while aiming (Argon Scope)', () => {
  close(resolve([rifle()], [argonScope()], { stackMode: 'max', hit: 'body', conditions: { aiming: true } }).critChance, 0.2);
});

test('max: a weak-point effect is on for head hits while aiming (Argon Scope: 0.2 x 2.35)', () => {
  close(resolve([rifle()], [argonScope()], { stackMode: 'max', hit: 'head', conditions: { aiming: true } }).critChance, 0.47);
});

test('max: "headshot: true" is the same as hit head for weak-point effects', () => {
  close(resolve([rifle()], [argonScope()], { stackMode: 'max', headshot: true, conditions: { aiming: true } }).critChance, 0.47);
});

test('max: a condition the engine has no switch for runs at its cap (On Low Health)', () => {
  const lowHealth = mod('Low Health Test', 5, ['On Low Health:', '+100% Damage']);
  close(resolve([rifle()], [lowHealth], { stackMode: 'max' }).damage.projectileTotal, 200);
});

// ------------------------------------------------------------- per-source stacks

test('sourceStacks: a per-source count wins over max mode (2 stacks: 1 + 0.8 + 0.6)', () => {
  close(resolve([rifle()], [galvanizedChamber()], { stackMode: 'max', sourceStacks: { 'Galvanized Chamber': 2 } }).multishot, 2.4);
});

test('sourceStacks: 0 turns one source off in max mode', () => {
  close(resolve([rifle()], [galvanizedChamber()], { stackMode: 'max', sourceStacks: { 'Galvanized Chamber': 0 } }).multishot, 1.8);
});

test('sourceStacks: a count above the cap stops at the cap', () => {
  close(resolve([rifle()], [galvanizedChamber()], { sourceStacks: { 'Galvanized Chamber': 9 } }).multishot, 3.3);
});

test('sourceStacks: a count works in custom mode without the condition switch', () => {
  close(resolve([rifle()], [galvanizedChamber()], { sourceStacks: { 'Galvanized Chamber': 2 } }).multishot, 2.4);
});

test('sourceStacks: a count for another source leaves this one alone', () => {
  close(resolve([rifle()], [galvanizedChamber()], { stackMode: 'max', sourceStacks: { 'Bladed Rounds': 0 } }).multishot, 3.3);
});

// ------------------------------------------------------------- first shot in magazine

test('first shot: Primed Chamber is off by default in custom mode', () => {
  close(resolve([rifle()], [primedChamber()], {}).damage.projectileTotal, 100);
});

test('first shot: Primed Chamber averages over the magazine in max mode (10 rounds: 100 x 1.1)', () => {
  close(resolve([rifle()], [primedChamber()], { stackMode: 'max' }).damage.projectileTotal, 110);
});

test('first shot: a one-round magazine gets Primed Chamber on every shot (100 x 2)', () => {
  const vectisLike = weapon({ impact: 100, magazineSize: 1 });
  close(resolve([vectisLike], [primedChamber()], { stackMode: 'max' }).damage.projectileTotal, 200);
});

test('first shot: the firstShot switch averages over the magazine too (5 rounds: 100 x 1.2)', () => {
  const rubicoLike = weapon({ impact: 100, magazineSize: 5 });
  close(resolve([rubicoLike], [primedChamber()], { conditions: { firstShot: true } }).damage.projectileTotal, 120);
});

// ------------------------------------------------------------- reload-triggered effects

test('on reload: a 9 s buff covers a whole 6 s magazine cycle (10 rounds / 2 per s + 1 s reload)', () => {
  const reloadBuff = mod('Reload Test', 5, ['On Reload:', '+100% Damage for 9s']);
  close(resolve([rifle()], [reloadBuff], { stackMode: 'max' }).damage.projectileTotal, 200);
});

test('on reload: a 9 s buff covers 9 / 51 of a long cycle (100 rounds / 2 per s + 1 s)', () => {
  const reloadBuff = mod('Reload Test', 5, ['On Reload:', '+100% Damage for 9s']);
  const bigMag = weapon({ impact: 100, magazineSize: 100 });
  // 9 s of buff over a 50 s + 1 s cycle: 9 / 51 = 0.17647 uptime, so 100 x 1.17647.
  close(resolve([bigMag], [reloadBuff], { stackMode: 'max' }).damage.projectileTotal, 117.647059);
});

test('on reload: a weapon that never reloads in a fight never triggers it, and says so', () => {
  const reloadBuff = mod('Reload Test', 5, ['On Reload:', '+100% Damage for 9s']);
  const endless = weapon({ impact: 100, magazineSize: 1_000_000 });
  const resolved = resolve([endless], [reloadBuff], { stackMode: 'max' });
  assert.deepEqual([resolved.damage.projectileTotal, resolved.inactiveConditions], [100, ['Reload Test: +100% Damage for 9s (this weapon never reloads in a fight)']]);
});

// ------------------------------------------------------------- rank scaling

test('rank: rank 0 is 1/(maxRank + 1) of the max value (Serration R0: +15%)', () => {
  close(resolve([rifle()], [serration()], { mods: [{ name: 'Serration', rank: 0 }] }).damage.projectileTotal, 115);
});

test('rank: no rank given means max rank (Serration R10: +165%)', () => {
  close(resolve([rifle()], [serration()], { mods: ['Serration'] }).damage.projectileTotal, 265);
});

test('rank: a rank above max is clamped to max', () => {
  close(resolve([rifle()], [serration()], { mods: [{ name: 'Serration', rank: 99 }] }).damage.projectileTotal, 265);
});

test('rank: a negative rank gives nothing, never a negative bonus', () => {
  close(resolve([rifle()], [serration()], { mods: [{ name: 'Serration', rank: -3 }] }).damage.projectileTotal, 100);
});

test('rank: a conditional effect scales with rank and stacks (Galvanized Chamber R4, 5 kills)', () => {
  // R4 of 10 is 5/11 of each value: 1 + 0.8 x 5/11 + 0.3 x 5/11 x 5 = 1 + 0.36364 + 0.68182.
  const resolved = resolve([rifle()], [galvanizedChamber()], { mods: [{ name: 'Galvanized Chamber', rank: 4 }], conditions: { onKill: 5 } });
  close(resolved.multishot, 2.0454545);
});

test('rank: a mod with max rank 0 ignores the rank it is given', () => {
  const fixed = mod('Fixed Test', 0, ['+50% Damage']);
  close(resolve([rifle()], [fixed], { mods: [{ name: 'Fixed Test', rank: 0 }] }).damage.projectileTotal, 150);
});

// ------------------------------------------------------------- bows, combo, status types

test('bows: "(x2 for Bows)" is single on a rifle (2 x 1.45)', () => {
  close(resolve([rifle()], [fervor()], { mods: ['Vigilante Fervor'] }).fireRate, 2.9);
});

test('bows: "(x2 for Bows)" doubles on a bow (2 x 1.9)', () => {
  close(resolve([bow()], [fervor()], { mods: ['Vigilante Fervor'] }).fireRate, 3.8);
});

test('bows: a doubled drawback doubles too (Critical Delay on a bow: 2 x 0.6)', () => {
  close(resolve([bow()], [criticalDelay()], { mods: ['Critical Delay'] }).fireRate, 1.2);
});

test('combo: Blood Rush does nothing below 20 hits (1x combo)', () => {
  close(resolve([meleeWeapon()], [bloodRush()], { mods: ['Blood Rush'], comboHits: 19 }).critChance, 0.2);
});

test('combo: Blood Rush at 20 hits (2x) is +40% x 1 (0.2 x 1.4)', () => {
  close(resolve([meleeWeapon()], [bloodRush()], { mods: ['Blood Rush'], comboHits: 20 }).critChance, 0.28);
});

test('combo: 39 hits is still 2x', () => {
  close(resolve([meleeWeapon()], [bloodRush()], { mods: ['Blood Rush'], comboHits: 39 }).critChance, 0.28);
});

test('combo: 40 hits is 3x (0.2 x 1.8)', () => {
  close(resolve([meleeWeapon()], [bloodRush()], { mods: ['Blood Rush'], comboHits: 40 }).critChance, 0.36);
});

test('combo: 220 hits is the 12x cap (0.2 x (1 + 0.4 x 11))', () => {
  close(resolve([meleeWeapon()], [bloodRush()], { mods: ['Blood Rush'], comboHits: 220 }).critChance, 1.08);
});

test('combo: hits past the cap stay at 12x', () => {
  close(resolve([meleeWeapon()], [bloodRush()], { mods: ['Blood Rush'], comboHits: 10_000 }).critChance, 1.08);
});

test('combo: a negative hit count is treated as no combo', () => {
  close(resolve([meleeWeapon()], [bloodRush()], { mods: ['Blood Rush'], comboHits: -5 }).critChance, 0.2);
});

test('status types: Condition Overload counts the given status types (100 x (1 + 3 x 0.8))', () => {
  close(resolve([meleeWeapon()], [conditionOverload()], { mods: ['Condition Overload'], conditions: { statusTypes: 3 } }).damage.projectileTotal, 340);
});

test('status types: zero status types still counts one (a hit always lands its own)', () => {
  close(resolve([meleeWeapon()], [conditionOverload()], { mods: ['Condition Overload'], conditions: { statusTypes: 0 } }).damage.projectileTotal, 180);
});

test('status types: without a count the build counts its own (pure Impact: one type, 100 x 1.8)', () => {
  close(resolve([meleeWeapon()], [conditionOverload()], { mods: ['Condition Overload'] }).damage.projectileTotal, 180);
});

test('status types: extra status types from other sources add to the own ones (1 + 2: 100 x 3.4)', () => {
  close(resolve([meleeWeapon()], [conditionOverload()], { mods: ['Condition Overload'], extraStatusTypes: 2 }).damage.projectileTotal, 340);
});

test('status types: a stacking per-status bonus multiplies stacks by types (Galvanized Aptitude 2 x 3 x 0.4, with Serration)', () => {
  // Adds to the Serration bucket on ordinary weapons (wiki: Condition Overload (Mechanic)): 100 x (1 + 1.65 + 2.4).
  const resolved = resolve([rifle()], [serration(), galvanizedAptitude()], { mods: ['Serration', 'Galvanized Aptitude'], conditions: { onKill: 2, statusTypes: 3 } });
  close(resolved.damage.projectileTotal, 505);
});

// ------------------------------------------------------------- stat edges

test('magazine: rounds to a whole number (6 x 2.1 = 12.6 -> 13)', () => {
  const mag = mod('Mag Test', 5, ['+110% Magazine Capacity']);
  close(resolve([weapon({ impact: 100, magazineSize: 6 })], [mag], { mods: ['Mag Test'] }).magazineSize, 13);
});

test('magazine: a drawback never takes a magazine below one round', () => {
  const malus = mod('Mag Malus', 5, ['-60% Magazine Capacity']);
  close(resolve([weapon({ impact: 100, magazineSize: 1 })], [malus], { mods: ['Mag Malus'] }).magazineSize, 1);
});

test('reload: +100% reload speed halves the reload time (2 s -> 1 s)', () => {
  const fast = mod('Reload Test', 5, ['+100% Reload Speed']);
  close(resolve([weapon({ impact: 100, reloadTime: 2 })], [fast], { mods: ['Reload Test'] }).reloadTime, 1);
});

test('crit: crit chance above 100% is kept, not capped (0.5 x 3 = 150%)', () => {
  close(resolve([weapon({ impact: 100, critChance: 0.5 })], [criticalDelay()], { mods: ['Critical Delay'] }).critChance, 1.5);
});

test('crit: the average shot uses 1 + cc x (cd - 1) above 100% too (100 x (1 + 1.5 x 1) = 250)', () => {
  close(resolve([weapon({ impact: 100, critChance: 0.5 })], [criticalDelay()], { mods: ['Critical Delay'] }).averageShotDamage, 250);
});

test('a weapon with no damage resolves to zero damage, not NaN', () => {
  const resolved = resolve([weapon({})], [serration()], { mods: ['Serration'] });
  assert.deepEqual([resolved.damage.projectileTotal, resolved.sustainedDps], [0, 0]);
});

// ------------------------------------------------------------- bad input

test('an unknown mod only warns and changes nothing', () => {
  const resolved = resolve([rifle()], [], { mods: ['No Such Mod'] });
  assert.deepEqual([resolved.damage.projectileTotal, resolved.warnings], [100, ['mod not found: No Such Mod']]);
});

test('a mod for another weapon class warns that it does not fit', () => {
  const pistolMod = mod('Pistol Test', 5, ['+50% Damage'], { classes: ['Pistol'] });
  const { warnings } = resolve([rifle()], [pistolMod], { mods: ['Pistol Test'] });
  assert.deepEqual(warnings, ['Pistol Test does not fit a Rifle (Rifle)']);
});

test('two incompatible mods warn', () => {
  const first = mod('First Test', 5, ['+50% Damage']);
  const second = mod('Second Test', 5, ['+50% Damage'], { incompatible: ['First Test'] });
  const { warnings } = resolve([rifle()], [first, second], { mods: ['First Test', 'Second Test'] });
  assert.deepEqual(warnings, ['Second Test cannot be equipped with First Test']);
});

test('the same mod twice is a duplicate_mod InputError', () => {
  assert.throws(
    () => resolve([rifle()], [serration()], { mods: ['Serration', 'Serration'] }),
    (error: unknown) => error instanceof InputError && error.code === 'duplicate_mod',
  );
});

test('the same mod twice in different letter case is still a duplicate', () => {
  assert.throws(
    () => resolve([rifle()], [serration()], { mods: ['Serration', { name: 'serration', rank: 3 }] }),
    (error: unknown) => error instanceof InputError && error.code === 'duplicate_mod',
  );
});

test('an unknown weapon is an unknown_weapon InputError', () => {
  assert.throws(
    () => resolve([rifle()], [], { weapon: 'No Such Weapon', mods: [] }),
    (error: unknown) => error instanceof InputError && error.code === 'unknown_weapon',
  );
});

// ------------------------------------------------------------- a proc per Impact proc (Internal Bleeding)

const internalBleeding = () => mod('Internal Bleeding', 5, ['Impact Status Effects have 35% chance to apply a Slash Status Effect (x2 when Fire Rate is below 2.5)']);
/** Pure Impact, every pellet procs, a magazine that practically never reloads: 2 Impact procs a second. */
const impactRifle = (fireRate: number) => weapon({ impact: 100, statusChance: 1, critChance: 0, fireRate, magazineSize: 1_000_000 });
const dummy: EnemyData = {
  id: 'Dummy', name: 'Dummy', faction: 'grineer', healthClass: 'Grineer', kind: 'Grineer', baseLevel: 1,
  health: 1_000_000, shield: 0, armor: 0, pools: [{ type: 'Neutral Flesh', category: 'health', amount: 1_000_000 }], toxinBypassesShields: true,
};

test('Internal Bleeding: 35% per Impact proc at 2.5 shots/s or more', () => {
  assert.deepEqual(resolve([impactRifle(3)], [internalBleeding()], {}).impactProcs, { slash: 0.35 });
});

test('Internal Bleeding: doubled to 70% below 2.5 shots/s', () => {
  assert.deepEqual(resolve([impactRifle(2)], [internalBleeding()], {}).impactProcs, { slash: 0.7 });
});

test('Internal Bleeding: exactly 2.5 shots/s does not double (wiki)', () => {
  assert.deepEqual(resolve([impactRifle(2.5)], [internalBleeding()], {}).impactProcs, { slash: 0.35 });
});

test('Internal Bleeding: the modded fire rate decides (2 x 1.5 = 3 shots/s: no doubling)', () => {
  const speed = mod('Speed Test', 5, ['+50% Fire Rate']);
  assert.deepEqual(resolve([impactRifle(2)], [internalBleeding(), speed], {}).impactProcs, { slash: 0.35 });
});

test('Internal Bleeding: a rank 0 copy is 1/6 of the card (35% / 6, doubled)', () => {
  close(resolve([impactRifle(2)], [internalBleeding()], { mods: [{ name: 'Internal Bleeding', rank: 0 }] }).impactProcs.slash ?? 0, 0.7 / 6);
});

test('without the mod a build has no Impact-triggered procs', () => {
  assert.deepEqual(resolve([impactRifle(2)], [], {}).impactProcs, {});
});

test('Internal Bleeding: Slash procs a second = Impact procs x chance (2 x 0.7 = 1.4) in the steady DoT', () => {
  const snap = snapshot([impactRifle(2)], [internalBleeding()], [dummy]);
  const resolved = resolveQuantized(snap, { weapon: 'Test Weapon', mods: ['Internal Bleeding'], quantize: false });
  const slash = hitEnemy(snap, resolved, scaleEnemy(snap, dummy, 1)).dot.find((entry) => entry.type === 'slash');
  close(slash?.procsPerSecond ?? 0, 1.4, 1e-4);
});

/** Simulated seconds for the 2-shots/s Impact rifle to kill a 3,000-health target with these mods. */
function simulatedKill(mods: string[]): number {
  const small: EnemyData = { ...dummy, health: 3000, pools: [{ type: 'Neutral Flesh', category: 'health', amount: 3000 }] };
  const snap = snapshot([impactRifle(2)], [internalBleeding()], [small]);
  const resolved = resolveQuantized(snap, { weapon: 'Test Weapon', mods, quantize: false });
  return hitEnemy(snap, resolved, scaleEnemy(snap, small, 1), { simulate: true }).timeToKill ?? Infinity;
}

test('Internal Bleeding: the simulated fight bleeds the target, so it dies sooner than without', () => {
  const bleeding = simulatedKill(['Internal Bleeding']);
  const plain = simulatedKill([]);
  assert.ok(bleeding < plain, `${bleeding} s is not below ${plain} s`);
});

// ------------------------------------------------------------- Hunter Munitions with Internal Bleeding

const hunterMunitions = () => mod('Hunter Munitions', 5, ['+30% chance to apply on Critical'], { classes: ['Primary'] });
/** The Impact rifle with a set crit chance and fire rate. */
const critImpactRifle = (critChance: number, fireRate: number) => weapon({ impact: 100, statusChance: 1, critChance, fireRate, magazineSize: 1_000_000 });

test('Hunter Munitions + Internal Bleeding: one Slash proc per hit, so Internal Bleeding only adds 0.35 x (1 - 0.3) (wiki: 54.5% in all)', () => {
  // Wiki (Internal Bleeding, notes): a crit that also procs Impact lands Slash 54.5% of the time at 2.5+ shots/s,
  // 30% from Hunter Munitions, so Internal Bleeding's own share is 54.5% - 30% = 24.5%.
  close(resolve([critImpactRifle(1, 3)], [internalBleeding(), hunterMunitions()], {}).impactProcs.slash ?? 0, 0.245);
});

test('Hunter Munitions + Internal Bleeding below 2.5 shots/s: 0.7 x (1 - 0.3) = 0.49 (wiki: 79% in all)', () => {
  close(resolve([critImpactRifle(1, 2)], [internalBleeding(), hunterMunitions()], {}).impactProcs.slash ?? 0, 0.49);
});

test('Hunter Munitions only overlaps on crits: at 50% crit, 0.7 x (1 - 0.5 x 0.3) = 0.595', () => {
  close(resolve([critImpactRifle(0.5, 2)], [internalBleeding(), hunterMunitions()], {}).impactProcs.slash ?? 0, 0.595);
});

test('Hunter Munitions never procs without crits, so Internal Bleeding keeps its full 70%', () => {
  close(resolve([critImpactRifle(0, 2)], [internalBleeding(), hunterMunitions()], {}).impactProcs.slash ?? 0, 0.7);
});

test('crit chance above 100% caps the overlap at Hunter Munitions\' 30% (0.7 x 0.7 = 0.49)', () => {
  close(resolve([critImpactRifle(2, 2)], [internalBleeding(), hunterMunitions()], {}).impactProcs.slash ?? 0, 0.49);
});

// ------------------------------------------------------------- throwing (glaives)

/** A glaive: 100 Impact swings, a 200 Impact throw and a 400 Impact charged throw. */
const glaive = () => {
  const base = weapon({ impact: 100 }, { category: 'melee', type: 'Melee', modClasses: ['Melee'] });
  return {
    ...base,
    modes: [
      { name: 'Normal Attack', stats: base.stats, trigger: null },
      { name: 'Throw', stats: { ...base.stats, impact: 200 }, trigger: 'Thrown' },
      { name: 'Charged Throw', stats: { ...base.stats, impact: 400 }, trigger: 'Thrown' },
    ],
  } as WeaponData;
};
const powerThrow = () => mod('Power Throw', 5, ['+2 Punch Through', 'On Consecutive throw (Max stacks 3):', '+100% Throw Damage'], { classes: ['Thrown Melee'] });

test('throwing: a glaive fires its throw (200)', () => {
  close(resolve([glaive()], [], { mods: [], conditions: { throwing: true } }).damage.projectileTotal, 200);
});

test('throwing with a heavy attack fires the charged throw (400)', () => {
  close(resolve([glaive()], [], { mods: [], heavyAttack: true, conditions: { throwing: true } }).damage.projectileTotal, 400);
});

test('throwing: an attack named in the build wins over the switch (Normal Attack: 100)', () => {
  close(resolve([glaive()], [], { mods: [], mode: 'Normal Attack', conditions: { throwing: true } }).damage.projectileTotal, 100);
});

test('throwing a weapon without a throw warns and keeps its attack', () => {
  const resolved = resolve([rifle()], [], { mods: [], conditions: { throwing: true } });
  assert.deepEqual([resolved.damage.projectileTotal, resolved.warnings], [100, ['Test Weapon has no throw attack; "throwing" ignored']]);
});

test('Power Throw: 3 consecutive throws are +300% throw damage (200 x 4 = 800)', () => {
  close(resolve([glaive()], [powerThrow()], { conditions: { throwing: true, consecutiveThrow: 3 } }).damage.projectileTotal, 800);
});

test('Power Throw: more consecutive throws stop at the 3-stack cap (800)', () => {
  close(resolve([glaive()], [powerThrow()], { conditions: { throwing: true, consecutiveThrow: 10 } }).damage.projectileTotal, 800);
});

test('Power Throw does nothing to a melee swing, and says it needs throws', () => {
  const resolved = resolve([glaive()], [powerThrow()], { conditions: { consecutiveThrow: 3 } });
  assert.deepEqual([resolved.damage.projectileTotal, resolved.inactiveConditions], [100, ['Power Throw: +100% Throw Damage (throws only: tick "throwing")']]);
});

test('max stacks never assume throwing: Power Throw stays off on the swing (100)', () => {
  close(resolve([glaive()], [powerThrow()], { stackMode: 'max' }).damage.projectileTotal, 100);
});

test('max stacks with throwing ticked: the throw at 3 Power Throw stacks (800)', () => {
  close(resolve([glaive()], [powerThrow()], { stackMode: 'max', conditions: { throwing: true } }).damage.projectileTotal, 800);
});

test('a Thrown Melee mod fits a weapon with a throw and warns on one without', () => {
  const rifleWarnings = resolve([rifle()], [powerThrow()], {}).warnings;
  const glaiveWarnings = resolve([glaive()], [powerThrow()], { conditions: { throwing: true } }).warnings;
  assert.deepEqual([glaiveWarnings, rifleWarnings], [[], ['Power Throw does not fit a Rifle (Rifle)']]);
});
