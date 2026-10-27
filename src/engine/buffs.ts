/**
 * Warframe buffs that change weapon damage.
 *
 * The **numbers** come from the wiki (data/raw/ability-stats.json → snapshot.abilities):
 * max-rank value, scaled by Ability Strength.
 *
 * The **mechanics** — whether a buff multiplies all damage or adds a damage type,
 * and how it interacts with mods — are curated here, because the wikitext describes
 * them in prose. Each entry cites the wiki page it was taken from and the sentence
 * that justifies the modelling choice.
 *
 * Ability Strength is a percentage: 100 = unmodded, 284 = a typical Intensify build.
 */
import type { AbilityData, DamageType, Effect, Snapshot } from '../types.ts';
import type { Conditions } from './build.ts';
import { arcaneEffectsAt } from './arcanes.ts';

/** Extra context a buff needs: buff stacks plus whether the shot is a weak-point hit. */
export interface BuffContext {
  conditions?: Record<string, number | boolean | undefined>;
  headshot?: boolean;
}

export type BuffKind =
  | 'damage' // multiplies total weapon damage (same bucket as Serration)
  | 'faction' // faction damage bonus: multiplicative with damage mods
  | 'element' // adds a damage type worth N% of base damage
  | 'elementMultiplier' // multiplies one existing damage type
  | 'speed' // attack / fire rate
  | 'weakPoint' // multiplies weak-point damage
  | 'flatCrit'; // flat critical chance added after mods

export interface BuffDefinition {
  /** Stable id used by the CLI/UI. */
  id: string;
  /** Ability name as it appears in the snapshot. */
  ability: string;
  kind: BuffKind;
  /** Which damage type the buff adds or multiplies, when relevant. */
  element?: DamageType;
  /** Picks the right number when the infobox lists several stats. */
  pick?: (ability: AbilityData) => number | null;
  /**
   * How to read the number: `percent` means the stat is a bonus ("50%" -> +0.5),
   * `multiplier` means it is a factor ("2.5x" -> x2.5).
   */
  unit?: 'percent' | 'multiplier';
  /** Weaker version of the ability (augment-only, ally-only, ramp-up...). */
  note?: string;
  /** True for augments: only available if that augment mod is equipped. */
  augment?: boolean;
  /**
   * The buff builds up in a fight instead of applying at once (Vex Armor's Fury grows with damage
   * taken). Its effects carry the `buffRamp` condition, so a stack mode of `none` starts it at
   * zero and `max` at its cap; by default it is counted at its maximum.
   */
  ramps?: boolean;
}

/** Reads the first segment whose label contains all the given words. */
const byLabel =
  (...words: string[]) =>
  (ability: AbilityData): number | null => {
    const segment = ability.segments.find((entry) => words.every((word) => entry.label.includes(word)));
    return segment?.max ?? ability.value ?? null;
  };

/** Reads a segment by position, for the infoboxes whose labels got stripped. */
const byIndex =
  (index: number) =>
  (ability: AbilityData): number | null =>
    ability.segments[index]?.max ?? ability.value ?? null;

/**
 * Registry of supported buffs.
 *
 * | Ability | Effect on weapons | Source |
 * |---|---|---|
 * | Roar | +50% damage to all factions, "considered Faction Damage Bonus" | Rhino/Roar |
 * | Eclipse | +200% weapon damage (day side) | Mirage/Eclipse |
 * | Vex Armor | up to +275% weapon damage (Fury, fully charged) | Chroma/Vex_Armor |
 * | Xata's Whisper | adds Void damage worth 26% of base | Xaku/Xata's_Whisper |
 * | Toxic Lash | adds Toxin damage worth 30% to guns | Saryn/Toxic_Lash |
 * | Nourish | adds Viral damage worth 250% of base | Grendel/Nourish |
 * | Shock Trooper | adds 100% Electricity | Volt/Shock_Trooper (augment) |
 * | Freeze Force | adds 100% Cold | Frost/Freeze_Force (augment) |
 * | Fireball Frenzy | adds 100% Heat | Ember/Fireball_Frenzy (augment) |
 * | Smite Infusion | adds 100% Radiation | Oberon/Smite_Infusion (augment) |
 * | Venom Dose | adds 100% Corrosive | Saryn/Venom_Dose (augment) |
 * | Warcry | +50% attack speed | Valkyr/Warcry |
 * | Accelerant | ×2.5 Heat damage taken by affected enemies | Ember/Accelerant |
 * | Sonar | weak points take ×5 damage | Banshee/Sonar |
 * | Resupply | +25% weapon damage | Cyte-09/Resupply |
 */
export const BUFFS: BuffDefinition[] = [
  { id: 'roar', ability: 'Roar', kind: 'faction' },
  { id: 'eclipse', ability: 'Eclipse', kind: 'damage', pick: byLabel('damage', 'bonus'), note: 'day side' },
  { id: 'vex-armor', ability: 'Vex Armor', kind: 'damage', pick: byLabel('fury', 'max'), note: 'Fury at maximum', ramps: true },
  { id: 'xatas-whisper', ability: "Xata's Whisper", kind: 'element', element: 'void' },
  { id: 'toxic-lash', ability: 'Toxic Lash', kind: 'element', element: 'toxin', pick: byLabel('gun') },
  { id: 'nourish', ability: 'Nourish', kind: 'element', element: 'viral', pick: byIndex(3) },
  { id: 'shock-trooper', ability: 'Shock Trooper', kind: 'element', element: 'electricity', augment: true, pick: byLabel('damage') },
  { id: 'freeze-force', ability: 'Freeze Force', kind: 'element', element: 'cold', augment: true, pick: byLabel('damage') },
  { id: 'fireball-frenzy', ability: 'Fireball Frenzy', kind: 'element', element: 'heat', augment: true, pick: byLabel('damage') },
  { id: 'smite-infusion', ability: 'Smite Infusion', kind: 'element', element: 'radiation', augment: true, pick: byLabel('damage') },
  { id: 'venom-dose', ability: 'Venom Dose', kind: 'element', element: 'corrosive', augment: true, pick: byLabel('damage') },
  { id: 'warcry', ability: 'Warcry', kind: 'speed', pick: byLabel('attack', 'speed') },
  { id: 'accelerant', ability: 'Accelerant', kind: 'elementMultiplier', element: 'heat', unit: 'multiplier', pick: byLabel('multiplier') },
  { id: 'sonar', ability: 'Sonar', kind: 'weakPoint', unit: 'multiplier' },
  { id: 'resupply', ability: 'Resupply', kind: 'damage', pick: byLabel('weapon', 'damage') },
  { id: 'amp', ability: 'Amp', kind: 'damage', note: 'minimum roll' },
  { id: 'haste-mote', ability: 'Reservoirs', kind: 'speed', pick: byLabel('fire', 'rate'), note: "Wisp's Haste Mote" },
  { id: 'covenant', ability: 'Covenant', kind: 'flatCrit', pick: byLabel('base', 'critical'), note: 'Retaliation: needs the damage prevented' },
];

export const buffById = (id: string): BuffDefinition | undefined =>
  BUFFS.find((buff) => buff.id === id) ?? BUFFS.find((buff) => buff.ability.toLowerCase() === id.toLowerCase());

/**
 * Turns an active buff into effects, given the caster's Ability Strength.
 * `strength` is a percentage: 100 means unmodded.
 */
export function buffEffects(
  snapshot: Snapshot,
  definition: BuffDefinition,
  strength = 100,
  context: BuffContext = {},
): Effect[] {
  const ability = snapshot.abilities[definition.ability];
  if (!ability) return [];
  const base = definition.pick ? definition.pick(ability) : ability.value;
  if (base === null || base === undefined) return [];

  const scale = strength / 100;
  const isMultiplier = definition.unit === 'multiplier';
  const raw = `${definition.ability} ${base}${isMultiplier ? 'x' : '%'} × ${strength}% strength`;
  // Bonuses are fractions (+50% -> 0.5); multipliers are factors (x2.5 -> 2.5).
  const magnitude = isMultiplier ? base * scale : (base / 100) * scale;
  const value = magnitude;

  switch (definition.kind) {
    case 'damage':
      return [{ target: 'baseDamage', op: 'add', value, raw }];
    case 'faction':
      // Roar is explicitly a faction damage bonus: multiplicative with damage mods.
      return [{ target: 'factionDamage', faction: 'all', op: 'add', value, raw }];
    case 'element':
      return [{ target: 'element', element: definition.element, op: 'add', value, raw }];
    case 'elementMultiplier':
      // "x2.5 Heat damage": the engine applies (1 + value), so pass the bonus part.
      return [{ target: 'elementMultiplier', element: definition.element, op: 'mult', value: Math.max(-1, value - 1), raw }];
    case 'speed':
      return [{ target: 'fireRate', op: 'add', value, raw }];
    case 'weakPoint':
      // Sonar replaces the weak-point multiplier (default x2) with its scaled value.
      return [{ target: 'weakPointOverride', op: 'add', value, raw }];
    case 'flatCrit': {
      // Harrow's Retaliation: 5% base plus 1.5% per 100 damage prevented, x strength, as a
      // FLAT crit chance added after mods. Caps: 50% on body shots, 200% on weak points.
      const perHundred = ability.segments.find((entry) => entry.label.includes('per 100'))?.max ?? 1.5;
      const damagePrevented = Number(context.conditions?.covenantDamage ?? 0);
      const bonus = ((base ?? 5) + perHundred * (damagePrevented / 100)) * (strength / 100);
      const cap = context.headshot ? 200 : 50;
      const capped = Math.min(cap, bonus);
      return [{
        target: 'critChance',
        op: 'flat',
        value: capped / 100,
        raw: `Covenant ${capped.toFixed(0)}% flat crit chance (${damagePrevented} damage prevented, cap ${cap}%)`,
      }];
    }
    default:
      return [];
  }
}

/**
 * Ability Strength from the caster's Warframe mods.
 *
 * Mods add percentages to a base of 100%: Intensify +30% -> 130% strength.
 * Ranks scale like any other mod: `value × (rank+1) / (maxRank+1)`.
 *
 * Not modelled: Umbral set bonuses, Archon Shards, and Helminth invigorations.
 */
export function abilityStrengthFromMods(
  snapshot: Snapshot,
  mods: Array<string | { name: string; rank?: number }>,
  arcanes: Array<string | { name: string; rank?: number }> = [],
  conditions: Conditions = {},
): { strength: number; bonus: number; mods: string[]; warnings: string[] } {
  let bonus = 0;
  const used: string[] = [];
  const warnings: string[] = [];
  // Warframe arcanes can grant Ability Strength too (Molt Augmented: +0.24% per kill x250).
  for (const entry of arcanes) {
    const wanted = typeof entry === 'string' ? entry : entry.name;
    const rank = typeof entry === 'string' ? undefined : entry.rank;
    const arcane = snapshot.arcanes[wanted]
      ?? snapshot.arcanes[Object.keys(snapshot.arcanes).find((key) => key.toLowerCase() === wanted.toLowerCase()) ?? ''];
    if (!arcane) {
      warnings.push(`warframe arcane not found: ${wanted}`);
      continue;
    }
    if (arcane.slot !== 'warframe') {
      warnings.push(`${arcane.name} is a ${arcane.slot} arcane, not a Warframe arcane`);
      continue;
    }
    for (const effect of arcaneEffectsAt(arcane, rank)) {
      if (effect.target !== 'abilityStrength') continue;
      const stacks = effect.condition ? Number(conditions[effect.condition] ?? 0) : 1;
      if (stacks <= 0) continue;
      bonus += effect.value * Math.min(stacks, effect.maxStacks ?? stacks);
    }
    used.push(arcane.name);
  }
  for (const entry of mods) {
    const wanted = typeof entry === 'string' ? entry : entry.name;
    const rank = typeof entry === 'string' ? undefined : entry.rank;
    const mod = snapshot.mods[wanted]
      ?? snapshot.mods[Object.keys(snapshot.mods).find((key) => key.toLowerCase() === wanted.toLowerCase()) ?? ''];
    if (!mod) {
      warnings.push(`warframe mod not found: ${wanted}`);
      continue;
    }
    const rankFraction = rank === undefined || mod.maxRank <= 0 ? 1 : Math.max(0, Math.min(1, (rank + 1) / (mod.maxRank + 1)));
    for (const effect of mod.effects) {
      if (effect.target === 'abilityStrength') bonus += effect.value * rankFraction;
    }
    used.push(mod.name);
  }
  return { strength: 100 * (1 + bonus), bonus, mods: used, warnings };
}

/** Every buff that is currently available, for CLI/UI listings. */
export function availableBuffs(
  snapshot: Snapshot,
): Array<{ id: string; ability: string; frame: string; augments: boolean; subsumable: boolean }> {
  return BUFFS.filter((buff) => snapshot.abilities[buff.ability]).map((buff) => ({
    id: buff.id,
    ability: buff.ability,
    frame: snapshot.abilities[buff.ability].frame,
    augments: Boolean(buff.augment),
    // Helminth: a subsumable ability can be carried by any frame.
    subsumable: Boolean(snapshot.abilities[buff.ability].subsumable),
  }));
}
