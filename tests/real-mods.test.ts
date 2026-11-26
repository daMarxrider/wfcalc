/**
 * Real mods from the shipped snapshot: what a data update must not silently change.
 *
 * 1. Card values: each mod's parsed effects at max rank, written out by hand from the wiki card
 *    (wiki.warframe.com, mod pages). A data refresh that changes one of these is either a game
 *    change (update the line here on purpose) or a parser regression.
 * 2. Real mods on real weapons: the conditional and special mechanics resolve as the wiki says.
 * 3. Snapshot invariants: properties every mod in the data must keep.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { augmentFits, loadSnapshot, modsForWeapon } from '../src/data.ts';
import { resolveBuild, type Build } from '../src/engine/build.ts';
import { arcaneEffectsAt } from '../src/engine/arcanes.ts';
import { parseModEffects } from '../src/mods/parse.ts';
import type { Effect, ModData, Snapshot, WeaponData } from '../src/types.ts';
import { close } from './builders.ts';

const snap = loadSnapshot();
const modNamed = (name: string): ModData => {
  const found = Object.values(snap.mods).find((mod) => mod.name === name);
  assert.ok(found, `mod ${name} is missing from the snapshot`);
  return found;
};

/** One effect as a short line: "critChance +1.35 onWeakPointHit+aiming", "multishot +0.3 onKill x5". */
const line = (effect: Effect): string => [
  effect.target + (effect.element ? `:${effect.element}` : '') + (effect.faction ? `:${effect.faction}` : ''),
  `${effect.value >= 0 ? '+' : ''}${Number(effect.value.toFixed(4))}`,
  effect.condition,
  effect.maxStacks && effect.maxStacks > 1 ? `x${effect.maxStacks}` : undefined,
  effect.perStatusType ? 'perStatus' : undefined,
  effect.scalesWithCombo ? 'combo' : undefined,
  effect.doublesForBows ? 'x2bows' : undefined,
  effect.flat ? 'flat' : undefined,
].filter(Boolean).join(' ');
const cardOf = (name: string): string[] => modNamed(name).effects.map(line);

// ------------------------------------------------------------------ 1. card values

/** Max-rank card values from the wiki, one line per stat. */
const CARDS: Array<[string, string[]]> = [
  // Plain damage, crit, multishot and status mods.
  ['Serration', ['baseDamage +1.65']],
  ['Amalgam Serration', ['baseDamage +1.55']],
  ['Heavy Caliber', ['baseDamage +1.65', 'accuracy -0.55']],
  ['Split Chamber', ['multishot +0.9']],
  ['Vigilante Armaments', ['multishot +0.6']],
  ['Point Strike', ['critChance +1.5']],
  ['Vital Sense', ['critDamage +1.2']],
  ['Rifle Aptitude', ['statusChance +0.9']],
  ['Hunter Track', ['statusDuration +0.9']],
  ['Point Blank', ['baseDamage +0.9']],
  ['Primed Point Blank', ['baseDamage +1.65']],
  ['Shotgun Savvy', ['statusChance +0.9']],
  ['Pistol Gambit', ['critChance +1.2']],
  ['Primed Pistol Gambit', ['critChance +1.87']],
  ['Target Cracker', ['critDamage +0.6']],
  ['Primed Target Cracker', ['critDamage +1.1']],
  ['Lethal Torrent', ['fireRate +0.6', 'multishot +0.6']],
  ['Pressure Point', ['baseDamage +1.2']],
  ['Primed Pressure Point', ['baseDamage +1.65']],
  ['Organ Shatter', ['critDamage +0.9']],
  ['Gladiator Might', ['critDamage +0.6']],
  // Drawback mods: the malus is part of the card.
  ['Vile Acceleration', ['fireRate +0.9 x2bows', 'baseDamage -0.15']],
  ['Critical Delay', ['critChance +2', 'fireRate -0.2 x2bows']],
  ['Creeping Bullseye', ['critChance +2', 'fireRate -0.2']],
  ['Hollow Point', ['critDamage +0.6', 'baseDamage -0.15']],
  ['Magnum Force', ['baseDamage +1.65', 'accuracy -0.55']],
  ['Spoiled Strike', ['baseDamage +1', 'fireRate -0.2']],
  ['Tainted Mag', ['magazine +0.66', 'reloadSpeed -0.33']],
  ['Depleted Reload', ['magazine -0.6', 'reloadSpeed +0.48']],
  // Elements, physical types and factions.
  ['Hellfire', ['element:heat +0.9']],
  ['Fever Strike', ['element:toxin +0.9']],
  ['Primed Fever Strike', ['element:toxin +1.65']],
  ['Thermite Rounds', ['element:heat +0.6', 'statusChance +0.6']],
  ['Toxic Barrage', ['element:toxin +0.6', 'statusChance +0.6']],
  ['Blaze', ['baseDamage +0.6', 'element:heat +0.6']],
  ['Rupture', ['element:impact +0.9']],
  ['Crash Course', ['element:impact +1.2']],
  ['Fanged Fusillade', ['element:slash +1.2']],
  ['Primed Bane of Grineer', ['factionDamage:grineer +0.55']],
  ['Sacrificial Steel', ['critChance +2.2', 'factionDamage:sentient +0.33']],
  // Fire rate and flat stats.
  ['Vigilante Fervor', ['fireRate +0.45 x2bows']],
  ['Shred', ['fireRate +0.3 x2bows', 'punchThrough +1.2 flat']],
  ['Primed Shred', ['fireRate +0.55 x2bows', 'punchThrough +2.2 flat']],
  // Forced procs.
  ['Hunter Munitions', ['forcedProc:slash +0.3']],
  // Combo and status-type scaling.
  ['Blood Rush', ['critChance +0.4 combo']],
  ['Weeping Wounds', ['statusChance +0.4 combo']],
  ['Condition Overload', ['baseDamage +0.8 perStatus']],
  // On-kill stacks (Galvanized).
  ['Galvanized Chamber', ['multishot +0.8', 'multishot +0.3 onKill x5']],
  ['Galvanized Diffusion', ['multishot +1.1', 'multishot +0.3 onKill x4']],
  ['Galvanized Hell', ['multishot +1.1', 'multishot +0.3 onKill x4']],
  ['Galvanized Aptitude', ['statusChance +0.8', 'directDamage +0.4 onKill x2 perStatus']],
  ['Galvanized Savvy', ['statusChance +0.8', 'directDamage +0.4 onKill x2 perStatus']],
  ['Galvanized Shot', ['statusChance +0.8', 'directDamage +0.4 onKill x3 perStatus']],
  ['Galvanized Steel', ['critChance +1.1', 'critDamage +0.3 onKill x4']],
  ['Galvanized Elementalist', ['statusDamage +0.8', 'statusChance +0.3 onKill x4']],
  ['Berserker Fury', ['fireRate +0.35 onKill x2']],
  // Aiming, weak points and their combinations.
  ['Argon Scope', ['critChance +1.35 onWeakPointHit+aiming']],
  ['Hydraulic Crosshairs', ['critChance +1.35 onWeakPointHit+aiming']],
  ['Laser Sight', ['critChance +1.2 onWeakPointHit+aiming']],
  ['Galvanized Scope', ['critChance +1.2 onWeakPointHit+aiming', 'critChance +0.4 onWeakPointKill+aiming x5']],
  ['Galvanized Crosshairs', ['critChance +1.2 onWeakPointHit+aiming', 'critChance +0.4 onWeakPointKill+aiming x5']],
  ['Bladed Rounds', ['critDamage +1.2 onKill+aiming']],
  ['Sharpened Bullets', ['critDamage +0.75 onKill+aiming']],
  ['Shrapnel Shot', ['critDamage +0.99 onKill+aiming']],
  ['Critical Focus', ['critChance +0.6 aiming', 'critDamage +0.6 aiming']],
  ['Lasting Purity', ['baseDamage +0.6 aiming']],
  ['Catalyzer Link', ['statusChance +0.6 onAbilityCast+aiming']],
  ['Spring-Loaded Chamber', ['fireRate +0.75 onReload+aiming']],
  ['Repeater Clip', ['fireRate +1.05 onReload+aiming']],
  ['Pressurized Magazine', ['fireRate +0.9 onReload+aiming']],
  // Reloads and the first shot of a magazine.
  ['Deadly Efficiency', ['baseDamage +1.2 onReloadEmpty']],
  ['Primed Deadly Efficiency', ['baseDamage +2.2 onReloadEmpty']],
  ['Primed Chamber', ['baseDamage +1 firstShot']],
  ['Charged Chamber', ['baseDamage +0.4 firstShot']],
  ['Primed Charged Chamber', ['baseDamage +1.1 firstShot']],
  ['Kill Switch', ['reloadSpeed +0.5 onKill']],
  ['Power Throw', ['punchThrough +2 flat', 'throwDamage +1 consecutiveThrow x3']],
  // A proc per Impact proc (x2 below 2.5 fire rate, applied by the engine).
  ['Internal Bleeding', ['impactProc:slash +0.35']],
  ['Hemorrhage', ['impactProc:slash +0.35']],
  ['Magnetic Welt', ['impactProc:magnetic +0.35']],
];

for (const [name, expected] of CARDS) {
  test(`card: ${name} reads ${expected.join(', ')}`, () => {
    assert.deepEqual(cardOf(name), expected);
  });
}

/** Max-rank arcane values from the wiki, one line per stat ("flat" for crit added to the final chance). */
const ARCANE_CARDS: Array<[string, string[]]> = [
  ['Primary Merciless', ['baseDamage +0.3 onKill x12', 'reloadSpeed +0.3']],
  ['Secondary Merciless', ['baseDamage +0.3 onKill x12', 'reloadSpeed +0.3']],
  ['Primary Deadhead', ['baseDamage +1.2 onWeakPointKill x3', 'headshotMultiplier +0.3', 'recoil -0.5']],
  ['Secondary Deadhead', ['baseDamage +1.2 onWeakPointKill x3', 'headshotMultiplier +0.3', 'recoil -0.5']],
  ['Primary Blight', ['critDamage +0.036 on_toxin_status_effect x40', 'multishot +0.018 on_toxin_status_effect x40']],
  ['Arcane Avenger', ['critChance +0.45 on_damaged']],
  ['Arcane Fury', ['baseDamage +1.8 on_critical_hit']],
  ['Arcane Strike', ['fireRate +0.6 onHit']],
  ['Arcane Rage', ['baseDamage +1.8 onWeakPointHit']],
  ['Arcane Acceleration', ['fireRate +0.9 on_critical_hit']],
  ['Arcane Velocity', ['fireRate +1.2 on_critical_hit']],
  ['Arcane Precision', ['baseDamage +3 onWeakPointHit']],
  ['Arcane Tempo', ['fireRate +0.9 on_critical_hit']],
  ['Arcane Momentum', ['reloadSpeed +1.5 on_critical_hit']],
  ['Molt Augmented', ['abilityStrength +0.0024 onKill x250']],
];

for (const [name, expected] of ARCANE_CARDS) {
  test(`arcane card: ${name} reads ${expected.join(', ')}`, () => {
    const arcane = snap.arcanes[name];
    assert.ok(arcane, `arcane ${name} is missing from the snapshot`);
    assert.deepEqual(arcaneEffectsAt(arcane, undefined).map(line), expected);
  });
}

// ------------------------------------------------------------------ 2. real mods on real weapons

/** Resolves a real build from the snapshot. */
const resolve = (build: Build) => resolveBuild(snap, build);

test('Galvanized Chamber on Soma Prime at max stacks: multishot 1 x (1 + 0.8 + 5 x 0.3) = 3.3', () => {
  close(resolve({ weapon: 'Soma Prime', mods: ['Galvanized Chamber'], stackMode: 'max' }).multishot, 3.3);
});

test('Galvanized Chamber on Soma Prime with no kills: only the +80% passive', () => {
  close(resolve({ weapon: 'Soma Prime', mods: ['Galvanized Chamber'] }).multishot, 1.8);
});

test('Split Chamber on Hek: 7 pellets x 1.9 = 13.3', () => {
  close(resolve({ weapon: 'Hek', mods: ['Split Chamber'] }).multishot, 13.3);
});

test('Primed Chamber on Rubico Prime at max: the first of 5 shots doubles, +20% a shot on average', () => {
  const plain = resolve({ weapon: 'Rubico Prime', mods: [] }).damage.projectileTotal;
  close(resolve({ weapon: 'Rubico Prime', mods: ['Primed Chamber'], stackMode: 'max' }).damage.projectileTotal / plain, 1.2);
});

test('Primed Chamber on Vectis Prime at max: the first of 2 shots doubles, +50% a shot on average', () => {
  const plain = resolve({ weapon: 'Vectis Prime', mods: [] }).damage.projectileTotal;
  close(resolve({ weapon: 'Vectis Prime', mods: ['Primed Chamber'], stackMode: 'max' }).damage.projectileTotal / plain, 1.5);
});

test('Bladed Rounds on Soma Prime at max without aiming: no crit damage bonus', () => {
  const plain = resolve({ weapon: 'Soma Prime', mods: [] }).critMultiplier;
  close(resolve({ weapon: 'Soma Prime', mods: ['Bladed Rounds'], stackMode: 'max' }).critMultiplier, plain);
});

test('Bladed Rounds on Soma Prime at max while aiming: crit multiplier x 2.2', () => {
  const plain = resolve({ weapon: 'Soma Prime', mods: [] }).critMultiplier;
  close(resolve({ weapon: 'Soma Prime', mods: ['Bladed Rounds'], stackMode: 'max', conditions: { aiming: true } }).critMultiplier / plain, 2.2);
});

test('Argon Scope on Soma Prime at max while aiming: off on body shots', () => {
  const plain = resolve({ weapon: 'Soma Prime', mods: [] }).critChance;
  close(resolve({ weapon: 'Soma Prime', mods: ['Argon Scope'], stackMode: 'max', hit: 'body', conditions: { aiming: true } }).critChance, plain);
});

test('Argon Scope on Soma Prime at max while aiming: crit chance x 2.35 on head shots', () => {
  const plain = resolve({ weapon: 'Soma Prime', mods: [] }).critChance;
  close(resolve({ weapon: 'Soma Prime', mods: ['Argon Scope'], stackMode: 'max', hit: 'head', conditions: { aiming: true } }).critChance / plain, 2.35);
});

test('Hunter Munitions on Soma Prime: a 30% Slash proc on critical hits only', () => {
  const { forcedProcs } = resolve({ weapon: 'Soma Prime', mods: ['Hunter Munitions'] });
  assert.deepEqual(forcedProcs, [{ type: 'slash', chance: 0.3, requiresCrit: true }]);
});

test('Critical Delay on Paris Prime (a bow): fire rate x (1 - 2 x 0.2) = x 0.6', () => {
  const plain = resolve({ weapon: 'Paris Prime', mods: [] }).fireRate;
  close(resolve({ weapon: 'Paris Prime', mods: ['Critical Delay'] }).fireRate / plain, 0.6);
});

test('Critical Delay on Soma Prime (not a bow): fire rate x 0.8', () => {
  const plain = resolve({ weapon: 'Soma Prime', mods: [] }).fireRate;
  close(resolve({ weapon: 'Soma Prime', mods: ['Critical Delay'] }).fireRate / plain, 0.8);
});

test('Primed Bane of Grineer on Soma Prime: +55% against Grineer only', () => {
  assert.deepEqual(resolve({ weapon: 'Soma Prime', mods: ['Primed Bane of Grineer'] }).factionBonus, { grineer: 0.55 });
});

test('Condition Overload on Nikana Prime with 3 status types: melee damage x (1 + 3 x 0.8) = x 3.4', () => {
  const plain = resolve({ weapon: 'Nikana Prime', mods: [], conditions: { statusTypes: 3 } }).damage.projectileTotal;
  close(resolve({ weapon: 'Nikana Prime', mods: ['Condition Overload'], conditions: { statusTypes: 3 } }).damage.projectileTotal / plain, 3.4);
});

test('Blood Rush on Nikana Prime at 12x combo: crit chance x (1 + 0.4 x 11) = x 5.4', () => {
  const plain = resolve({ weapon: 'Nikana Prime', mods: [] }).critChance;
  close(resolve({ weapon: 'Nikana Prime', mods: ['Blood Rush'], comboHits: 220 }).critChance / plain, 5.4);
});

test('Deadly Efficiency on Kuva Ayanga at max: +120% while the 9 s buff covers the magazine cycle', () => {
  // 33 rounds at 4.58/s = 7.2 s of fire + 1.2 s reload = 8.4 s cycle, inside the 9 s buff.
  const plain = resolve({ weapon: 'Kuva Ayanga', mods: [], stackMode: 'max' }).damage.projectileTotal;
  close(resolve({ weapon: 'Kuva Ayanga', mods: ['Deadly Efficiency'], stackMode: 'max' }).damage.projectileTotal / plain, 2.2);
});

test('Serration at rank 0 on Soma Prime: +15% (1/11 of +165%)', () => {
  const plain = resolve({ weapon: 'Soma Prime', mods: [], quantize: false }).damage.projectileTotal;
  close(resolve({ weapon: 'Soma Prime', mods: [{ name: 'Serration', rank: 0 }], quantize: false }).damage.projectileTotal / plain, 1.15);
});

test('Assault Rifle mods fit a plain rifle: Tainted Mag is offered for Soma Prime', () => {
  assert.ok(modsForWeapon(snap, snap.weapons['Soma Prime']).some((mod) => mod.name === 'Tainted Mag'));
});

test('Assault Rifle mods do not fit a sniper: no Tainted Mag for Rubico Prime', () => {
  assert.ok(!modsForWeapon(snap, snap.weapons['Rubico Prime']).some((mod) => mod.name === 'Tainted Mag'));
});

test('Assault Rifle mods do not fit a bow: no Tainted Mag for Paris Prime', () => {
  assert.ok(!modsForWeapon(snap, snap.weapons['Paris Prime']).some((mod) => mod.name === 'Tainted Mag'));
});

test('Tainted Mag on Braton Prime: 75 rounds x 1.66 = 124.5 -> 125, no fit warning (wiki: Tainted Mag)', () => {
  const resolved = resolve({ weapon: 'Braton Prime', mods: ['Tainted Mag'] });
  assert.deepEqual([resolved.magazineSize, resolved.warnings], [125, []]);
});

test('Spring-Loaded Chamber on Soma Prime at max while aiming: +75% fire rate, the 9 s buff outlasting the cycle', () => {
  // Soma Prime: 200 rounds at 15/s = 13.3 s of fire + 3 s reload; the buff covers 9 / 16.3 of it.
  const plain = resolve({ weapon: 'Soma Prime', mods: [], stackMode: 'max', conditions: { aiming: true } }).fireRate;
  const modded = resolve({ weapon: 'Soma Prime', mods: ['Spring-Loaded Chamber'], stackMode: 'max', conditions: { aiming: true } }).fireRate;
  // 9 / 16.333 = 0.55102 uptime x 0.75 = +41.33%.
  close(modded / plain, 1.413265, 1e-4);
});

test('Primary Merciless on Soma Prime, stack mode none: no damage bonus', () => {
  const plain = resolve({ weapon: 'Soma Prime', mods: [] }).damage.projectileTotal;
  close(resolve({ weapon: 'Soma Prime', mods: [], arcanes: ['Primary Merciless'], stackMode: 'none' }).damage.projectileTotal, plain);
});

test('Primary Merciless on Soma Prime, stack mode max: 12 stacks, damage x (1 + 12 x 0.3) = x 4.6', () => {
  const plain = resolve({ weapon: 'Soma Prime', mods: [], quantize: false }).damage.projectileTotal;
  close(resolve({ weapon: 'Soma Prime', mods: [], arcanes: ['Primary Merciless'], stackMode: 'max', quantize: false }).damage.projectileTotal / plain, 4.6);
});

test('Primary Deadhead on Soma Prime, stack mode max: no damage stacks on body shots', () => {
  const plain = resolve({ weapon: 'Soma Prime', mods: [], quantize: false }).damage.projectileTotal;
  close(resolve({ weapon: 'Soma Prime', mods: [], arcanes: ['Primary Deadhead'], stackMode: 'max', hit: 'body', quantize: false }).damage.projectileTotal, plain);
});

test('Primary Deadhead on Soma Prime, stack mode max: 3 stacks on head shots, damage x (1 + 3 x 1.2) = x 4.6', () => {
  const plain = resolve({ weapon: 'Soma Prime', mods: [], quantize: false }).damage.projectileTotal;
  close(resolve({ weapon: 'Soma Prime', mods: [], arcanes: ['Primary Deadhead'], stackMode: 'max', hit: 'head', quantize: false }).damage.projectileTotal / plain, 4.6);
});

test('a secondary arcane on a primary weapon warns that it does not fit and is ignored', () => {
  const resolved = resolve({ weapon: 'Soma Prime', mods: [], arcanes: ['Secondary Merciless'], stackMode: 'max' });
  assert.deepEqual(resolved.warnings, ['Secondary Merciless is a secondary arcane and does not fit a primary weapon; ignored']);
});

test('a secondary arcane on a primary weapon adds no damage', () => {
  const plain = resolve({ weapon: 'Soma Prime', mods: [], stackMode: 'max' }).damage.projectileTotal;
  close(resolve({ weapon: 'Soma Prime', mods: [], arcanes: ['Secondary Merciless'], stackMode: 'max' }).damage.projectileTotal, plain);
});

test('Internal Bleeding on Soma Prime (15 shots/s): a Slash proc on 35% of Impact procs', () => {
  assert.deepEqual(resolve({ weapon: 'Soma Prime', mods: ['Internal Bleeding'] }).impactProcs, { slash: 0.35 });
});

test('Internal Bleeding on Fulmin semi-auto (2.17 shots/s, below 2.5): the chance doubles to 70%', () => {
  assert.deepEqual(resolve({ weapon: 'Fulmin', mods: ['Internal Bleeding'] }).impactProcs, { slash: 0.7 });
});

test('Hemorrhage on Lex Prime (2.08 shots/s): 70% Slash per Impact proc', () => {
  assert.deepEqual(resolve({ weapon: 'Lex Prime', mods: ['Hemorrhage'] }).impactProcs, { slash: 0.7 });
});

test('Magnetic Welt on Hek (2.17 shots/s): 70% Magnetic per Impact proc', () => {
  assert.deepEqual(resolve({ weapon: 'Hek', mods: ['Magnetic Welt'] }).impactProcs, { magnetic: 0.7 });
});

test('Glaive Prime throwing: the Throw attack, 27 + 27 + 126 = 180 per hit', () => {
  close(resolve({ weapon: 'Glaive Prime', mods: [], quantize: false, conditions: { throwing: true } }).damage.projectileTotal, 180);
});

test('Glaive Prime throwing with a heavy attack: the Charged Throw, 54 + 54 + 252 = 360 per hit', () => {
  close(resolve({ weapon: 'Glaive Prime', mods: [], quantize: false, heavyAttack: true, conditions: { throwing: true } }).damage.projectileTotal, 360);
});

test('Glaive Prime throwing with 3 Power Throw stacks: 180 x (1 + 3 x 1.0) = 720', () => {
  close(resolve({ weapon: 'Glaive Prime', mods: ['Power Throw'], quantize: false, conditions: { throwing: true, consecutiveThrow: 3 } }).damage.projectileTotal, 720);
});

test('glaive mods are offered for Glaive Prime (Power Throw), not for a sword (Nikana Prime)', () => {
  const offered = (weapon: string) => modsForWeapon(snap, snap.weapons[weapon]).some((mod) => mod.name === 'Power Throw');
  assert.deepEqual([offered('Glaive Prime'), offered('Nikana Prime')], [true, false]);
});

// ------------------------------------------------------------------ 3. snapshot invariants

/** The first weapon whose mod classes take the class, that fires from a magazine it reloads. */
function weaponFor(snapshot: Snapshot, modClass: string): WeaponData | undefined {
  const wanted = modClass.toLowerCase();
  const takes = (weapon: WeaponData) => weapon.modClasses.some((own) => own.toLowerCase() === wanted) || augmentFits(weapon, modClass);
  return Object.values(snapshot.weapons).find((weapon) => takes(weapon)
    && (weapon.stats.magazineSize ?? 0) > 1 && (weapon.stats.reloadTime ?? 0) > 0 && !weapon.exalted)
    ?? Object.values(snapshot.weapons).find(takes);
}

/** Weapon mods (not Warframe, companion or vehicle mods) that carry at least one conditional effect. */
function conditionalWeaponMods(snapshot: Snapshot): Array<{ mod: ModData; weapon: WeaponData }> {
  return Object.values(snapshot.mods)
    .filter((mod) => mod.effects.some((effect) => effect.condition) && !mod.classes.includes('Warframe'))
    .map((mod) => ({ mod, weapon: mod.classes.map((modClass) => weaponFor(snapshot, modClass)).find(Boolean)! }))
    .filter((entry) => entry.weapon);
}

/** Conditional card lines that the given stack mode leaves off (on), per mod, on a weapon that takes it. */
function conditionalLines(snapshot: Snapshot, state: 'off' | 'on', build: Partial<Build>): string[] {
  return conditionalWeaponMods(snapshot).flatMap(({ mod, weapon }) => {
    const resolved = resolveBuild(snapshot, { weapon: weapon.name, mods: [mod.name], ...build });
    return mod.effects
      .filter((effect) => effect.condition)
      .filter((effect) => resolved.inactiveConditions.some((entry) => entry.startsWith(`${mod.name}: ${effect.raw}`)) === (state === 'off'))
      .map((effect) => `${mod.name} on ${weapon.name}: ${effect.raw}`);
  });
}

test('snapshot: every conditional weapon mod finds a weapon that takes it', () => {
  const orphans = Object.values(snap.mods)
    .filter((mod) => mod.effects.some((effect) => effect.condition) && !mod.classes.includes('Warframe'))
    .filter((mod) => !mod.classes.some((modClass) => weaponFor(snap, modClass)))
    .map((mod) => mod.name);
  assert.deepEqual(orphans, []);
});

test('snapshot: stack mode none turns every conditional effect of every weapon mod off', () => {
  assert.deepEqual(conditionalLines(snap, 'on', { stackMode: 'none' }), []);
});

test('snapshot: stack mode max with every switch on and head hits turns every conditional effect on', () => {
  const allSwitches = { aiming: true, sliding: true, airborne: true, firstShot: true, throwing: true };
  assert.deepEqual(conditionalLines(snap, 'off', { stackMode: 'max', hit: 'head', conditions: allSwitches }), []);
});

test('snapshot: every effect value is a finite, non-zero number', () => {
  const bad = Object.values(snap.mods).flatMap((mod) => mod.effects
    .filter((effect) => !Number.isFinite(effect.value) || effect.value === 0)
    .map((effect) => `${mod.name}: ${effect.raw} = ${effect.value}`));
  assert.deepEqual(bad, []);
});

test('snapshot: every stack cap is a whole number of at least 1', () => {
  const bad = Object.values(snap.mods).flatMap((mod) => mod.effects
    .filter((effect) => effect.maxStacks !== undefined && !(Number.isInteger(effect.maxStacks) && effect.maxStacks >= 1))
    .map((effect) => `${mod.name}: ${effect.raw} caps at ${effect.maxStacks}`));
  assert.deepEqual(bad, []);
});

test('snapshot: every mod has a whole, non-negative max rank', () => {
  const bad = Object.values(snap.mods).filter((mod) => !(Number.isInteger(mod.maxRank) && mod.maxRank >= 0)).map((mod) => `${mod.name}: ${mod.maxRank}`);
  assert.deepEqual(bad, []);
});

test('snapshot: every mod name is unique ignoring letter case', () => {
  const names = Object.values(snap.mods).map((mod) => mod.name.toLowerCase());
  assert.deepEqual(names.filter((name, index) => names.indexOf(name) !== index), []);
});

/**
 * Mods whose stored effects differ from a re-parse of their card text, on purpose:
 * build-data adds rules no stat line states, or the engine computes the effect.
 */
const NOT_FROM_CARD_TEXT: Record<string, string> = {
  'Semi-Pistol Cannonade': 'build-data adds the fire-rate lock and the semi-auto requirement',
  'Semi-Rifle Cannonade': 'build-data adds the fire-rate lock and the semi-auto requirement',
  'Semi-Shotgun Cannonade': 'build-data adds the fire-rate lock and the semi-auto requirement',
  'Necrophagic Vigor': 'the engine computes it from the frame\'s Health (traits.ts necrophagicVigor)',
};

/** Mods whose stored effects are not what the parser reads from their card text today. */
function parserDrift(snapshot: Snapshot): string[] {
  const strip = (effects: Effect[]) => JSON.stringify(effects.map(({ raw: _raw, ...rest }) => rest));
  return Object.values(snapshot.mods)
    .filter((mod) => !(mod.name in NOT_FROM_CARD_TEXT))
    .filter((mod) => strip(parseModEffects([[mod.description]]).effects) !== strip(mod.effects))
    .map((mod) => mod.name);
}

test('snapshot: the parser reads every other mod\'s card text into exactly the stored effects', () => {
  // A parser change that alters any mod shows up here by name; rebuild the snapshot on purpose if the change is right.
  assert.deepEqual(parserDrift(snap), []);
});

test('snapshot: Cannonade mods lock the fire rate and need a semi-auto trigger', () => {
  assert.deepEqual(cardOf('Semi-Rifle Cannonade'), ['baseDamage +2.4', 'punchThrough +1.5 flat', 'fireRateLock +1', 'requiresSemiTrigger +1']);
});

