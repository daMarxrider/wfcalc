/**
 * Turns a brute-force request into the flat arrays the GPU pre-filter reads (src/web/gpu-search.js).
 *
 * Each candidate becomes a vector of additive channels, read off the engine itself: the build's
 * summed bonuses with the candidate minus without it, at 1 and at 2 status types, so per-status
 * bonuses (Galvanized Aptitude, Condition Overload) scale with each combination's own types.
 */
import type { Build, BuildMod } from './build.ts';
import { resolveBuild } from './build.ts';
import { exilusCost, gpuPlan, modElement, twinRequirements, type BruteForcePlan, type BruteForceRequest } from './bruteforce.ts';
import { effectiveArmor } from './dot.ts';
import { scaleEnemy } from './enemy.ts';
import { hitProfile, weakPointBase } from './hit.ts';
import { rivenAsMod, type RivenSpec } from './riven.ts';
import { beamStart } from './simulate.ts';
import { BASE_ELEMENTS, DAMAGE_TYPES, type Snapshot } from '../types.ts';
import { AMMO_FIELDS, AMMO_SLOTS, CH, CHANNELS, P, STRIDE, binomial } from '../web/gpu-search.js';

export interface GpuModel {
  candidates: string[];
  /** Mods per combination. */
  slots: number;
  /** How many of the best combinations come back for the exact pass. */
  keep: number;
  combinations: number;
  params: number[];
  vectors: number[];
  clash: number[];
  /** Per candidate, the candidate it needs beside it (a drawback twin's clean mod), or -1. */
  requires: number[];
}

const NC = CHANNELS.length;
const SETS = { vigilante: 'Vigilante Set', gladiator: 'Gladiator Set' } as const;

export function gpuModel(snapshot: Snapshot, request: BruteForceRequest, keep = 20_000): GpuModel {
  const plan = gpuPlan(snapshot, request);
  return vectorModel(snapshot, plan, plan.candidates.map((name) => ({ name, mods: [{ name }] })), keep, twinRequirements(snapshot, plan));
}

/** What a model needs from a plan: the target, the fixed loadout and the capacity. */
export type ModelPlan = Pick<BruteForcePlan, 'weapon' | 'enemy' | 'fixed' | 'exilus' | 'base' | 'level' | 'eximus'
  | 'overguard' | 'steelPath' | 'simulate' | 'objective' | 'requireStatus' | 'capacity' | 'maxForma' | 'freeSlots'>;

/** One vector of the model: a mod, or a riven stat (as a one-stat riven with the given value). */
export interface ModelItem {
  name: string;
  mods?: BuildMod[];
  riven?: RivenSpec;
  /** Base element index for the elemental order (heat 0 ... toxin 3), when not read off the mod. */
  element?: number;
}

/** The flat arrays for a set of items over a plan's fixed loadout (see src/web/gpu-search.js). */
export function vectorModel(snapshot: Snapshot, plan: ModelPlan, items: ModelItem[], keep: number, requires: number[]): GpuModel {
  const weapon = snapshot.weapons[plan.weapon];
  const enemy = snapshot.enemies[plan.enemy];
  const baseMods: BuildMod[] = [...plan.fixed, ...(plan.exilus ? [plan.exilus] : [])];
  const faction = (enemy.faction ?? '').toLowerCase();

  const resolve = (mods: BuildMod[], statusTypes: number, riven?: RivenSpec) => resolveBuild(snapshot, {
    ...plan.base, weapon: weapon.name, mods, quantize: false, ...(riven ? { riven } : {}),
    conditions: { ...(plan.base.conditions ?? {}), statusTypes },
  } as Build);
  const channels = (mods: BuildMod[], statusTypes: number, riven?: RivenSpec): number[] => {
    const resolved = resolve(mods, statusTypes, riven);
    const totals = resolved.bonusTotals;
    const out = new Array<number>(NC).fill(0);
    for (const name of ['baseDamage', 'overloadAdd', 'directDamage', 'critChance', 'critChanceFlat', 'critDamage', 'critDamageFlat',
      'statusChance', 'statusChanceFlat', 'multishot', 'fireRate', 'fireRateLock', 'reloadSpeed', 'magazine', 'statusDamage',
      'statusDuration', 'weakPointDamage', 'headshotMultiplier', 'bodyshotMultiplier', 'weakPointCritChance', 'baseDamageFlat']) {
      out[CH[name]] = totals[name] ?? 0;
    }
    // A product of (1 + x) factors, not a sum: kept as its excess over 1.
    out[CH.damageMultiplier] = (totals.damageMultiplier ?? 1) - 1;
    for (const type of ['impact', 'puncture', 'slash'] as const) out[CH[`type:${type}`]] = totals[type] ?? 0;
    for (const type of DAMAGE_TYPES) {
      if (totals[`element:${type}`]) out[CH[`type:${type}`]] += totals[`element:${type}`];
    }
    for (const element of BASE_ELEMENTS) out[CH[`type:${element}`]] += resolved.elementBonuses[element] ?? 0;
    out[CH.faction] = (resolved.factionBonus[faction] ?? 0) + (resolved.factionBonus.all ?? 0);
    for (const proc of resolved.forcedProcs) out[CH[`${proc.requiresCrit ? 'forcedCrit' : 'forced'}:${proc.type}`]] += proc.chance;
    out[CH.vigilante] = mods.filter((mod) => snapshot.mods[mod.name]?.set === SETS.vigilante).length;
    out[CH.gladiator] = mods.filter((mod) => snapshot.mods[mod.name]?.set === SETS.gladiator).length;
    return out;
  };

  const baseA = channels(baseMods, 1);
  const baseB = channels(baseMods, 2).map((value, c) => value - baseA[c]);
  const halfCost = (name: string): number => {
    const mod = snapshot.mods[name];
    return Math.ceil(((mod.baseDrain ?? 0) + mod.maxRank) / 2);
  };
  const vectors: number[] = [];
  for (const item of items) {
    const mods = [...baseMods, ...(item.mods ?? [])];
    let a: number[];
    let b: number[];
    let drain = (item.mods ?? []).reduce((sum, mod) => sum + halfCost(mod.name), 0);
    try {
      a = channels(mods, 1, item.riven);
      b = channels(mods, 2, item.riven).map((value, c) => value - a[c] - baseB[c]);
      a = a.map((value, c) => value - baseA[c]);
    } catch {
      // The engine refuses this mod with the fixed ones: it can never be part of a build.
      a = new Array<number>(NC).fill(0);
      b = new Array<number>(NC).fill(0);
      drain = 1e9;
    }
    const element = item.element ?? (item.mods?.length === 1 ? modElement(snapshot.mods[item.mods[0].name]) : null);
    vectors.push(...a, ...b, drain, typeof element === 'number' ? element : element ? BASE_ELEMENTS.indexOf(element) : -1);
  }
  if (vectors.length !== items.length * STRIDE) throw new Error('gpu model: vector size mismatch');

  // Incompatible pairs as two 32-bit masks per candidate, set both ways whichever mod names the other.
  const names = items.map((item) => item.name);
  const index = new Map(names.map((name, i) => [name, i]));
  const clash = new Array<number>(2 * items.length).fill(0);
  const mark = (i: number, j: number): void => {
    const word = 2 * i + (j < 32 ? 0 : 1);
    clash[word] = (clash[word] | (1 << (j % 32))) >>> 0;
  };
  names.forEach((name, i) => {
    for (const other of snapshot.mods[name]?.incompatible ?? []) {
      const j = index.get(other);
      if (j !== undefined) { mark(i, j); mark(j, i); }
    }
  });

  const zero = resolve(baseMods, Number(plan.base.conditions?.statusTypes ?? 1));
  const stats = zero.baseStats;
  const scaled = scaleEnemy(snapshot, enemy, plan.level, { eximus: plan.eximus, overguard: plan.overguard, steelPath: plan.steelPath });
  const armorPool = scaled.pools.find((pool) => pool.category === 'armor');
  const hasShield = scaled.pools.some((pool) => pool.category === 'shield');
  const modifier = (type: string, healthClass: string): number => (snapshot.modifiers[type]?.[healthClass] ?? 0) / 100;
  const params = new Array<number>(P.size).fill(0);
  DAMAGE_TYPES.forEach((type, t) => {
    params[P.stats + t] = stats[type] ?? 0;
    params[P.healthMod + t] = modifier(type, enemy.healthClass);
    params[P.overguardMod + t] = modifier(type, 'Overguard');
  });
  params[P.critChance] = stats.critChance ?? 0;
  params[P.critMultiplier] = stats.critMultiplier ?? 1;
  params[P.statusChance] = stats.statusChance ?? 0;
  params[P.multishot] = stats.multishot ?? 1;
  params[P.fireRate] = stats.fireRate ?? 1;
  // Shell-by-shell reloads (traits.ts): the delay here, the per-shell part scales with the capacity.
  params[P.reloadTime] = zero.shellReload ? zero.shellReload.delay : stats.reloadTime ?? 0;
  params[P.reloadPerShell] = zero.shellReload?.perShell ?? 0;
  params[P.shellMagazine] = stats.magazineSize ?? 1;
  // A timed trait buff (Athodai's Overdrive) is in the fixed part: the shader blends it by uptime.
  const plain = zero.timedBuff?.off;
  params[P.timedSeconds] = plain ? zero.timedBuff!.seconds : 0;
  params[P.timedFireRate] = plain ? (zero.bonusTotals.fireRate ?? 0) - (plain.bonusTotals.fireRate ?? 0) : 0;
  // Ammo (ammo.ts): the fixed part's Ammo Efficiency, its multiplicative sources (Overdrive's
  // Infinite Ammo is one, gone in the plain state) and its timed buffs.
  const scale = (multipliers: number[]) => multipliers.reduce((cost, value) => cost * (1 - Math.min(1, value)), 1);
  params[P.ammoEfficiency] = zero.ammo.efficiency;
  params[P.ammoScale] = scale(zero.ammo.multipliers);
  params[P.plainAmmoScale] = scale((plain ?? zero).ammo.multipliers);
  const buffs = zero.ammo.buffs;
  // shortcut: the first AMMO_SLOTS timed buffs only (no build has more today); a bigger table if one does.
  const ammoSlots = buffs.slice(0, AMMO_SLOTS);
  ammoSlots.forEach((buff, i) => {
    const at = P.ammoBuffs + i * AMMO_FIELDS;
    params[at] = buff.chance;
    params[at + 1] = buff.seconds;
    params[at + 2] = buff.refresh ? 1 : 0;
    params[at + 3] = buff.efficiency;
    params[at + 4] = buff.every ?? 1;
    params[at + 5] = buff.trigger === 'weakPointKill' ? 1 : 0;
  });
  params[P.killBuffs] = ammoSlots.some((buff) => buff.trigger === 'weakPointKill') ? 1 : 0;
  params[P.cryogenic] = zero.cryogenicStacks ?? 0;
  // A held beam's starting share of full damage (simulate.ts), 0 for anything else.
  params[P.beamStart] = beamStart(zero) ?? 0;
  params[P.madurai] = zero.bonusTotals.maduraiPhysical ?? 0;
  params[P.comboFactor] = Math.max(0, zero.comboMultiplier - 1);
  // The player's strips are fixed; Corrosive and Heat build up per combination, in the shader.
  params[P.armor] = effectiveArmor(scaled.armor, { ...zero.debuffs, armorBase: armorPool?.amount, corrosiveStacks: 0, heatStrip: 0 });
  params[P.armored] = armorPool ? 1 : 0;
  params[P.health] = scaled.health;
  params[P.shield] = hasShield ? scaled.shield : 0;
  params[P.overguard] = scaled.overguard;
  params[P.toxinBypass] = enemy.toxinBypassesShields ? 1 : 0;
  params[P.head] = zero.hitZone === 'head' ? 1 : 0;
  params[P.weakPointBase] = weakPointBase(enemy.faction);
  params[P.critHeadshot] = hitProfile({ ...zero, hitZone: 'head' }, enemy.faction).critHeadshot ? 1 : 0;
  params[P.weakPointOverride] = zero.weakPointOverride;
  params[P.viralFloor] = zero.debuffs.viralStacks ?? 0;
  params[P.corrosiveFloor] = zero.debuffs.corrosiveStacks ?? 0;
  params[P.corrosiveCap] = 10 + (zero.corrosiveCapBonus ?? 0);
  params[P.toxinStatusBonus] = zero.toxinStatusDamageBonus ?? 0;
  params[P.overguardMultiplier] = zero.overguardDamageMultiplier ?? 1;
  params[P.fixedStatusTypes] = plan.base.conditions?.statusTypes !== undefined ? Number(plan.base.conditions.statusTypes) : -1;
  params[P.extraStatusTypes] = Math.max(0, Number(plan.base.extraStatusTypes ?? 0));
  params[P.requireMask] = plan.requireStatus.reduce((mask, type) => mask | (1 << DAMAGE_TYPES.indexOf(type)), 0);
  params[P.fixedElementMask] = plan.fixed.reduce((mask, mod) => {
    const element = modElement(snapshot.mods[mod.name]);
    return element ? mask | (1 << BASE_ELEMENTS.indexOf(element)) : mask;
  }, 0);
  for (const [key, set] of Object.entries(SETS)) {
    const table = snapshot.setBonuses[set]?.table ?? {};
    for (let count = 0; count < 8; count++) {
      const reached = Object.keys(table).map(Number).filter((pieces) => pieces <= count).sort((a, b) => b - a)[0];
      params[P[key] + count] = reached !== undefined ? table[String(reached)] ?? 0 : 0;
    }
  }
  // Drain lower bound (every mod in a matching slot): exact with unlimited Forma, a pre-filter
  // with a Forma budget (the exact pass checks the real placement).
  const rivenMod = plan.base.riven ? rivenAsMod(plan.base.riven) : null;
  const fixedHalf = [
    ...plan.fixed.map((mod) => (snapshot.mods[mod.name].baseDrain ?? 0) + (mod.rank ?? 0)),
    ...(rivenMod ? [rivenMod.baseDrain ?? 0] : []),
  ].reduce((sum, full) => sum + Math.ceil(full / 2), 0);
  const exilusDrain = exilusCost(snapshot, weapon, plan.exilus, plan.maxForma).drain;
  params[P.capacityHalf] = plan.capacity - exilusDrain - fixedHalf;
  // The exact ranking estimates the status build-up only when the fight is simulated.
  params[P.steady] = plan.simulate ? 1 : 0;
  params[P.kpm] = plan.objective === 'kpm' ? 1 : 0;

  const slots = Math.min(plan.freeSlots, items.length);
  return {
    candidates: names,
    slots,
    keep,
    combinations: binomial(items.length, slots),
    params: [...params, ...baseA, ...baseB],
    vectors,
    clash,
    requires,
  };
}
