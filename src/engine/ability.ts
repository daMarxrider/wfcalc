/**
 * Ability damage.
 *
 * An ability that deals damage does not go through the weapon pipeline: no crit, no
 * multishot, no status. What it shares with weapons is the target maths, so this module
 * applies exactly the same rules `hitEnemy` does — health-type modifier, armour damage
 * reduction with the armour-type modifier, and the minimum-1-per-type rule on armoured
 * targets — to a flat amount of damage of one type.
 *
 * Ability Strength multiplies the base damage linearly, which the wiki states and the game
 * follows for every ability modelled here.
 */
import { armorDamageReduction, scaleEnemy, type ScaledEnemy } from './enemy.ts';
import { corrosiveArmorMultiplier, statusProcDamage, viralMultiplier } from './dot.ts';
import type { DamageType, Snapshot } from '../types.ts';

export interface AbilityCastOptions {
  /** Ability Strength as a percentage, 100 being unmodded. */
  strength?: number;
  enemy?: string;
  level?: number;
  /** Target is an Eximus: add its level-scaled Overguard. */
  eximus?: boolean;
  /** Explicit Overguard amount instead of the Eximus formula. */
  overguard?: number;
  /** Steel Path target: health and shields x2.5. */
  steelPath?: boolean;
  /** Viral stacks already on the target (the ability may add its own). */
  viralStacks?: number;
  /** Enemies hit by one cast, all inside the radius (default 1). */
  targets?: number;
  /** Alternative mode (Thermal Sunder's "heat"), when the ability has one. */
  mode?: string;
  /** Distance from the cast point, for abilities with distance falloff (Discharge). */
  distance?: number;
}

export interface AbilityCast {
  frame: string;
  ability: string;
  /** Alternative mode used, if any. */
  mode: string | null;
  /** Null when the ability deals no damage and is kept only for its armour strip. */
  damageType: DamageType | null;
  /** Damage at 100% Ability Strength. 0 when the ability deals none. */
  baseDamage: number;
  strength: number;
  /** Base damage scaled by Ability Strength, per hit or per second as the ability does. */
  scaledDamage: number;
  /** True when scaledDamage is per second. */
  perSecond: boolean;
  /** Seconds the effect lasts, when it does. */
  durationSeconds: number | null;
  /** Everything a single cast deals, ticks included, at 100% accuracy against nothing. */
  totalDamage: number;
  /** Direct damage split across types, scaled by Ability Strength. */
  damageComponents: Array<{ type: DamageType; amount: number }>;
  /** Distance from the cast point and the falloff factor it applied. */
  distance: number;
  distanceFactor: number;
  /** Ticking part of the cast, if any (Inferno's ring alongside its direct hit). */
  ticks: { perSecond: number; damageType: string | null; seconds: number } | null;
  radius: number | null;
  /**
   * Armour this cast removes, scaled by Ability Strength. Percentage strips scale linearly and
   * cap at the whole armour; Polarize drains a flat number of points. This is what a weapon
   * build benefits from, so it is reported here rather than buried in the ability.
   */
  armorStrip: { mode: 'percent' | 'flat'; fraction: number | null; points: number | null } | null;
  target: {
    enemy: string;
    level: number;
    /** Damage of this ability's type after the health-type modifier. */
    healthMultiplier: number;
    /** Fraction of damage removed by armour. */
    armorReduction: number;
    /** Damage a single cast deals to one target: direct plus the statuses it applies. */
    perCast: number;
    /** Enemies assumed inside the radius, and the whole cast's damage across them. */
    targets: number;
    totalPerCast: number;
    /** The same split into direct damage and guaranteed status damage. */
    directPerCast: number;
    statusPerCast: number;
    /** Viral stacks (existing plus applied), and the health multiplier they give. */
    viralStacks: number;
    /** Corrosive stacks the ability ramps to (Spores), and the final armour multiplier. */
    corrosiveStacks: number;
    corrosiveArmorMultiplier: number;
    /** Shield pool, direct damage per cast against it, and whether the type bypasses it. */
    shield: number;
    shieldPerCast: number;
    bypassesShield: boolean;
    /** Guaranteed procs resolved against this target. Viral has no DoT and reports 0. */
    statusProcs: Array<{ type: DamageType; stacks: number; damageType: DamageType; total: number }>;
    /** Overguard the target has, and the direct damage of one cast against it. */
    overguard: number;
    overguardPerCast: number;
    /** Casts needed to break Overguard and then remove health; shields are ignored. */
    castsToKill: number | null;
  } | null;
  notes: string[];
}

const healthModifier = (snapshot: Snapshot, type: DamageType, healthType: string): number =>
  (snapshot.modifiers[type]?.[healthType] ?? 0) / 100;

export function abilityCast(snapshot: Snapshot, abilityName: string, options: AbilityCastOptions = {}): AbilityCast {
  const wanted = abilityName.trim().toLowerCase();
  const entry = Object.values(snapshot.damageAbilities ?? {}).find(
    (ability) => ability.ability.toLowerCase() === wanted,
  );
  if (!entry) {
    const known = Object.values(snapshot.damageAbilities ?? {}).map((ability) => ability.ability);
    throw new Error(`ability not found: ${abilityName}${known.length ? ` (known: ${known.slice(0, 8).join(', ')}...)` : ''}`);
  }

  if (options.mode && entry.modes && !entry.modes[options.mode]) {
    throw new Error(`unknown mode for ${entry.ability}: ${options.mode} (known: ${Object.keys(entry.modes).join(', ')})`);
  }
  const active = options.mode && entry.modes?.[options.mode]
    ? { ...entry, ...entry.modes[options.mode] }
    : entry;
  const strength = options.strength ?? 100;
  const scaledDamage = (active.baseDamage ?? 0) * (strength / 100);
  // An ability that ticks deals its number every second for its duration: Miasma is 150 per
  // second for 6 seconds, not 150 once. Inferno is a direct hit plus a ring that ticks.
  const durationSeconds = active.durationSeconds ?? null;
  const seconds = active.perSecond && durationSeconds ? durationSeconds : 1;
  const distance = Math.max(0, options.distance ?? 0);
  const falloff = active.distanceFalloff;
  const distanceFactor = falloff
    ? distance <= falloff.start ? 1
      : distance >= falloff.end ? Math.max(0, 1 - falloff.reduction)
      : 1 - falloff.reduction * ((distance - falloff.start) / (falloff.end - falloff.start))
    : 1;
  const components = (active.damageComponents?.length
    ? active.damageComponents
    : active.damageType && active.baseDamage
      ? [{ type: active.damageType, amount: active.baseDamage }]
      : []
  ).map((component) => ({
    type: component.type as DamageType,
    amount: component.amount * (strength / 100) * seconds * distanceFactor,
  }));
  const mainTotal = components.reduce((sum, component) => sum + component.amount, 0);
  const ticks = active.extraDot
    ? {
        perSecond: active.extraDot.perSecond * (strength / 100),
        damageType: active.extraDot.damageType,
        seconds: active.extraDot.seconds,
      }
    : null;
  const totalDamage = mainTotal + (ticks ? ticks.perSecond * ticks.seconds : 0);
  const armorStrip = entry.armorStrip
    ? {
        mode: entry.armorStrip.mode,
        fraction: entry.armorStrip.mode === 'percent'
          ? Math.min(1, (entry.armorStrip.value * (strength / 100)) / 100)
          : null,
        points: entry.armorStrip.mode === 'flat'
          ? entry.armorStrip.value * (strength / 100)
          : null,
      }
    : null;
  const notes: string[] = [];
  if (active.baseDamage) {
    notes.push('Ability damage is flat: it does not crit, use multishot or roll status, and mods on the weapon do not apply.');
  } else {
    notes.push(`${entry.ability} deals no damage of its own; it is here for its armour strip.`);
  }
  if (armorStrip) {
    notes.push(
      armorStrip.mode === 'percent'
        ? `Removes ${(armorStrip.fraction! * 100).toFixed(1)}% of the target's armour; it is the weapon that benefits.`
        : `Drains ${Math.round(armorStrip.points!)} armour points; it is the weapon that benefits.`,
    );
  }

  let target: AbilityCast['target'] = null;
  if (options.enemy) {
    const enemy = snapshot.enemies[options.enemy];
    if (!enemy) throw new Error(`enemy not found: ${options.enemy}`);
    const level = options.level ?? 30;
    const scaled: ScaledEnemy = scaleEnemy(snapshot, enemy, level, {
      eximus: options.eximus,
      overguard: options.overguard,
      steelPath: options.steelPath,
    });
    // A pool's `amount` is its level-1 value: the scaled totals live on the enemy itself.
    const armor = scaled.pools.find((pool) => pool.category === 'armor');
    const shields = scaled.pools.filter((pool) => pool.category === 'shield');
    const shieldType = shields[0]?.type ?? null;
    // Damage 3.0: one modifier per faction health class, applied to every pool.
    const healthClass = scaled.enemy.healthClass;
    const healthPool = scaled.health;
    const armorAmount = scaled.armor;

    // A status that ramps over the cast (Spores' Corrosive): expected procs per second, capped.
    // The ability's own damage uses the average strip over the window; the final strip is
    // reported so the weapon can be priced with --corrosive N.
    const ramp = active.statusRamp;
    let corrosiveStacks = 0;
    let corrosiveFinalMultiplier = 1;
    let rampedArmor = armorAmount;
    if (falloff) {
      notes.push(`Distance ${distance} m: damage x${distanceFactor.toFixed(2)} (linear falloff to ${(1 - falloff.reduction) * 100}% at ${falloff.end} m).`);
    }
    if (ramp) {
      const window = durationSeconds ?? 10;
      const capTime = ramp.maxStacks / Math.max(1e-9, ramp.procsPerSecond);
      const averageStacks = window <= capTime
        ? (ramp.procsPerSecond * window) / 2
        : ((ramp.procsPerSecond * capTime * capTime) / 2 + ramp.maxStacks * (window - capTime)) / window;
      corrosiveStacks = Math.min(ramp.maxStacks, ramp.procsPerSecond * window);
      corrosiveFinalMultiplier = corrosiveArmorMultiplier(corrosiveStacks);
      rampedArmor = armorAmount * corrosiveArmorMultiplier(Math.min(ramp.maxStacks, averageStacks));
    }

    if (!active.damageType || !active.baseDamage) {
      // Nothing to damage: only the strip matters, and it is already reported above.
      return {
        frame: entry.frame, ability: entry.ability, mode: options.mode ?? null, damageType: active.damageType,
        baseDamage: 0, strength, scaledDamage, perSecond: Boolean(active.perSecond),
        durationSeconds, totalDamage, ticks, damageComponents: [], distance, distanceFactor, radius: entry.radius ?? null,
        armorStrip, target: null, notes,
      };
    }
    // Viral from the ability itself and from stacks the player already keeps up; it amplifies
    // all damage to health, including the status damage below.
    const declaredProcs = active.statusProcs ?? [];
    const appliedViral = declaredProcs
      .filter((proc) => proc.type === 'viral')
      .reduce((sum, proc) => sum + proc.stacks, 0);
    const viralStacks = Math.max(options.viralStacks ?? 0, appliedViral);
    const viral = viralMultiplier(viralStacks);

    // Each component keeps its own damage type, so each gets its own modifiers.
    const against = (type: DamageType, amount: number): { dealt: number; healthMod: number; dr: number } => {
      const healthMod = healthModifier(snapshot, type, healthClass);
      const dr = armor ? armorDamageReduction(rampedArmor) : 0;
      // Same floor rule as weapons: on an armoured target every damage type deals at least 1.
      return { dealt: Math.max(amount * (1 + healthMod) * (1 - dr) * viral, armor ? 1 : 0), healthMod, dr };
    };

    const main = components.reduce(
      (total, component) => {
        const hit = against(component.type, component.amount);
        return {
          dealt: total.dealt + hit.dealt,
          healthMod: total.healthMod || hit.healthMod,
          dr: total.dr || hit.dr,
        };
      },
      { dealt: 0, healthMod: 0, dr: 0 },
    );
    const extra = ticks?.damageType ? against(ticks.damageType as DamageType, ticks.perSecond * ticks.seconds) : null;
    const directPerCast = main.dealt + (extra?.dealt ?? 0);
    const healthMod = main.healthMod;
    const dr = main.dr;

    const resolvedProcs = declaredProcs.map((proc) => {
      if (proc.type === 'viral') return { type: proc.type, stacks: proc.stacks, damageType: proc.type, total: 0 };
      const seed = proc.seed !== undefined
        ? proc.seed * (strength / 100) * seconds
        : scaledDamage * (proc.seedFraction ?? 1);
      const dot = statusProcDamage(snapshot, proc.type, seed, scaled, { armorBase: armor?.amount }, viralStacks);
      return {
        type: proc.type,
        stacks: proc.stacks,
        damageType: dot?.damageType ?? proc.type,
        total: (dot?.total ?? 0) * proc.stacks,
      };
    });
    const statusPerCast = resolvedProcs.reduce((sum, proc) => sum + proc.total, 0);
    const perCast = directPerCast + statusPerCast;

    // Overguard is neutral except Void (+50%), ignores armour, and is a separate layer first.
    const againstOverguard = (type: DamageType, amount: number): number =>
      amount * (1 + healthModifier(snapshot, type, 'Overguard'));
    const overguardPerCast = components.reduce((sum, component) => sum + againstOverguard(component.type, component.amount), 0)
      + (ticks?.damageType ? againstOverguard(ticks.damageType as DamageType, ticks.perSecond * ticks.seconds) : 0);
    // Shields are a pool of their own: no armour, and the faction modifier applies to them too.
    // Toxin is the documented shield-bypassing type (the same rule weapons use).
    const againstShield = (type: DamageType, amount: number): number =>
      amount * (1 + (shieldType ? healthModifier(snapshot, type, healthClass) : 0));
    const shieldPerCast = shieldType
      ? components.reduce((sum, component) => sum + againstShield(component.type, component.amount), 0)
        + (ticks?.damageType ? againstShield(ticks.damageType as DamageType, ticks.perSecond * ticks.seconds) : 0)
      : 0;
    const bypassesShield = active.damageType === 'toxin';
    const overguardCasts = scaled.overguard > 0 && overguardPerCast > 0
      ? Math.ceil(scaled.overguard / overguardPerCast)
      : 0;
    const healthCasts = perCast > 0 && healthPool > 0 ? Math.ceil(healthPool / perCast) : 0;
    const shieldCasts = !bypassesShield && scaled.shield > 0 && shieldPerCast > 0
      ? Math.ceil(scaled.shield / shieldPerCast)
      : 0;
    const shieldsUnbreakable = scaled.shield > 0 && !bypassesShield && shieldPerCast <= 0;
    const castsToKill = (scaled.overguard > 0 && overguardPerCast <= 0) || shieldsUnbreakable
      ? null
      : overguardCasts + shieldCasts + healthCasts > 0
        ? overguardCasts + shieldCasts + healthCasts
        : null;

    const targets = Math.max(1, Math.floor(options.targets ?? 1));
    target = {
      enemy: enemy.name,
      level,
      healthMultiplier: 1 + healthMod,
      armorReduction: dr,
      perCast,
      targets,
      totalPerCast: perCast * targets,
      directPerCast,
      statusPerCast,
      viralStacks,
      corrosiveStacks,
      corrosiveArmorMultiplier: corrosiveFinalMultiplier,
      shield: scaled.shield,
      shieldPerCast,
      bypassesShield,
      statusProcs: resolvedProcs,
      overguard: scaled.overguard,
      overguardPerCast,
      castsToKill,
    };
    if (armor) {
      notes.push(`Target armour ${Math.round(rampedArmor)} reduces this type by ${(dr * 100).toFixed(1)}%${ramp ? ' (average after the Corrosive ramp)' : ''}.`);
    }
    if (ramp) {
      notes.push(`Corrosive ramp: ~${ramp.procsPerSecond}/s, ${Math.round(corrosiveStacks)} stacks (${((1 - corrosiveFinalMultiplier) * 100).toFixed(0)}% armour strip); price the weapon with --corrosive ${Math.round(corrosiveStacks)}.`);
    }
    if (components.length > 1) {
      notes.push(`Damage split: ${components.map((component) => `${Math.round(component.amount)} ${component.type}`).join(' + ')}.`);
    }
    if (declaredProcs.length) {
      const lines = resolvedProcs.map((proc) => proc.total > 0
        ? `${proc.stacks}x ${proc.type}: ${Math.round(proc.total)} damage per cast`
        : `${proc.stacks}x ${proc.type}: no direct damage, health damage x${viralMultiplier(viralStacks).toFixed(2)}`);
      notes.push(`Guaranteed status: ${lines.join('; ')}.`);
    }
    if (scaled.shield > 0) {
      notes.push(bypassesShield
        ? `${active.damageType} bypasses shields: ${Math.round(scaled.shield)} shield remains untouched.`
        : `Shields ${Math.round(scaled.shield)}: ${Math.round(shieldPerCast)} per cast; castsToKill includes them.`);
    }
    if (scaled.overguard > 0) {
      notes.push(`Overguard ${Math.round(scaled.overguard)} is a separate layer: status DoT and Magnetic amplification are not modelled.`);
    }
  }

  return {
    frame: entry.frame,
    ability: entry.ability,
    mode: options.mode ?? null,
    damageType: active.damageType,
    baseDamage: active.baseDamage ?? 0,
    strength,
    scaledDamage,
    perSecond: Boolean(active.perSecond),
    durationSeconds,
    totalDamage,
    damageComponents: components,
    distance,
    distanceFactor,
    ticks,
    radius: entry.radius ?? null,
    armorStrip,
    target,
    notes,
  };
}
