/**
 * Test builders shared by the unit tests: a synthetic weapon, a mod whose effects come from the
 * real text parser, and a minimal snapshot around them. Each test builds its own copies.
 */
import assert from 'node:assert/strict';
import { parseModEffects } from '../src/mods/parse.ts';
import type { AbilityData, ArcaneData, EnemyData, ModData, Snapshot, WeaponData, WeaponStats } from '../src/types.ts';

export const close = (actual: number, expected: number, tolerance = 1e-6) =>
  assert.ok(Math.abs(actual - expected) <= tolerance * Math.max(1, Math.abs(expected)), `${actual} != ${expected}`);

export function stats(overrides: Partial<WeaponStats> = {}): WeaponStats {
  const base: WeaponStats = {
    impact: 0, puncture: 0, slash: 0, heat: 0, cold: 0, electricity: 0, toxin: 0,
    blast: 0, corrosive: 0, gas: 0, magnetic: 0, radiation: 0, viral: 0, true: 0, void: 0, tau: 0,
    critChance: 0.2, critMultiplier: 2, statusChance: 0.1, fireRate: 2, multishot: 1,
    magazineSize: 10, reloadTime: 1,
  };
  return { ...base, ...overrides };
}

/** A plain rifle named 'Test Weapon'; `data` overrides any other field (name, type, modClasses...). */
export function weapon(overrides: Partial<WeaponStats> = {}, data: Partial<WeaponData> = {}): WeaponData {
  return {
    id: 'Test Weapon',
    name: 'Test Weapon',
    category: 'primary',
    type: 'Rifle',
    masteryRank: 0,
    disposition: 1,
    dispositionMultiplier: 1,
    polarities: [],
    exilusPolarity: null,
    modClasses: ['Rifle'],
    stats: stats(overrides),
    modes: [],
    hasRivenSlot: true,
    ...data,
  };
}

/** Builds a ModData whose effects come from the real text parser, so the parser is under test too. */
export function mod(name: string, maxRank: number, topRankStats: string[], overrides: Partial<ModData> = {}): ModData {
  const { effects } = parseModEffects([topRankStats]);
  return {
    id: name,
    name,
    category: 'Primary Mod',
    classes: ['Rifle'],
    polarity: 'madurai',
    rarity: 'Rare',
    baseDrain: 4,
    maxRank,
    description: topRankStats.join('\n'),
    effects,
    cardImage: null,
    partial: false,
    outOfScopeLines: [],
    incompatible: [],
    set: null,
    upgradeTypes: [],
    isAugment: false,
    isRiven: false,
    conclave: false,
    ...overrides,
  };
}

export function snapshot(
  weapons: WeaponData[],
  mods: ModData[],
  enemies: EnemyData[] = [],
  extras: { abilities?: AbilityData[]; arcanes?: ArcaneData[] } = {},
): Snapshot {
  const byName = <T extends { name: string }>(items: T[]) => Object.fromEntries(items.map((i) => [i.name, i]));
  return {
    version: 1,
    generatedAt: '',
    gameVersion: '',
    weapons: byName(weapons),
    mods: byName(mods),
    arcanes: byName(extras.arcanes ?? []),
    warframes: {},
    // Abilities are keyed by ability name (AbilityData has no `name` field).
    abilities: Object.fromEntries((extras.abilities ?? []).map((a) => [a.ability, a])),
    enemies: byName(enemies),
    // Damage 3.0 (Update 36): one table per faction health class.
    // Grineer: Impact and Corrosive +50. Orokin: Puncture/Viral +50, Radiation -50.
    // Overguard: Void +50 and neutral to everything else.
    modifiers: {
      corrosive: { Grineer: 50 },
      radiation: { Grineer: 0, Orokin: -50 },
      puncture: { Orokin: 50 },
      void: { Overguard: 50 },
    },
    healthTypes: { 'Alloy Armor': 'armor', 'Cloned Flesh': 'health' },
    incarnons: {},
    setBonuses: {
      'Sacrificial Set': {
        set: 'Sacrificial Set', kind: 'amplify', description: 'enhances all equipped mods',
        amplify: { '2': { '*': 0.25 } },
      },
    },
    rivenStats: {
      rifle: { Damage: 1.65, Multishot: 0.9, 'Critical Chance': 1.4999, 'Critical Damage': 1.19997, Zoom: 0.5999 },
      shotgun: { Damage: 1.647 },
      pistol: { Damage: 2.196 },
      archgun: { Damage: 0.999 },
      melee: { Damage: 1.647 },
    },
  };
}
