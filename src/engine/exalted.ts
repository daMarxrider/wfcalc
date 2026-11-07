/**
 * Exalted weapons: how Ability Strength and the Warframe's augments change them.
 *
 * The snapshot stores each weapon at its ability's max rank and 100% Ability Strength
 * (tools/build-exalted.ts). The ability pages on wiki.warframe.com give three strength rules:
 *   - `linear`: base damage x Ability Strength (Exalted Blade, Artemis Bow, Whipclaw, ...).
 *   - `additive`: a rank multiplier x Ability Strength that adds to Serration-type mods
 *     (Neutralize, Exalted Solo: "damage multiplier is additive to base damage mods").
 *   - Peacemaker: 50 fixed base damage with an innate +150% x Ability Strength bonus in the same
 *     pool ("1 + 1.5 x Ability Strength + Damage Mods").
 * Only damage scales; crit, status and fire rate do not.
 */
import { normalizeName } from '../data.ts';
import type { DamageType, Effect, WeaponData } from '../types.ts';

type StrengthRule = 'linear' | { perStrength: number; offset: number };

/** Weapon family (the wiki's `Family`) -> its ability, the frame that casts it, and its rule. */
export const EXALTED: Record<string, { ability: string; frame: string; strength: StrengthRule; arcanes?: boolean }> = {
  'Artemis Bow': { ability: 'Artemis Bow', frame: 'Ivara', strength: 'linear' },
  Lizzie: { ability: 'Exalted Solo', frame: 'Temple', strength: { perStrength: 1.25, offset: -1 } },
  Neutralizer: { ability: 'Neutralize', frame: 'Cyte-09', strength: { perStrength: 1.25, offset: -1 } },
  'Balefire Charger': { ability: 'Balefire', frame: 'Hildryn', strength: 'linear' },
  'Dex Pixia': { ability: 'Razorwing', frame: 'Titania', strength: 'linear' },
  Glory: { ability: 'Glory on High', frame: 'Jade', strength: 'linear' },
  Noctua: { ability: 'Noctua', frame: 'Dante', strength: 'linear' },
  // Regulators take secondary arcanes (wiki: Peacemaker), the other exalted weapons none.
  Regulators: { ability: 'Peacemaker', frame: 'Mesa', strength: { perStrength: 1.5, offset: 0 }, arcanes: true },
  'Desert Wind': { ability: 'Serene Storm', frame: 'Baruuk', strength: 'linear' },
  Diwata: { ability: 'Razorwing', frame: 'Titania', strength: 'linear' },
  'Exalted Blade': { ability: 'Exalted Blade', frame: 'Excalibur', strength: 'linear' },
  'Iron Staff': { ability: 'Primal Fury', frame: 'Wukong', strength: 'linear' },
  'Landslide Fists': { ability: 'Landslide', frame: 'Atlas', strength: 'linear' },
  'Shadow Claws': { ability: 'Exalted Shadow', frame: 'Sevagoth', strength: 'linear' },
  'Shadow Clones': { ability: 'Blade Storm', frame: 'Ash', strength: 'linear' },
  'Shattered Lash': { ability: 'Shattered Lash', frame: 'Gara', strength: 'linear' },
  'Valkyr Talons': { ability: 'Hysteria', frame: 'Valkyr', strength: 'linear' },
  Whipclaw: { ability: 'Whipclaw', frame: 'Khora', strength: 'linear' },
};

/**
 * Augments that change an exalted weapon's damage, values per mod rank 0..3 (wiki mod pages).
 * Every other augment is accepted as a frame mod and does nothing to weapon damage.
 */
export const EXALTED_AUGMENTS: Record<string, { family: string; ranks: number[]; text: string }> = {
  // Status chance bonus x Ability Strength, additive with status mods; physical damage of normal
  // attacks becomes the element of the emissive colour (slams keep theirs).
  'Chromatic Blade': { family: 'Exalted Blade', ranks: [1, 2, 2.5, 3], text: 'Status Chance x Ability Strength' },
  // Crit chance per kill x Ability Strength, additive with crit mods, capped at +150%.
  'Primal Rage': { family: 'Iron Staff', ranks: [0.08, 0.1, 0.12, 0.15], text: 'Critical Chance per kill x Ability Strength' },
  // Per stack (one per Whipclaw hitting 3+ enemies), up to 10, additive with Ability Strength.
  'Accumulating Whipclaw': { family: 'Whipclaw', ranks: [0.1, 0.15, 0.2, 0.35], text: 'Damage per stack, adds to Ability Strength' },
  // Above 1400 Rubble: x2 damage, "equivalent to +100% Ability Strength" (additive with it).
  'Rubble Heap': { family: 'Landslide Fists', ranks: [0.25, 0.5, 0.75, 1], text: 'Damage, adds to Ability Strength' },
  // Single arrow, +25% base crit on a full charge: the wiki's own "Concentrated Arrow" fire modes.
  'Concentrated Arrow': { family: 'Artemis Bow', ranks: [0, 0, 0, 0], text: 'fires the Concentrated Arrow modes' },
};

/** What the UI shows for an exalted weapon: its ability, frame and the augments that change it. */
export function exaltedInfo(weapon: WeaponData): { frame: string; ability: string; arcanes: boolean; augments: Array<{ name: string; text: string }> } | null {
  const rule = weapon.exalted && EXALTED[weapon.exalted.family];
  if (!rule) return null;
  const augments = Object.entries(EXALTED_AUGMENTS)
    .filter(([, augment]) => augment.family === weapon.exalted?.family)
    .map(([name, augment]) => ({ name, text: augment.text }));
  return { frame: rule.frame, ability: rule.ability, arcanes: Boolean(rule.arcanes), augments };
}

/**
 * Peacemaker's ramp (wiki): bursts of 2 shots, +7.5% total damage per burst (the first burst
 * included) up to +150% at the 20th, multiplicative with everything else; fire rate climbs from
 * 25% to 100% over 3.5 s of firing. The build's stats are the fully ramped ones; the fight
 * simulation starts from the first burst.
 */
export const PEACEMAKER_RAMP = { perBurst: 0.075, bursts: 20, shotsPerBurst: 2, rateStart: 0.25, rateSeconds: 3.5 };
const PEACEMAKER_FULL = 1 + PEACEMAKER_RAMP.perBurst * PEACEMAKER_RAMP.bursts;
export const isPeacemaker = (weapon: WeaponData): boolean => weapon.exalted?.family === 'Regulators';
/** Share of the fully ramped damage after `shots` shots. */
export const peacemakerDamageShare = (shots: number): number =>
  (1 + PEACEMAKER_RAMP.perBurst * Math.min(PEACEMAKER_RAMP.bursts, Math.floor(shots / PEACEMAKER_RAMP.shotsPerBurst) + 1)) / PEACEMAKER_FULL;
/** Share of the full fire rate after `seconds` of firing (shortcut: linear climb, the wiki gives only the ends). */
export const peacemakerRateShare = (seconds: number): number =>
  PEACEMAKER_RAMP.rateStart + (1 - PEACEMAKER_RAMP.rateStart) * Math.min(1, seconds / PEACEMAKER_RAMP.rateSeconds);

export const CHROMATIC_ELEMENTS = ['heat', 'cold', 'electricity', 'toxin'] as const;
export type ChromaticElement = (typeof CHROMATIC_ELEMENTS)[number];

const WHIPCLAW_STACKS = 10;
const PRIMAL_RAGE_CAP = 1.5;

type FrameMod = string | { name: string; rank?: number };

/** Equipped augments of this weapon's family, with their value at the equipped rank. */
function augmentsFor(weapon: WeaponData, frameMods: FrameMod[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const entry of frameMods) {
    const name = typeof entry === 'string' ? entry : entry.name;
    const augment = Object.entries(EXALTED_AUGMENTS).find(([key]) => normalizeName(key) === normalizeName(name ?? ''));
    if (!augment || augment[1].family !== weapon.exalted?.family) continue;
    const rank = typeof entry === 'string' || entry.rank === undefined ? 3 : Math.max(0, Math.min(3, Math.round(entry.rank)));
    out.set(augment[0], augment[1].ranks[rank]);
  }
  return out;
}

/** The fire mode an augment switches the weapon to, when the player did not pick one. */
export function exaltedDefaultMode(weapon: WeaponData, frameMods: FrameMod[] = []): string | undefined {
  if (!weapon.exalted) return undefined;
  return augmentsFor(weapon, frameMods).has('Concentrated Arrow') ? 'Concentrated Arrow Charged Shot' : undefined;
}

export interface ExaltedSetup {
  /** Factor on the weapon's base damage (linear rule; 1 otherwise). */
  scale: number;
  /** Effects that join the mod pools, one source each. */
  sources: Array<{ name: string; effects: Effect[]; ramps?: boolean }>;
  /** Element the physical damage of this attack becomes (Chromatic Blade). */
  element: DamageType | null;
  /** Archon Continuity on the frame: every Toxin proc also procs Corrosive. */
  continuity: boolean;
  /** Archon Vitality on the frame: every Heat proc adds one more Heat proc. */
  vitality: boolean;
  lines: string[];
  warnings: string[];
}

export function exaltedSetup(
  weapon: WeaponData,
  options: { strength: number; frameMods?: FrameMod[]; frame?: string; modeName?: string | null; chromaticElement?: ChromaticElement; stackMode?: string },
): ExaltedSetup | null {
  if (!weapon.exalted) return null;
  const rule = EXALTED[weapon.exalted.family];
  const setup: ExaltedSetup = { scale: 1, sources: [], element: null, continuity: false, vitality: false, lines: [], warnings: [] };
  // Archon mods (wiki notes): "All Exalted Weapons when modded with Toxin" (Continuity) / "with
  // Heat" (Vitality). Every exalted weapon is one; the effect does not scale with mod rank.
  const frameModNames = (options.frameMods ?? []).map((entry) => normalizeName(typeof entry === 'string' ? entry : entry.name ?? ''));
  setup.continuity = frameModNames.includes(normalizeName('Archon Continuity'));
  setup.vitality = frameModNames.includes(normalizeName('Archon Vitality'));
  if (setup.continuity) setup.lines.push('Archon Continuity: every Toxin proc also procs Corrosive');
  if (setup.vitality) setup.lines.push('Archon Vitality: every Heat proc adds a second Heat proc');
  if (!rule) {
    setup.warnings.push(`${weapon.name}: no Ability Strength rule for this exalted weapon; stats used at 100%`);
    return setup;
  }
  const strength = options.strength / 100;
  const frameName = normalizeName(options.frame ?? '');
  if (frameName && !frameName.startsWith(normalizeName(rule.frame))) {
    setup.warnings.push(`${weapon.name} belongs to ${rule.frame}'s ${rule.ability}, not ${options.frame}`);
  }
  const augments = augmentsFor(weapon, options.frameMods ?? []);
  setup.lines.push(`Exalted: ${rule.frame}'s ${rule.ability}, max rank, ${options.strength.toFixed(0)}% Ability Strength`);
  if (weapon.exalted.fixedRate) setup.lines.push('Ability cast: attack speed mods do nothing (wiki)');

  if (rule.strength === 'linear') {
    // Augments that add to Ability Strength for this one ability.
    let added = 0;
    const rubble = augments.get('Rubble Heap');
    if (rubble !== undefined) {
      added += rubble;
      setup.lines.push(`Rubble Heap: +${(rubble * 100).toFixed(0)}% damage, added to Ability Strength (above 1400 Rubble)`);
    }
    const whip = augments.get('Accumulating Whipclaw');
    if (whip !== undefined) {
      // shortcut: counted at 10 stacks unless stacks are off; no per-stack input, add one if asked.
      const stacks = options.stackMode === 'none' ? 0 : WHIPCLAW_STACKS;
      added += whip * stacks;
      setup.lines.push(`Accumulating Whipclaw: ${stacks} stacks, +${(whip * stacks * 100).toFixed(0)}% added to Ability Strength`);
    }
    setup.scale = strength + added;
    setup.lines.push(`Base damage x${setup.scale.toFixed(2)} (Ability Strength${added ? ' + augment' : ''})`);
  } else {
    const value = rule.strength.perStrength * strength + rule.strength.offset;
    setup.sources.push({
      name: rule.ability,
      effects: [{ target: 'baseDamage', op: 'add', value, raw: `${value >= 0 ? '+' : ''}${(value * 100).toFixed(0)}% base damage (${rule.ability}, x Ability Strength, adds to Serration)` }],
    });
    if (rule.ability === 'Peacemaker') {
      setup.sources.push({ name: 'Peacemaker ramp', effects: [{ target: 'damageMultiplier', op: 'mult', value: PEACEMAKER_FULL - 1, raw: 'x2.5 total damage at 20 bursts (Peacemaker ramp)' }] });
      setup.lines.push('Peacemaker ramp: stats at 20 bursts (x2.5 damage, full fire rate); the fight simulation ramps from the first burst');
    }
  }

  const chromatic = augments.get('Chromatic Blade');
  if (chromatic !== undefined) {
    const value = chromatic * strength;
    setup.sources.push({ name: 'Chromatic Blade', effects: [{ target: 'statusChance', op: 'add', value, raw: `+${(value * 100).toFixed(0)}% Status Chance (Chromatic Blade x Ability Strength)` }] });
    const slam = /slam/i.test(options.modeName ?? '');
    if (!slam) {
      setup.element = options.chromaticElement ?? 'heat';
      setup.lines.push(`Chromatic Blade: physical damage becomes ${setup.element}${options.chromaticElement ? '' : ' (default; pick the emissive colour\'s element)'}`);
    }
  }
  const rage = augments.get('Primal Rage');
  if (rage !== undefined) {
    const perKill = rage * strength;
    setup.sources.push({
      name: 'Primal Rage',
      effects: [{
        target: 'critChance', op: 'add', value: perKill, condition: 'onKill',
        // The +150% cap is not affected by mods, so the stack cap moves with strength.
        maxStacks: PRIMAL_RAGE_CAP / perKill,
        raw: `+${(perKill * 100).toFixed(1)}% Critical Chance per kill (Primal Rage x Ability Strength, up to +150%)`,
      }],
    });
  }
  if (augments.has('Concentrated Arrow') && !/concentrated/i.test(options.modeName ?? '')) {
    setup.warnings.push('Concentrated Arrow is equipped but the fire mode is not a Concentrated Arrow mode');
  }
  return setup;
}
