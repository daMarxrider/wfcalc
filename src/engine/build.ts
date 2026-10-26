/**
 * Resolves a build (weapon + mods + conditions) into modded weapon stats.
 *
 * Order of operations follows the arsenal formula documented at
 * wiki.warframe.com/w/Damage/Calculation:
 *
 *   total = base × [1 + elemental bonuses + Σ physical share × physical bonus]
 *                 × (1 + damage bonuses)
 *                 × multishot
 *
 * which, per damage type, means:
 *   physical type  = base_type × (1 + physicalBonus) × (1 + damageBonus)
 *   element        = (innate + base_total × elementBonus) × (1 + damageBonus)
 *
 * Elemental mods are combined into secondary elements in mod-slot order, exactly
 * like the game: Heat + Cold = Blast, Toxin + Electricity = Corrosive, ...
 */
import {
  BASE_ELEMENTS,
  DAMAGE_TYPES,
  ELEMENT_COMBINATIONS,
  PHYSICAL_TYPES,
  type BaseElement,
  type DamageType,
  type Effect,
  type ModData,
  type Snapshot,
  type WeaponData,
  type WeaponMode,
  type WeaponStats,
} from '../types.ts';
import { normalizeName } from '../data.ts';
import { abilityStrengthFromMods, buffById, buffEffects } from './buffs.ts';
import { rivenEffects, type RivenSpec } from './riven.ts';
import { InputError } from '../errors.ts';

export interface BuildMod {
  name: string;
  /** Mod rank, 0..maxRank. Defaults to max. */
  rank?: number;
}

export type HitZone = 'head' | 'body';
export type StackMode = 'custom' | 'none' | 'max';

/** Head or body, from either spelling of the option. */
export const hitZoneOf = (build: Pick<Build, 'hit' | 'headshot'>): HitZone =>
  build.hit ?? (build.headshot ? 'head' : 'body');

/** Conditions that only a weak-point or headshot hit can trigger. */
const WEAK_POINT_CONDITION = /weakpoint|weak_point|headshot/i;

/** Buff/condition toggles: `{ onKill: 5 }` means the on-kill effect has 5 stacks. */
export type Conditions = Record<string, number | boolean>;

export interface Build {
  weapon: string;
  mods: Array<string | BuildMod>;
  /** Weapon arcanes (Primary Merciless, Melee Exposure...). */
  arcanes?: Array<string | BuildMod>;
  /** Active Warframe buffs by registry id (roar, eclipse, toxic-lash...). */
  buffs?: string[];
  /** Caster's Ability Strength as a percentage (100 = unmodded). */
  abilityStrength?: number;
  /** Caster's Warframe mods; Ability Strength is derived from them when given. */
  frameMods?: Array<string | BuildMod>;
  /** Caster's Warframe arcanes (Arcane Avenger, Molt Augmented...). */
  warframeArcanes?: Array<string | BuildMod>;
  /** Caster's Warframe name, used to validate which buffs it can actually bring. */
  frame?: string;
  /**
   * Kuva/Tenet weapon elemental bonus: the player-chosen element and its percentage of
   * base damage (25-60%). It behaves as innate damage, so it joins the elemental
   * combination after every mod (wiki: innate elements are last in the hierarchy).
   */
  elementBonus?: { type: DamageType; value: number };
  /** Round each damage type to 1/32 of the modded base damage, as the game does. Default true. */
  quantize?: boolean;
  /** Riven mod stats for this weapon. */
  riven?: RivenSpec;
  /** Status debuffs on the target, in DotContext terms (viralStacks, corrosiveStacks). */
  debuffs?: {
    viralStacks?: number; corrosiveStacks?: number; armorStrip?: number;
    armorStripFlat?: number; armorStripBaseFlat?: number;
  };
  /**
   * Distance to the centre of the blast, in metres, for AoE weapons. The arsenal stat
   * block counts the radial hit at its centre, so this replaces that portion with the
   * falloff-reduced one.
   */
  aoeDistance?: number;
  /** Melee combo counter (hits), which drives the combo multiplier. */
  comboHits?: number;
  /** True when the attack is a heavy attack (the combo multiplier applies to damage). */
  heavyAttack?: boolean;
  /**
   * Chosen Incarnon evolutions, as `"EVO2:Final Fusillade"`, `"evo4:1"` or just the
   * option name. Tiers that are not listed stay unselected.
   */
  incarnon?: string[];
  /** Which fire mode to use; defaults to the arsenal mode. */
  mode?: string;
  /** Active conditions for conditional mods. */
  conditions?: Conditions;
  /** Assume weak-point (headshot) hits. Same as `hit: 'head'`. */
  headshot?: boolean;
  /** Where the shots land: `head` (weak point, headshot, head crits) or `body` (default). */
  hit?: HitZone;
  /**
   * How conditional effects (on kill, on weak point hit, while aiming...) are counted:
   *   custom  `conditions` decides, condition by condition (default)
   *   none    every conditional effect is off
   *   max     every conditional effect is on at its cap; weak-point ones only on head hits
   */
  stackMode?: StackMode;
  /** Stacks per source (mod, arcane or buff name), over the mode: 0 turns that source's conditions off. */
  sourceStacks?: Record<string, number>;
}

export interface ResolvedDamage {
  /** Damage per projectile/pellet, per type, after elemental combination. */
  perProjectile: Partial<Record<DamageType, number>>;
  /** Total damage per projectile (sum of the above). */
  projectileTotal: number;
}

export interface ResolvedBuild {
  weapon: WeaponData;
  mode: WeaponMode | null;
  /** True when these stats come from the Incarnon form. */
  incarnonFormActive: boolean;
  /** Blast-centre distance used for AoE falloff, if any. */
  aoeDistance: number | null;
  damage: ResolvedDamage;
  critChance: number;
  critMultiplier: number;
  statusChance: number;
  multishot: number;
  fireRate: number;
  reloadTime: number;
  magazineSize: number;
  /** Damage of a full trigger pull (all projectiles), before crit and faction. */
  shotDamage: number;
  /** Average damage per trigger pull including crit expectation. */
  averageShotDamage: number;
  /** Sustained DPS across reloads. */
  sustainedDps: number;
  /** Burst DPS (no reload). */
  burstDps: number;
  /** Faction damage multipliers by faction key, plus `all` for Roar-style bonuses. */
  factionBonus: Record<string, number>;
  /** Active buffs, for display. */
  activeBuffs: string[];
  /** Riven stat lines as rolled, for display. */
  rivenLines: string[];
  /** Chosen Incarnon evolutions, for display. */
  incarnonLines: string[];
  /** Melee combo multiplier in effect (1 when no combo). */
  comboMultiplier: number;
  /** Flat punch-through in metres. */
  punchThrough: number;
  /** Per-shot crit spread, useful for shotguns where the average hides a wide range. */
  critVariance: { pellets: number; expectedCrits: number; atLeastOneCrit: number };
  /** Hit location and its bonuses; hit.ts turns them into a multiplier for a given enemy. */
  hitZone: HitZone;
  /** Σ "weak point damage" (Primary Acuity), added to the weak-point multiplier at 1.5x on heads. */
  weakPointDamageBonus: number;
  /** Σ "headshot multiplier" (Deadhead, Meticulous Aim), multiplying the weak-point multiplier. */
  headshotMultiplierBonus: number;
  /** Σ "bodyshot damage" (Meticulous Aim -45%), on body hits only. */
  bodyshotMultiplierBonus: number;
  /** Crit chance added on weak points: base crit x Σ "weak point critical chance". */
  weakPointCritChance: number;
  /** A replacement weak-point multiplier (Sonar), 0 when none. */
  weakPointOverride: number;
  /** Total Status Damage bonus (multiplies DoT ticks). */
  statusDamageBonus: number;
  /** Total Status Duration bonus (Continuous Misery): stretches status timers. */
  statusDurationBonus: number;
  /**
   * Elemental bonus per base element (e.g. Heat 0.9 for Hellfire). The DoT layer needs it
   * to separate the seed from the elemental multiplier, which is what the wiki's worked
   * examples do: (seed + 1) × C × (1 + element bonus).
   */
  elementBonuses: Partial<Record<BaseElement, number>>;
  /** Status effects forced by mods (Hunter Munitions and friends). */
  forcedProcs: Array<{ type: DamageType; chance: number; requiresCrit: boolean }>;
  /** Ability Strength used for buffs (from frame mods when provided). */
  abilityStrength: number;
  /** Status debuffs kept up on the target (viral/corrosive stacks). */
  debuffs: {
    viralStacks?: number; corrosiveStacks?: number; armorStrip?: number;
    armorStripFlat?: number; armorStripBaseFlat?: number;
  };
  /** Elemental bonuses as they were combined, for display. */
  elements: Array<{ type: DamageType; share: number }>;
  /** Mods whose effects are not fully understood, so the result is a lower bound. */
  unsupportedMods: string[];
  /** Conditional effects that were not active and therefore ignored. */
  inactiveConditions: string[];
  /**
   * Every source in the build with conditional effects, its stack cap (DE's "Stacks up to Nx",
   * 1 when it does not stack) and the stacks counted now: what a stack picker needs.
   */
  conditionalSources: Array<{ name: string; kind: string; cap: number; stacks: number; conditions: string[] }>;
  /** Non-fatal problems (mod does not fit, incompatible pair, rank out of range). */
  warnings: string[];
}

/**
 * How many stacks of a conditional effect are active.
 *
 * A compound condition such as "onWeakPointKill+aiming" gates on *both* parts, but only
 * the stackable one carries a count: aiming is a boolean (1), onWeakPointKill can be 3.
 * Taking the minimum would silently cap the stacks at 1.
 */
export interface StackContext {
  mode: StackMode;
  /** Stacks the player set for this effect's source, if any. */
  override?: number;
  hit: HitZone;
}

function conditionStacks(effect: Effect, conditions: Conditions, context: StackContext = { mode: 'custom', hit: 'body' }): number {
  let stacks = 1;
  // An effect whose text gives no "Stacks up to Nx" does not stack: it refreshes. DE's export
  // states a cap for every effect that has one (checked by tools/public-export.ts), so a missing
  // cap means 1, not "as many as the condition counter says".
  const cap = effect.maxStacks ?? 1;
  // Condition Overload has no condition of its own: it scales with the statuses on the
  // target, so it must reach the perStatusType step below instead of returning early.
  if (effect.condition) {
    if (context.override !== undefined) {
      stacks = context.override;
    } else if (context.mode === 'none') {
      stacks = 0;
    } else if (context.mode === 'max') {
      stacks = WEAK_POINT_CONDITION.test(effect.condition) && context.hit !== 'head' ? 0 : cap;
    } else {
      for (const part of effect.condition.split('+')) {
        // A ramping buff the player picked counts as fully built unless they say otherwise.
        const raw = part === 'buffRamp' ? (conditions[part] ?? 1) : conditions[part];
        if (!raw) return 0; // undefined, false or 0 -> effect inactive
        if (typeof raw === 'number' && raw > stacks) stacks = raw;
      }
    }
    if (stacks <= 0) return 0;
  }
  stacks = Math.min(stacks, cap);
  if (effect.perStatusType) stacks *= Math.max(1, Number(conditions.statusTypes ?? 1));
  return Number.isFinite(stacks) ? stacks : 1;
}

/**
 * Scales an effect value from max rank down to the equipped rank.
 * Mods have `maxRank + 1` steps of equal size, so rank 0 is already 1/(maxRank+1)
 * of the max value: Serration R0 is +15%, R9 is +150%, R10 is +165%.
 */
function rankScale(mod: ModData, rank: number | undefined): number {
  if (rank === undefined || mod.maxRank <= 0) return 1;
  return Math.max(0, Math.min(1, (rank + 1) / (mod.maxRank + 1)));
}

function effectValue(effect: Effect, mod: ModData, rank: number | undefined): number {
  return effect.value * rankScale(mod, rank);
}

interface Collected {
  byTarget: Map<string, number>;
  elementBonuses: Array<{ element: BaseElement; amount: number }>;
  faction: Map<string, number>;
  elementMultipliers: Map<DamageType, number>;
  forcedProcs: Array<{ type: DamageType; chance: number; requiresCrit: boolean }>;
  conversions: Array<{ from: BaseElement; to: DamageType; share: number }>;
  inactive: string[];
  unsupported: string[];
  warnings: string[];
}

/** Damage multiplier at `distance` metres from the blast centre (wiki: Damage Falloff). */
export function falloffFactor(falloff: { start: number; end: number; reduction: number }, distance: number): number {
  if (distance <= falloff.start) return 1;
  if (distance >= falloff.end) return Math.max(0, 1 - falloff.reduction);
  return 1 - falloff.reduction * ((distance - falloff.start) / (falloff.end - falloff.start));
}

/** Reads a weapon mode's stats, falling back to the arsenal block. */
/** Arcane slot types each weapon category accepts. Arch-guns take a Primary and a Secondary arcane. */
export const ARCANE_SLOTS: Record<string, string[]> = {
  primary: ['primary', 'bow', 'shotgun'],
  secondary: ['secondary'],
  melee: ['melee'],
  archgun: ['primary', 'secondary'],
  archmelee: ['melee'],
};

export function statsForMode(weapon: WeaponData, modeName?: string): { stats: WeaponData['stats']; mode: WeaponMode | null } {
  if (modeName) {
    const wanted = normalizeName(modeName);
    const mode = weapon.modes.find((m) => normalizeName(m.name) === wanted) ?? weapon.modes.find((m) => normalizeName(m.name).includes(wanted));
    if (mode) return { stats: mode.stats, mode };
  }
  return { stats: weapon.stats, mode: null };
}

export function resolveBuild(snapshot: Snapshot, build: Build): ResolvedBuild {
  const weapon = snapshot.weapons[build.weapon];
  if (!weapon) throw new InputError(`unknown weapon: ${build.weapon}`, 'unknown_weapon');

  // The game equips one copy of a mod, so a repeated name is a bad request and not a build
  // with double Serration. Compare on the resolved name so "serration" and an under-ranked
  // copy of the same mod collide too.
  const named = new Set<string>();
  for (const entry of build.mods ?? []) {
    const wanted = String(typeof entry === 'string' ? entry : entry.name ?? '').trim();
    if (!wanted) continue;
    const mod = snapshot.mods[wanted]
      ?? snapshot.mods[Object.keys(snapshot.mods).find((key) => normalizeName(key) === normalizeName(wanted)) ?? ''];
    const key = mod?.name ?? normalizeName(wanted);
    const label = mod?.name ?? wanted;
    if (named.has(key)) {
      throw new InputError(`duplicate mod: ${label} (a build can only carry one copy of a mod)`, 'duplicate_mod');
    }
    named.add(key);
  }

  let aoeWarning: string | null = null;
  const resolvedMode = statsForMode(weapon, build.mode);
  const conditions = build.conditions ?? {};
  let stats = resolvedMode.stats;
  const mode = resolvedMode.mode;
  // The Incarnon form replaces the weapon's stats outright, and mods apply on top of it, which
  // is what the game does. Applying perks to the base profile was an approximation.
  const incarnonLines: string[] = [];
  const incarnonFormActive = Boolean(build.incarnon?.length && weapon.incarnonForm);
  const spectralForm = Boolean(incarnonFormActive && weapon.incarnonFormSpectral);
  if (incarnonFormActive && weapon.incarnonForm) {
    stats = { ...weapon.incarnonForm };
    incarnonLines.push('Incarnon form profile');
    if (weapon.incarnonFormSpectral) {
      incarnonLines.push('spectral hits ignore melee damage mods, stance and combo multiplier (wiki)');
    }
    // The form fires a second hit on the same shot ("Incarnon Form AoE", the melee forms'
    // spectral explosion). It is part of the shot at the blast centre; with --aoe-distance it
    // keeps only the falloff-reduced share. Mods apply to both, as in the game.
    for (const extra of weapon.incarnonFormExtra ?? []) {
      const distance = build.aoeDistance ?? 0;
      const factor = extra.falloff ? falloffFactor(extra.falloff, distance) : 1;
      for (const [type, value] of Object.entries(extra.damage)) {
        const key = type.toLowerCase() as DamageType;
        if (!(key in stats) || typeof value !== 'number') continue;
        stats[key] = (stats[key] ?? 0) + value * factor;
      }
      incarnonLines.push(`${extra.name} included${build.aoeDistance !== undefined ? ` at ${build.aoeDistance} m` : ' at the blast centre'}`);
    }
  }
  // Direct-only multipliers (Condition Overload, Galvanized Aptitude) must not scale the
  // radial second hit. We approximate by their share of the transformed profile's base damage.
  const directShare = build.incarnon?.length && weapon.incarnonForm && weapon.incarnonFormExtra?.length
    ? weapon.incarnonFormDirectShare ?? 1
    : 1;

  // Kuva/Tenet elemental bonus: a player-chosen element worth 25-60% of base damage,
  // baked in before anything else so it combines like innate damage.
  let elementBonusWarning: string | null = null;
  if (build.elementBonus && build.elementBonus.value > 0) {
    const { type, value } = build.elementBonus;
    if (value > 0.6) elementBonusWarning = `element bonus ${(value * 100).toFixed(0)}% is above the 60% maximum`;
    const rawTotal = DAMAGE_TYPES.reduce((sum, candidate) => sum + (stats[candidate] ?? 0), 0);
    stats = { ...stats, [type]: (stats[type] ?? 0) + rawTotal * value };
  }

  // AoE: the arsenal block counts the radial hit at the blast centre. Swap that portion
  // for the falloff-reduced value at the requested distance.
  const aoeDistance = build.aoeDistance;
  // The Incarnon form carries its own radial second hit with its own falloff; the base
  // weapon's radial mode must not be applied on top of it.
  if (aoeDistance !== undefined && aoeDistance >= 0 && !(build.incarnon?.length && weapon.incarnonForm)) {
    const radial = weapon.modes.find((candidate) => candidate.falloff);
    if (radial && radial.falloff) {
      const factor = falloffFactor(radial.falloff, aoeDistance);
      const adjusted: WeaponStats = { ...stats };
      for (const type of DAMAGE_TYPES) {
        const component = radial.stats[type] ?? 0;
        if (component === 0) continue;
        adjusted[type] = (stats[type] ?? 0) - component + component * factor;
      }
      stats = adjusted;
    } else {
      aoeWarning = `no AoE falloff data for ${weapon.name}`;
    }
  }

  // ------------------------------------------------------------ gather effects
  const collected: Collected = {
    byTarget: new Map(),
    elementBonuses: [],
    faction: new Map(),
    elementMultipliers: new Map(),
    forcedProcs: [],
    conversions: [],
    inactive: [],
    unsupported: [],
    warnings: [],
  };

  // One uniform view of every effect source: mods, weapon arcanes and Warframe buffs.
  // Buff values are already resolved at the caster's Ability Strength, so they have
  // maxRank 0 and never get rank-scaled.
  interface Source {
    name: string;
    maxRank: number;
    rank?: number;
    effects: Effect[];
    partial: boolean;
    incompatible: string[];
    set?: string | null;
    /** Where the bonus comes from: a melee form treats them differently. */
    kind: 'mod' | 'weaponArcane' | 'incarnon' | 'riven' | 'warframeArcane' | 'buff';
  }
  const sources: Source[] = [];
  if (aoeWarning) collected.warnings.push(aoeWarning);
  if (elementBonusWarning) collected.warnings.push(elementBonusWarning);
  const equipped: string[] = [];
  const rivenLines: string[] = [];

  // Melee combo multiplier: 1x below 20 hits, then 2x at 20 and +1x every 20 hits, capped at 12x.
  // Per the wiki it does NOT scale normal attacks; it scales heavy attacks and
  // combo-scaling mods (Blood Rush, Weeping Wounds).
  const comboHits = Math.max(0, build.comboHits ?? 0);
  const comboMultiplier = comboHits < 20 ? 1 : Math.min(12, 2 + Math.floor((comboHits - 20) / 20));

  const resolveMod = (wanted: string) =>
    snapshot.mods[wanted] ?? snapshot.mods[Object.keys(snapshot.mods).find((k) => normalizeName(k) === normalizeName(wanted)) ?? ''];

  for (const entry of build.mods) {
    const wanted = typeof entry === 'string' ? entry : entry.name;
    const rank = typeof entry === 'string' ? undefined : entry.rank;
    const mod = resolveMod(wanted);
    if (!mod) {
      collected.warnings.push(`mod not found: ${wanted}`);
      continue;
    }
    const fits = mod.classes.some((c) => weapon.modClasses.some((w) => w.toLowerCase() === c.toLowerCase()))
      || mod.classes.some((c) => ['Mod', 'Antique', 'Primary', 'Secondary'].includes(c));
    if (!fits) collected.warnings.push(`${mod.name} does not fit a ${weapon.type} (${weapon.modClasses.join('/')})`);
    if (mod.incompatible.some((other) => equipped.includes(other))) {
      collected.warnings.push(`${mod.name} cannot be equipped with ${mod.incompatible.filter((o) => equipped.includes(o)).join(', ')}`);
    }
    equipped.push(mod.name);
    sources.push({
      name: mod.name, maxRank: mod.maxRank, rank, effects: mod.effects,
      partial: mod.partial, incompatible: mod.incompatible, set: mod.set, kind: 'mod',
    });
  }

  // Weapon arcanes: the slot has to match the weapon (Primary/Secondary/Melee/Bow/Shotgun), and
  // a weapon holds one arcane per slot type. Arch-guns are the exception with two: one Primary
  // and one Secondary arcane, each unlocked by an Archgun Arcane Adapter (wiki: Arcane Enhancement).
  const arcaneSlots = ARCANE_SLOTS;
  const arcaneGroup = (slot: string): string => (weapon.category === 'archgun' ? (slot === 'secondary' ? 'secondary' : 'primary') : 'weapon');
  const usedArcaneGroups = new Map<string, string>();
  let compressionRank: number | null = null;
  for (const entry of build.arcanes ?? []) {
    const wanted = typeof entry === 'string' ? entry : entry.name;
    const rank = typeof entry === 'string' ? undefined : entry.rank;
    const arcane = snapshot.arcanes[wanted]
      ?? snapshot.arcanes[Object.keys(snapshot.arcanes).find((k) => normalizeName(k) === normalizeName(wanted)) ?? ''];
    if (!arcane) {
      collected.warnings.push(`arcane not found: ${wanted}`);
      continue;
    }
    const allowed = arcaneSlots[weapon.category] ?? [];
    if (arcane.slot && !allowed.includes(arcane.slot)) {
      collected.warnings.push(`${arcane.name} is a ${arcane.slot} arcane and does not fit a ${weapon.category} weapon`);
    }
    const group = arcaneGroup(arcane.slot ?? '');
    const taken = usedArcaneGroups.get(group);
    if (taken) {
      collected.warnings.push(weapon.category === 'archgun'
        ? `${arcane.name}: an arch-gun holds one ${group} arcane, and ${taken} already fills it`
        : `${arcane.name}: a weapon holds one arcane, and ${taken} already fills the slot`);
    }
    usedArcaneGroups.set(group, arcane.name);
    if (arcane.name === 'Primary Compression') compressionRank = Math.min(rank ?? arcane.maxRank, arcane.maxRank);
    sources.push({ name: arcane.name, maxRank: arcane.maxRank, rank, effects: arcane.effects, partial: false, incompatible: [], kind: 'weaponArcane' });
  }

  // Incarnon evolutions: only weapons with a tree in the dataset have options.
  if (build.incarnon?.length) {
    const options = snapshot.incarnons[weapon.name] ?? [];
    if (!options.length) collected.warnings.push(`no Incarnon data for ${weapon.name}`);
    for (const choice of build.incarnon) {
      // "form" uses the transformed profile with no evolution perks, for weapons whose tree is
      // not in the dataset (Okina Prime shares Okina's on the wiki but has no page of its own).
      if (normalizeName(choice) === 'form') {
        incarnonLines.push('form only, no evolution perks');
        continue;
      }
      // Accepts "EVO2", "EVO2:1" (option index) and "EVO2:Lone Blade" (option name).
      const separator = choice.indexOf(':');
      const tierPart = separator >= 0 ? choice.slice(0, separator) : null;
      const restPart = separator >= 0 ? choice.slice(separator + 1) : choice;
      const sameTier = options.filter((option) => !tierPart || normalizeName(option.tier) === normalizeName(tierPart));

      let chosen = sameTier.find((option) => normalizeName(option.name) === normalizeName(restPart));
      if (!chosen && /^\d+$/.test(restPart)) chosen = sameTier[Number(restPart)];
      if (!chosen && !tierPart) chosen = options.find((option) => normalizeName(option.name) === normalizeName(choice));
      if (!chosen) {
        collected.warnings.push(`unknown Incarnon option: ${choice}`);
        continue;
      }
      incarnonLines.push(`${chosen.tier} ${chosen.name}`);
      sources.push({
        name: `Incarnon: ${chosen.name}`,
        maxRank: 0,
        effects: chosen.effects as Effect[],
        partial: false,
        incompatible: [],
        kind: 'incarnon',
      });
    }
  }

  // Riven: values depend on the weapon's disposition, so it is resolved per weapon.
  if (build.riven) {
    const riven = rivenEffects(snapshot, weapon, build.riven);
    for (const warning of riven.warnings) collected.warnings.push(`riven: ${warning}`);
    sources.push({ name: 'Riven', maxRank: 0, effects: riven.effects, partial: false, incompatible: [], kind: 'riven' });
    rivenLines.push(...riven.lines);
  }

  // Ability Strength comes from the frame's mods and arcanes when they are provided.
  const frameStrength = build.frameMods?.length || build.warframeArcanes?.length
    ? abilityStrengthFromMods(snapshot, build.frameMods ?? [], build.warframeArcanes ?? [], conditions)
    : null;
  if (frameStrength) for (const warning of frameStrength.warnings) collected.warnings.push(`frame: ${warning}`);
  const abilityStrength = frameStrength ? frameStrength.strength : build.abilityStrength ?? 100;

  // Warframe arcanes also buff the weapon directly (Arcane Avenger: +45% crit chance).
  for (const entry of build.warframeArcanes ?? []) {
    const wanted = typeof entry === 'string' ? entry : entry.name;
    const rank = typeof entry === 'string' ? undefined : entry.rank;
    const arcane = snapshot.arcanes[wanted]
      ?? snapshot.arcanes[Object.keys(snapshot.arcanes).find((key) => normalizeName(key) === normalizeName(wanted)) ?? ''];
    if (!arcane) {
      collected.warnings.push(`warframe arcane not found: ${wanted}`);
      continue;
    }
    if (arcane.slot !== 'warframe') {
      collected.warnings.push(`${arcane.name} is a ${arcane.slot} arcane, not a Warframe arcane`);
      continue;
    }
    sources.push({
      name: arcane.name,
      maxRank: arcane.maxRank,
      rank,
      // Ability Strength is already handled by the strength calculation above.
      effects: arcane.effects.filter((effect) => effect.target !== 'abilityStrength'),
      partial: false,
      incompatible: [],
      kind: 'warframeArcane',
    });
  }

  // Warframe buffs from the registry.
  const activeBuffs: string[] = [];
  for (const id of build.buffs ?? []) {
    const definition = buffById(id);
    if (!definition) {
      collected.warnings.push(`unknown buff: ${id}`);
      continue;
    }
    // Helminth: a buff is only available if the frame has it natively or can subsume it.
    const ability = snapshot.abilities[definition.ability];
    if (build.frame && ability && normalizeName(ability.frame) !== normalizeName(build.frame) && !ability.subsumable && !definition.augment) {
      collected.warnings.push(
        `${definition.ability} belongs to ${ability.frame} and is not subsumable; ${build.frame} cannot use it`,
      );
    }
    const effects = buffEffects(snapshot, definition, abilityStrength, { conditions, headshot: build.headshot });
    if (!effects.length) {
      collected.warnings.push(`${definition.ability}: no numbers in the dataset, buff ignored`);
      continue;
    }
    activeBuffs.push(definition.ability);
    const gated = definition.ramps ? effects.map((effect) => ({ ...effect, condition: effect.condition ?? 'buffRamp' })) : effects;
    sources.push({ name: definition.ability, maxRank: 0, effects: gated, partial: false, incompatible: [], kind: 'buff' });
  }

  // Set Mods: count equipped pieces per set. Sets whose bonus "enhances the mods in this
  // set" (Umbral, Sacrificial) scale those mods' own effect values, so the factor has to be
  // known while effects are collected.
  const setPieces = new Map<string, number>();
  for (const source of sources) {
    if (source.set) setPieces.set(source.set, (setPieces.get(source.set) ?? 0) + 1);
  }
  const amplifyFor = (set: string | null | undefined, modName: string): number => {
    if (!set) return 0;
    const bonus = snapshot.setBonuses[set];
    const pieces = setPieces.get(set) ?? 0;
    if (bonus?.kind !== 'amplify' || pieces < 2) return 0;
    // Highest threshold that the equipped count reaches.
    const thresholds = Object.keys(bonus.amplify ?? {}).map(Number).filter((value) => value <= pieces).sort((a, b) => b - a);
    if (!thresholds.length) return 0;
    const targets = bonus.amplify?.[String(thresholds[0])] ?? {};
    return targets[modName] ?? targets['*'] ?? 0;
  };

  const conditional = new Map<string, { name: string; kind: string; cap: number; stacks: number; conditions: Set<string> }>();
  for (const source of sources) {
    if (source.partial) collected.unsupported.push(source.name);
    for (const effect of source.effects) {
      if (effect.condition) {
        const entry = conditional.get(source.name) ?? { name: source.name, kind: source.kind, cap: 1, stacks: 0, conditions: new Set<string>() };
        entry.cap = Math.max(entry.cap, effect.maxStacks ?? 1);
        entry.conditions.add(effect.condition);
        conditional.set(source.name, entry);
      }
      const stacks = conditionStacks(effect, conditions, {
        mode: build.stackMode ?? 'custom',
        override: build.sourceStacks?.[source.name],
        hit: hitZoneOf(build),
      });
      if (effect.condition) {
        const entry = conditional.get(source.name)!;
        entry.stacks = Math.max(entry.stacks, effect.perStatusType ? stacks / Math.max(1, Number(conditions.statusTypes ?? 1)) : stacks);
      }
      if (stacks === 0) {
        collected.inactive.push(`${source.name}: ${effect.raw}`);
        continue;
      }
      // A melee Incarnon form fires spectral projectiles, and the wiki states those hits take
      // no melee damage bonus: Pressure Point, Arcane Fury, the stance and the combo
      // multiplier do nothing. Elemental, faction, crit, status and Condition Overload still
      // apply, so only plain "melee damage" rolls are dropped.
      if (spectralForm && effect.target === 'baseDamage' && !effect.flat && !effect.perStatusType
        && (source.kind === 'riven' || /melee damage/i.test(effect.raw))) {
        collected.inactive.push(`${source.name}: ${effect.raw} (spectral hits ignore melee damage)`);
        continue;
      }
      const rankFraction = source.maxRank > 0 ? rankScale({ maxRank: source.maxRank } as ModData, source.rank) : 1;
      // Combo-scaling mods scale with (multiplier - 1): at 12x, Blood Rush is +40% x 11.
      const comboFactor = effect.scalesWithCombo ? Math.max(0, comboMultiplier - 1) : 1;
      // "(x2 for Bows)": the mod text doubles the effect on bows.
      const bowFactor = effect.doublesForBows && /bow/i.test(weapon.type) ? 2 : 1;
      const setFactor = 1 + amplifyFor(source.set, source.name);
      const directOnly = effect.perStatusType ? directShare : 1;
      const value = effect.value * rankFraction * stacks * comboFactor * bowFactor * setFactor * directOnly;
      if (effect.op === 'mult' && effect.target === 'elementMultiplier' && effect.element) {
        // "x2.5 Heat damage" (Accelerant): multiplies that damage type only.
        collected.elementMultipliers.set(effect.element, (collected.elementMultipliers.get(effect.element) ?? 1) * (1 + value));
        continue;
      }
      switch (effect.op) {
        case 'flat':
          // Flat additions (Arcane Avenger: +45% crit chance) are not scaled by the base stat.
          collected.byTarget.set(`${effect.target}Flat`, (collected.byTarget.get(`${effect.target}Flat`) ?? 0) + value);
          break;
        case 'convert':
          if (effect.convertsTo && effect.element) {
            collected.conversions.push({ from: effect.element as BaseElement, to: effect.convertsTo, share: value });
          }
          break;
        case 'mult':
          collected.byTarget.set(effect.target, (collected.byTarget.get(effect.target) ?? 1) * (1 + value));
          break;
        default: {
          if (effect.target === 'element' && effect.element) {
            if ((BASE_ELEMENTS as readonly string[]).includes(effect.element)) {
              collected.elementBonuses.push({ element: effect.element as BaseElement, amount: value });
            } else if ((PHYSICAL_TYPES as readonly string[]).includes(effect.element)) {
              // "+60% Impact" boosts that physical type alone, not the whole base.
              collected.byTarget.set(effect.element, (collected.byTarget.get(effect.element) ?? 0) + value);
            } else {
              // An element the weapon may not have innately (e.g. "+90% Radiation",
              // Xata's Whisper's Void, Nourish's Viral): adds on top of the total.
              const key = `element:${effect.element}`;
              collected.byTarget.set(key, (collected.byTarget.get(key) ?? 0) + value);
            }
          } else if (effect.target === 'baseDamage' && effect.flat) {
            // Incarnon-style flat base damage: "+51 Base Damage".
            collected.byTarget.set('baseDamageFlat', (collected.byTarget.get('baseDamageFlat') ?? 0) + value);
          } else if (effect.target === 'forcedProc' && effect.element) {
            // Hunter Munitions wording: the proc only happens on critical hits.
            collected.forcedProcs.push({
              type: effect.element,
              chance: value,
              requiresCrit: /critical|crit/i.test(effect.raw),
            });
          } else if (effect.target === 'factionDamage' && effect.faction) {
            collected.faction.set(effect.faction, (collected.faction.get(effect.faction) ?? 0) + value);
          } else {
            collected.byTarget.set(effect.target, (collected.byTarget.get(effect.target) ?? 0) + value);
          }
          break;
        }
      }
    }
  }

  const bonus = (target: string): number => collected.byTarget.get(target) ?? 0;


  // ---------------------------------------------------------------- base damage
  const baseTotal = DAMAGE_TYPES.reduce((sum, type) => sum + (stats[type] ?? 0), 0);
  // Primary Compression (wiki): while aiming the explosion radius shrinks to 20%, and every
  // metre lost adds +50% damage, +10% per rank (+100% at rank 5). The radius is the modded one
  // (Firestorm), read through the wiki's per-attack table; on most weapons the bonus multiplies
  // with Serration-type bonuses, on a few it adds to them.
  let compressionMultiplier = 1;
  let compressionAdd = 0;
  if (compressionRank !== null) {
    const aiming: Effect = { target: 'baseDamage', op: 'add', value: 0, condition: 'aiming', raw: 'Primary Compression: on aim' };
    const active = conditionStacks(aiming, conditions, {
      mode: build.stackMode ?? 'custom',
      override: build.sourceStacks?.['Primary Compression'],
      hit: hitZoneOf(build),
    }) > 0;
    const entries = snapshot.compression?.[weapon.name] ?? [];
    const wanted = normalizeName(mode?.name ?? '');
    const entry = (wanted ? entries.find((candidate) => normalizeName(candidate.attack).includes(wanted)) : undefined) ?? entries[0];
    if (!entry) {
      collected.warnings.push(`Primary Compression: no explosion radius known for ${weapon.name}, so no damage bonus`);
    } else if (!active) {
      collected.inactive.push('Primary Compression: active while aiming');
    } else {
      const radius = entry.radius * (1 + bonus('blastRadius'));
      const value = (0.5 + 0.1 * compressionRank) * 0.8 * radius * entry.effectiveness;
      if (entry.stacking === 'adds') compressionAdd = value;
      else compressionMultiplier = 1 + value;
    }
  }
  const damageBonus = (1 + bonus('baseDamage') + compressionAdd) * compressionMultiplier;
  // Flat base damage (Incarnon perks: "Increase Base Damage by +51") is spread over the
  // weapon's existing damage distribution, like any other base damage.
  const flatBase = collected.byTarget.get('baseDamageFlat') ?? 0;

  // Physical types keep their distribution and get their own bonuses.
  const damage: Partial<Record<DamageType, number>> = {};
  for (const type of PHYSICAL_TYPES) {
    const base = stats[type] ?? 0;
    if (base <= 0) continue;
    damage[type] = base * (1 + bonus(type)) * damageBonus;
  }

  // Non-combinable damage the weapon already has (true, void, tau, or innate combined elements),
  // plus mods that grant such a type outright ("+90% Radiation" on a weapon without it).
  const innateCombined: DamageType[] = ['blast', 'corrosive', 'gas', 'magnetic', 'radiation', 'viral', 'true', 'void', 'tau'];
  for (const type of innateCombined) {
    const base = stats[type] ?? 0;
    const added = baseTotal * bonus(`element:${type}`) * damageBonus;
    if (base > 0 || added > 0) damage[type] = base * damageBonus + added;
  }

  // ------------------------------------------------- elemental combination phase
  // Hierarchy (wiki: Damage → Elemental Damage Combinations): mods in slot order, each element
  // placed where it first appears and every later source of it merged there; innate elements go
  // last, in Heat > Cold > Electricity > Toxin order, unless a mod already placed that element.
  // Consecutive elements in the hierarchy then pair up into combined elements.
  const modContributions: Array<{ element: BaseElement; amount: number }> = [];
  const innateContributions: Array<{ element: BaseElement; amount: number }> = [];

  // "X% of Damage converted into <element>" (rare, mostly augments): that share of the
  // total stops being physical damage and becomes the target element instead.
  const conversions = collected.conversions.filter((c) => c.share > 0);
  const convertedShare = Math.min(1, conversions.reduce((sum, c) => sum + c.share, 0));
  if (convertedShare > 0) {
    for (const key of Object.keys(damage) as DamageType[]) damage[key] = (damage[key] ?? 0) * (1 - convertedShare);
  }

  for (const element of BASE_ELEMENTS) {
    const innate = (stats[element] ?? 0) * (1 - convertedShare);
    if (innate > 0) innateContributions.push({ element, amount: innate * damageBonus });
  }
  for (const conversion of conversions) {
    if ((BASE_ELEMENTS as readonly string[]).includes(conversion.to)) {
      modContributions.push({ element: conversion.to as BaseElement, amount: baseTotal * conversion.share * damageBonus });
    } else {
      damage[conversion.to] = (damage[conversion.to] ?? 0) + baseTotal * conversion.share * damageBonus;
    }
  }
  for (const entry of collected.elementBonuses) {
    modContributions.push({ element: entry.element, amount: baseTotal * entry.amount * damageBonus });
  }

  const hierarchy: BaseElement[] = [];
  const elementTotals = new Map<BaseElement, number>();
  for (const { element, amount } of [...modContributions, ...innateContributions]) {
    if (amount <= 0) continue;
    if (!hierarchy.includes(element)) hierarchy.push(element);
    elementTotals.set(element, (elementTotals.get(element) ?? 0) + amount);
  }
  for (let index = 0; index < hierarchy.length; index += 2) {
    const first = hierarchy[index];
    const second = hierarchy[index + 1];
    if (!second) {
      damage[first] = (damage[first] ?? 0) + (elementTotals.get(first) ?? 0);
      continue;
    }
    const [result] = Object.entries(ELEMENT_COMBINATIONS).find(([, pair]) => pair.includes(first) && pair.includes(second))!;
    damage[result as DamageType] = (damage[result as DamageType] ?? 0)
      + (elementTotals.get(first) ?? 0) + (elementTotals.get(second) ?? 0);
  }

  // Quantization (wiki: Damage/Calculation): each type rounds to the nearest 1/32 of the
  // modded base damage. Serration scales the value and the scale alike, so this is the same
  // as rounding against baseTotal × damageBonus. Later multipliers act on quantized values.
  const quantum = (baseTotal * damageBonus) / 32;
  if (build.quantize !== false && quantum > 0) {
    for (const key of Object.keys(damage) as DamageType[]) {
      damage[key] = Math.floor((damage[key] ?? 0) / quantum + 0.5) * quantum;
    }
  }

  // Direct Damage bonuses (Galvanized Aptitude) multiply the finished damage, so they are
  // applied after the elemental combination like faction damage.
  const directDamageBonus = 1 + (collected.byTarget.get('directDamage') ?? 0);
  if (directDamageBonus !== 1) {
    for (const key of Object.keys(damage) as DamageType[]) damage[key] = (damage[key] ?? 0) * directDamageBonus;
  }

  // Flat base damage is added on top, spread over the weapon's damage distribution.
  if (flatBase > 0) {
    const distributed = flatBase * damageBonus;
    const weights = Object.entries(damage).filter(([, amount]) => (amount ?? 0) > 0);
    const weightTotal = weights.reduce((sum, [, amount]) => sum + (amount ?? 0), 0);
    if (weightTotal > 0) {
      for (const [type, amount] of weights) {
        damage[type as DamageType] = (amount ?? 0) + distributed * ((amount ?? 0) / weightTotal);
      }
    }
  }

  // Elemental multipliers (Accelerant's "x2.5 Heat damage") act on the finished types.
  for (const [element, multiplier] of collected.elementMultipliers) {
    if (multiplier !== 1 && (damage[element] ?? 0) > 0) damage[element] = (damage[element] ?? 0) * multiplier;
  }

  const projectileTotal = Object.values(damage).reduce((sum, value) => sum + (value ?? 0), 0);

  // ------------------------------------------------------------------- crit etc.
  const baseCritChance = (stats.critChance ?? 0) * (1 + bonus('critChance')) + bonus('critChanceFlat');

  // Table-style set bonuses. Gladiator adds crit chance per combo step (like Blood Rush);
  // Vigilante rolls a chance to upgrade a hit to the next crit tier.
  const setValue = (set: string): number => {
    const bonus = snapshot.setBonuses[set];
    const pieces = setPieces.get(set) ?? 0;
    if (bonus?.kind !== 'table' || pieces < 1 || !bonus.table) return 0;
    const thresholds = Object.keys(bonus.table).map(Number).filter((value) => value <= pieces).sort((a, b) => b - a);
    return thresholds.length ? bonus.table[String(thresholds[0])] ?? 0 : 0;
  };
  const gladiatorCrit = setValue('Gladiator Set') * Math.max(0, comboMultiplier - 1);
  const vigilante = setValue('Vigilante Set');
  const critChance = baseCritChance + gladiatorCrit;
  const critMultiplier = (stats.critMultiplier ?? 1) * (1 + bonus('critDamage'));
  // Not clamped to 1: the game allows above-100% status, which means a guaranteed proc plus
  // a chance of another. Clamping threw that information away.
  const statusChance = (stats.statusChance ?? 0) * (1 + bonus('statusChance')) + bonus('statusChanceFlat');
  const multishot = (stats.multishot ?? 1) * (1 + bonus('multishot'));
  // "Fire Rate cannot be modified" (Cannonade mods) locks the rate to the weapon's own.
  const fireRateLocked = (collected.byTarget.get('fireRateLock') ?? 0) > 0;
  const fireRate = fireRateLocked ? stats.fireRate ?? 1 : (stats.fireRate ?? 1) * (1 + bonus('fireRate'));
  const reloadTime = (stats.reloadTime ?? 0) / (1 + bonus('reloadSpeed'));
  // Magazine is an integer in game: 6 x 2.1 shows as 13, not 12.6.
  const magazineSize = Math.max(1, Math.round((stats.magazineSize ?? 1) * (1 + bonus('magazine'))));

  const crit = Math.max(1, critMultiplier);
  // Expectation over the two cases. "Non-critical hits deal +240%" (Cull the Weak) weights
  // the non-crit branch, and Vigilante moves a share of that branch into the crit branch.
  const nonCritBonus = bonus('nonCritDamage');
  const effectiveCritChance = critChance >= 1 ? 1 : critChance + (1 - critChance) * vigilante;
  const averageCritMultiplier = critChance >= 1
    ? 1 + critChance * (crit - 1)
    : (1 - effectiveCritChance) * (1 + nonCritBonus) + effectiveCritChance * crit;
  // Hit location (wiki: Enemy Body Parts). The arsenal figure assumes the usual 3x head; the
  // target's own faction multiplier is applied in hit.ts.
  const hitZone = hitZoneOf(build);
  const weakPointOverride = collected.byTarget.get('weakPointOverride') ?? 0;
  const weakPointCritChance = (stats.critChance ?? 0) * bonus('weakPointCritChance');
  const headshotMultiplier = hitZone === 'head'
    ? ((weakPointOverride || 3) + 1.5 * bonus('weakPointDamage')) * (1 + bonus('headshotMultiplier'))
    : Math.max(0, 1 + bonus('bodyshotMultiplier'));

  // Heavy attacks spend the combo counter for a damage multiplier (wiki: Melee Combo).
  const heavyMultiplier = build.heavyAttack && !spectralForm ? comboMultiplier : 1;
  const shotDamage = projectileTotal * multishot * headshotMultiplier * heavyMultiplier;
  // Head crits double the critical multiplier (wiki: Critical Headshots), weak point crit chance included.
  const shownCritMultiplier = hitZone === 'head'
    ? 1 + (critChance + weakPointCritChance) * (2 * crit - 1)
    : averageCritMultiplier;
  const averageShotDamage = shotDamage * shownCritMultiplier;

  // How many of the pellets crit: with 10 pellets at 35% you get ~3.5 crits, and the
  // chance of a shot with no crit at all is (1 - 0.35)^10 ≈ 1.3%.
  const pellets = multishot;
  const critVariance = {
    pellets,
    expectedCrits: pellets * critChance,
    atLeastOneCrit: critChance >= 1 ? 1 : 1 - Math.pow(1 - Math.min(1, critChance), pellets),
  };

  const burstDps = averageShotDamage * fireRate;
  const damagePerMagazine = averageShotDamage * Math.max(1, magazineSize);
  const cycleTime = Math.max(1, magazineSize) / Math.max(0.01, fireRate) + reloadTime;
  const sustainedDps = cycleTime > 0 ? damagePerMagazine / cycleTime : burstDps;

  const elements = (Object.entries(damage) as Array<[DamageType, number]>)
    .filter(([, amount]) => amount > 0)
    .map(([type, amount]) => ({ type, share: projectileTotal > 0 ? amount / projectileTotal : 0 }));

  return {
    weapon,
    mode,
    incarnonFormActive,
    aoeDistance: build.aoeDistance ?? null,
    damage: { perProjectile: damage, projectileTotal },
    critChance,
    critMultiplier: crit,
    statusChance,
    multishot,
    fireRate,
    reloadTime,
    magazineSize,
    shotDamage,
    averageShotDamage,
    burstDps,
    sustainedDps,
    factionBonus: Object.fromEntries(collected.faction),
    activeBuffs,
    rivenLines,
    incarnonLines,
    comboMultiplier,
    punchThrough: bonus('punchThrough'),
    critVariance,
    hitZone,
    weakPointDamageBonus: bonus('weakPointDamage'),
    headshotMultiplierBonus: bonus('headshotMultiplier'),
    bodyshotMultiplierBonus: bonus('bodyshotMultiplier'),
    weakPointCritChance,
    weakPointOverride,
    statusDamageBonus: bonus('statusDamage'),
    statusDurationBonus: bonus('statusDuration'),
    elementBonuses: collected.elementBonuses.reduce<Partial<Record<BaseElement, number>>>((acc, entry) => {
      acc[entry.element] = (acc[entry.element] ?? 0) + entry.amount;
      return acc;
    }, {}),
    forcedProcs: collected.forcedProcs,
    abilityStrength,
    debuffs: build.debuffs ?? {},
    elements,
    unsupportedMods: collected.unsupported,
    inactiveConditions: collected.inactive,
    conditionalSources: [...conditional.values()].map((entry) => ({ ...entry, conditions: [...entry.conditions] })),
    warnings: collected.warnings,
  };
}
