/**
 * Exhaustive build search.
 *
 * `search.ts` is a greedy fill plus local search: fast, and usually right, but it can stop on a
 * local optimum. This module enumerates every feasible combination of mods instead and scores
 * each one with the same engine, so the answer is the best build that exists within the
 * candidate set, not merely a good one.
 *
 * What the player decides is fixed, not searched: the mods they pin (`fixed`), and everything in
 * `base` (Warframe buffs and Ability Strength, Incarnon evolutions, arcanes, riven, debuffs).
 * The target (enemy, level, Steel Path, Eximus) is scaled once.
 *
 * Cost control, stated rather than hidden:
 *   - Combinations that exceed the mod capacity or the Forma budget, or pair incompatible mods
 *     (Serration + Amalgam Serration), are pruned as a branch, never evaluated.
 *   - Elemental order changes the result, but only through which elements pair up. Each
 *     combination is evaluated once per distinct pairing (at most 3 for four elements), not once
 *     per permutation (24).
 *   - When every candidate fits in the evaluation budget the search is fully exhaustive. When it
 *     does not, it is exhaustive over a shortlist ranked from the greedy search's best builds,
 *     and the result says so and names the mods that were left out.
 *   - Work is split across worker threads; every worker walks the same tree and evaluates its
 *     own share of the leaves, so the split needs no coordination and is deterministic.
 */
import { availableParallelism } from 'node:os';
import { Worker } from 'node:worker_threads';
import type { Build, BuildMod } from './build.ts';
import { resolveBuild, statsForMode } from './build.ts';
import { hitEnemy } from './damage.ts';
import type { SimulationResult } from './simulate.ts';
import { scaleEnemy, type ScaledEnemy } from './enemy.ts';
import type { AttenuationProfile } from './attenuation.ts';
import { fitMods, search, searchableMods } from './search.ts';
import { InputError } from '../errors.ts';
import { rivenAsMod } from './riven.ts';
import { loadSnapshot, modsForWeapon } from '../data.ts';
import { BASE_ELEMENTS, ELEMENT_COMBINATIONS, type BaseElement, type DamageType, type ModData, type Snapshot, type WeaponData } from '../types.ts';

/** The eight standard mod slots. */
const STANDARD_SLOTS = 8;

export interface BruteForceRequest {
  weapon: string;
  enemy?: string;
  level?: number;
  /** Steel Path target: health and shields x2.5. `level` is the enemy's actual level. */
  steelPath?: boolean;
  eximus?: boolean;
  overguard?: number;
  attenuation?: string | AttenuationProfile | null;
  /** `ttk` minimises time to kill the target; `dps` maximises damage per second against it. */
  objective?: 'ttk' | 'dps';
  /** Mod capacity: 30, or 60 with an Orokin Catalyst. */
  capacity?: number;
  /** How many Forma the player is willing to spend; null means as many as needed. */
  maxForma?: number | null;
  /** Mods that are always equipped, optionally under-ranked. An Exilus mod goes in the Exilus slot. */
  fixed?: Array<string | BuildMod>;
  /** Mods the player does not own. */
  exclude?: string[];
  /** Everything the player decides: buffs, Ability Strength, Incarnon, arcanes, riven, debuffs. */
  base?: Partial<Build>;
  /**
   * Status effects build up over the fight (simulate.ts). Every combination is ranked with their
   * steady-state stacks, and the best `rerank` are simulated shot by shot for the final order.
   * Default true; false keeps the plain steady-state model throughout.
   */
  simulate?: boolean;
  /** How many of the best combinations to simulate (default: 40 x limit, at least 200). */
  rerank?: number;
  /** Shortlist size. Omitted: as many candidates as `maxEvaluations` allows. */
  pool?: number;
  /** Upper bound on combinations to evaluate; decides the automatic shortlist size. */
  maxEvaluations?: number;
  /** How many builds to return. */
  limit?: number;
  /**
   * Worker threads; 1 runs in the calling thread. Default: every core. Workers load the snapshot
   * from `snapshotPath` (default: the bundled one), so a snapshot built in memory runs in-thread.
   */
  workers?: number;
  snapshotPath?: string;
  /** Called with (combinations evaluated, combinations planned) while the search runs. */
  onProgress?: (done: number, total: number) => void;
}

/** Everything a shard needs to walk the tree; plain data so it can cross into a worker. */
export interface BruteForcePlan {
  weapon: string;
  objective: 'ttk' | 'dps';
  enemy: string;
  level: number;
  capacity: number;
  maxForma: number | null;
  /** Fixed mods in the standard slots. */
  fixed: BuildMod[];
  /** Fixed Exilus mod, if any: equipped, drains capacity, takes no standard slot. */
  exilus: BuildMod | null;
  /** Mods the enumeration chooses from, best-ranked first. */
  candidates: string[];
  /** Standard slots left for the candidates. */
  freeSlots: number;
  /** Upper bound on leaves (binomial), for progress and for sizing the shortlist. */
  plannedCombinations: number;
  /** True when `candidates` is every mod that could matter, so the result is exact. */
  exhaustive: boolean;
  /** Candidates that were ranked out of the shortlist. */
  leftOut: string[];
  base: Partial<Build>;
  simulate: boolean;
  steelPath: boolean;
  eximus: boolean;
  overguard?: number;
  attenuation?: string | AttenuationProfile | null;
  assumptions: string[];
  notes: string[];
}

export interface ScoredCombination {
  /** Mods in slot order (fixed first, then the chosen ones in their best elemental order). */
  mods: BuildMod[];
  score: number;
}

export interface ShardResult {
  top: ScoredCombination[];
  evaluated: number;
  combinations: number;
}

export interface BruteForceBuild {
  mods: Array<{ name: string; rank: number; drain: number; polarity: string | null; halvedByPolarity: boolean; fixed: boolean }>;
  exilus: { name: string; rank: number } | null;
  capacityUsed: number;
  capacity: number;
  formaNeeded: number;
  damagePerShot: number;
  burstDps: number;
  sustainedDps: number;
  /** Damage per second against this target, status damage included. */
  totalDps: number;
  timeToKill: number | null;
  shotsToKill: number | null;
  critChance: number;
  critMultiplier: number;
  statusChance: number;
  multishot: number;
  /** Damage composition per projectile, largest first. */
  elements: Array<{ type: DamageType; share: number }>;
  /** The riven's stat lines, when the build has one. */
  riven: string[];
  /** From the fight simulation: status stacks on the target when it died, and damage by source. */
  statusAtKill: SimulationResult['atEnd'] | null;
  damageBySource: Record<string, number> | null;
  warnings: string[];
}

export interface BruteForceResult {
  weapon: string;
  objective: 'ttk' | 'dps';
  enemy: string;
  level: number;
  steelPath: boolean;
  health: number;
  shield: number;
  armor: number;
  overguard: number;
  capacity: number;
  /** Feasible combinations visited and builds scored (one per elemental pairing). */
  combinations: number;
  evaluated: number;
  elapsedMs: number;
  workers: number;
  exhaustive: boolean;
  candidates: string[];
  leftOut: string[];
  builds: BruteForceBuild[];
  assumptions: string[];
  notes: string[];
}

function binomial(n: number, k: number): number {
  if (k < 0 || k > n) return 0;
  let result = 1;
  for (let i = 1; i <= k; i++) result = (result * (n - k + i)) / i;
  return Math.round(result);
}

/** Leaves of the enumeration: every set of up to `slots` candidates (a full set when possible). */
function combinationBound(candidates: number, slots: number): number {
  return binomial(candidates, Math.min(slots, candidates));
}

function findMod(snapshot: Snapshot, name: string): ModData {
  const exact = snapshot.mods[name];
  if (exact) return exact;
  const wanted = name.trim().toLowerCase();
  const found = Object.values(snapshot.mods).find((mod) => mod.name.toLowerCase() === wanted);
  if (!found) throw new InputError(`unknown mod: ${name}`, 'unknown_mod');
  return found;
}

/** The base element a mod adds, if any: what decides its place in the elemental hierarchy. */
function modElement(mod: ModData | undefined): BaseElement | null {
  for (const effect of mod?.effects ?? []) {
    if (effect.target === 'element' && effect.element && (BASE_ELEMENTS as readonly string[]).includes(effect.element) && effect.value > 0) {
      return effect.element as BaseElement;
    }
  }
  return null;
}

/** Innate base elements of the profile the build fires, in the hierarchy's HCET order. */
function innateElements(weapon: WeaponData, base: Partial<Build>): BaseElement[] {
  const stats = base.incarnon?.length && weapon.incarnonForm ? weapon.incarnonForm : statsForMode(weapon, base.mode).stats;
  return BASE_ELEMENTS.filter((element) => (stats[element] ?? 0) > 0 || base.elementBonus?.type === element);
}

/** Which damage types a hierarchy produces: the key for "these two orders are the same build". */
function pairingSignature(hierarchy: BaseElement[]): string {
  const result: string[] = [];
  for (let index = 0; index < hierarchy.length; index += 2) {
    const first = hierarchy[index];
    const second = hierarchy[index + 1];
    if (!second) { result.push(first); continue; }
    const combined = Object.entries(ELEMENT_COMBINATIONS).find(([, pair]) => pair.includes(first) && pair.includes(second));
    result.push(combined ? combined[0] : `${first}+${second}`);
  }
  return result.sort().join(',');
}

/**
 * Slot orders worth evaluating for a set of mods: one per distinct elemental pairing.
 * Non-elemental mods keep their place; elemental mods are grouped by element, in the order of
 * each permutation of the distinct elements.
 */
export function elementalOrders(mods: BuildMod[], elementOf: (name: string) => BaseElement | null, innate: BaseElement[]): BuildMod[][] {
  const distinct: BaseElement[] = [];
  for (const mod of mods) {
    const element = elementOf(mod.name);
    if (element && !distinct.includes(element)) distinct.push(element);
  }
  if (distinct.length < 2) return [mods];

  const orders: BuildMod[][] = [];
  const seen = new Set<string>();
  const permute = (rest: BaseElement[], chosen: BaseElement[]): void => {
    if (!rest.length) {
      const hierarchy = [...chosen, ...innate.filter((element) => !chosen.includes(element))];
      const signature = pairingSignature(hierarchy);
      if (seen.has(signature)) return;
      seen.add(signature);
      const plain = mods.filter((mod) => !elementOf(mod.name));
      const elemental = chosen.flatMap((element) => mods.filter((mod) => elementOf(mod.name) === element));
      orders.push([...elemental, ...plain]);
      return;
    }
    for (let i = 0; i < rest.length; i++) permute([...rest.slice(0, i), ...rest.slice(i + 1)], [...chosen, rest[i]]);
  };
  permute(distinct, []);
  return orders;
}

/**
 * Validates the request and decides the candidate set.
 *
 * The shortlist (when the full set is too large) is ranked by how much each mod is worth inside
 * the greedy search's best builds: the score of each build with that mod swapped into its best
 * slot. That measures a mod in the company it would actually keep, which a mod-on-its-own score
 * does not (Vital Sense is worthless alone and essential next to Point Strike). The two best mods
 * of every base element are always kept, because the best elemental pairing is the decision a
 * greedy seed is most likely to get wrong.
 */
export function planBruteForce(snapshot: Snapshot, request: BruteForceRequest): BruteForcePlan {
  const weapon = snapshot.weapons[request.weapon];
  if (!weapon) throw new InputError(`unknown weapon: ${request.weapon}`, 'unknown_weapon');
  const enemyName = request.enemy ?? 'Bombard';
  const enemy = snapshot.enemies[enemyName];
  if (!enemy) throw new InputError(`unknown enemy: ${enemyName}`, 'unknown_enemy');

  const objective = request.objective ?? 'ttk';
  const level = request.level ?? 150;
  const capacity = request.capacity ?? 60;
  const maxForma = request.maxForma ?? null;
  const maxEvaluations = request.maxEvaluations ?? 2_000_000;
  const assumptions: string[] = [];
  const notes: string[] = [];

  // Melee: Blood Rush and Weeping Wounds are worth nothing at 1x combo, so the same 12x
  // assumption as the greedy search applies unless the player gave a combo count.
  const assumedCombo = weapon.category === 'melee' && request.base?.comboHits === undefined;
  const base: Partial<Build> = assumedCombo ? { ...(request.base ?? {}), comboHits: 220 } : { ...(request.base ?? {}) };
  if (assumedCombo) assumptions.push('Melee combo assumed at 12x (220 hits)');

  // Fixed mods: resolve names, keep ranks, split off an Exilus mod.
  const fitting = new Set(modsForWeapon(snapshot, weapon).map((mod) => mod.name));
  const fixed: BuildMod[] = [];
  let exilus: BuildMod | null = null;
  for (const entry of request.fixed ?? []) {
    const wanted = typeof entry === 'string' ? { name: entry } : entry;
    const mod = findMod(snapshot, wanted.name);
    if (!fitting.has(mod.name)) throw new InputError(`${mod.name} does not fit ${weapon.name}`, 'mod_does_not_fit');
    const resolved: BuildMod = { name: mod.name, rank: Math.min(wanted.rank ?? mod.maxRank, mod.maxRank) };
    if ([...fixed, ...(exilus ? [exilus] : [])].some((other) => other.name === mod.name)) {
      throw new InputError(`duplicate fixed mod: ${mod.name}`, 'duplicate_mod');
    }
    if (mod.isExilus && !exilus) exilus = resolved;
    else fixed.push(resolved);
  }
  const fixedNames = new Set([...fixed, ...(exilus ? [exilus] : [])].map((mod) => mod.name));
  for (const name of fixedNames) {
    const clash = snapshot.mods[name].incompatible.find((other) => fixedNames.has(other));
    if (clash) throw new InputError(`fixed mods ${name} and ${clash} cannot be equipped together`, 'incompatible_mods');
  }

  // A riven occupies one of the eight slots.
  const rivenSlot = base.riven ? 1 : 0;
  const freeSlots = STANDARD_SLOTS - fixed.length - rivenSlot;
  if (freeSlots < 0) throw new InputError(`too many fixed mods: ${fixed.length} (+${rivenSlot} riven) for ${STANDARD_SLOTS} slots`, 'too_many_mods');
  const rivenMod = base.riven ? rivenAsMod(base.riven) : null;
  if (rivenSlot && !rivenMod) notes.push('The riven takes one standard slot; give its drain (and polarity) to count it against capacity.');
  if (rivenMod) assumptions.push(`Riven in one slot: drain ${rivenMod.baseDrain}${rivenMod.polarity ? `, ${rivenMod.polarity}` : ''}`);

  const fixedFit = fitMods([
    ...fixed.map((mod) => ({ mod: snapshot.mods[mod.name], rank: mod.rank ?? 0 })),
    ...(rivenMod ? [{ mod: rivenMod, rank: 0 }] : []),
  ], weapon, capacity);
  const exilusDrain = exilusCost(snapshot, weapon, exilus);
  if (fixedFit.drain + exilusDrain > capacity || (maxForma !== null && fixedFit.formaNeeded > maxForma)) {
    throw new InputError(`the fixed mods alone do not fit in ${capacity} capacity${maxForma !== null ? ` with ${maxForma} Forma` : ''}`, 'does_not_fit');
  }

  const excluded = new Set((request.exclude ?? []).map((name) => name.toLowerCase()));
  const all = searchableMods(snapshot, weapon, excluded)
    .filter((mod) => !fixedNames.has(mod.name))
    .filter((mod) => !mod.incompatible.some((other) => fixedNames.has(other)));

  // Rank the candidates in the company of the greedy search's best builds.
  const scaled = scaleTarget(snapshot, request, enemy, level);
  const scoreOf = makeScorer(snapshot, weapon.name, base, scaled, objective, request.attenuation, request.simulate === false ? 'plain' : 'steady');
  const seed = search(snapshot, {
    weapon: weapon.name, objective, enemy: enemy.name, level, capacity, maxForma,
    exclude: request.exclude, mustInclude: [...fixedNames].filter((name) => name !== exilus?.name),
    eximus: request.eximus, overguard: request.overguard, steelPath: request.steelPath,
    attenuation: request.attenuation, base, limit: 3,
  });
  // The greedy search does not reserve a slot for the riven, so its sets are trimmed to fit.
  const seedSets = seed.builds.map((build) => build.mods.map((mod) => mod.name).filter((name) => !fixedNames.has(name)).slice(0, freeSlots));
  const value = new Map<string, number>();
  for (const mod of all) {
    let best = -Infinity;
    for (const set of seedSets) {
      const trials = set.length < freeSlots ? [[...set, mod.name]] : set.map((_, slot) => set.map((name, i) => (i === slot ? mod.name : name)));
      for (const trial of trials) {
        if (new Set(trial).size !== trial.length) continue;
        best = Math.max(best, scoreOf([...fixed, ...trial.map((name) => ({ name }))], exilus));
      }
    }
    value.set(mod.name, best);
  }
  const ranked = all.map((mod) => mod.name).sort((a, b) => (value.get(b) ?? -Infinity) - (value.get(a) ?? -Infinity));

  let candidates: string[];
  let exhaustive: boolean;
  if (request.pool === undefined && combinationBound(ranked.length, freeSlots) <= maxEvaluations) {
    candidates = ranked;
    exhaustive = true;
  } else {
    let size = request.pool ?? freeSlots;
    if (request.pool === undefined) {
      while (size < ranked.length && combinationBound(size + 1, freeSlots) <= maxEvaluations) size++;
    }
    size = Math.max(0, Math.min(size, ranked.length));
    const keep = new Set<string>(seedSets.flat());
    for (const element of BASE_ELEMENTS) {
      ranked.filter((name) => modElement(snapshot.mods[name]) === element).slice(0, 2).forEach((name) => keep.add(name));
    }
    for (const name of ranked) {
      if (keep.size >= size) break;
      keep.add(name);
    }
    candidates = ranked.filter((name) => keep.has(name));
    exhaustive = candidates.length === ranked.length;
  }
  const leftOut = ranked.filter((name) => !candidates.includes(name));

  assumptions.push(`${capacity} capacity${capacity === 60 ? ' (Orokin Catalyst)' : ''}${maxForma !== null ? `, at most ${maxForma} Forma` : ''}`);
  assumptions.push(objective === 'ttk'
    ? `Objective: kill ${enemy.name} at level ${level} as fast as possible`
    : `Objective: highest damage per second against ${enemy.name} at level ${level}, status damage included`);
  if (request.steelPath) assumptions.push('Steel Path: target health and shields x2.5 (armour unchanged)');
  if (request.eximus) assumptions.push('Eximus target: raised base health/shields and Overguard');
  if (fixed.length || exilus) assumptions.push(`Fixed mods: ${[...fixed, ...(exilus ? [exilus] : [])].map((mod) => `${mod.name} R${mod.rank}`).join(', ')}`);
  if (base.buffs?.length) assumptions.push(`Buffs: ${base.buffs.join(', ')}${base.abilityStrength ? ` at ${base.abilityStrength}% Ability Strength` : ''}`);
  if (base.incarnon?.length) assumptions.push(`Incarnon: ${base.incarnon.join(', ')}`);
  if (base.arcanes?.length) assumptions.push(`Arcanes: ${base.arcanes.map((entry) => (typeof entry === 'string' ? entry : entry.name)).join(', ')}`);
  if (!exhaustive) {
    notes.push(
      `Exhaustive over the ${candidates.length} best-ranked of ${ranked.length} candidate mods `
      + `(budget ${maxEvaluations.toLocaleString('en-US')}); raise --max-evals or --pool to widen it.`,
    );
  }
  notes.push('The Exilus slot is not searched; pin an Exilus mod with --fixed to count it.');

  return {
    weapon: weapon.name,
    objective,
    enemy: enemy.name,
    level,
    capacity,
    maxForma,
    fixed,
    exilus,
    candidates,
    freeSlots,
    plannedCombinations: combinationBound(candidates.length, freeSlots),
    exhaustive,
    leftOut,
    base,
    simulate: request.simulate !== false,
    steelPath: Boolean(request.steelPath),
    eximus: Boolean(request.eximus),
    overguard: request.overguard,
    attenuation: request.attenuation,
    assumptions,
    notes,
  };
}

function exilusCost(snapshot: Snapshot, weapon: WeaponData, exilus: BuildMod | null): number {
  if (!exilus) return 0;
  const mod = snapshot.mods[exilus.name];
  const full = (mod.baseDrain ?? 0) + (exilus.rank ?? mod.maxRank);
  return mod.polarity && mod.polarity === weapon.exilusPolarity ? Math.ceil(full / 2) : full;
}

function scaleTarget(
  snapshot: Snapshot,
  request: { eximus?: boolean; overguard?: number; steelPath?: boolean },
  enemy: Snapshot['enemies'][string],
  level: number,
): ScaledEnemy {
  return scaleEnemy(snapshot, enemy, level, { eximus: request.eximus, overguard: request.overguard, steelPath: request.steelPath });
}

/** Score of one mod list: higher is better for either objective. Invalid builds score -Infinity. */
function makeScorer(
  snapshot: Snapshot,
  weapon: string,
  base: Partial<Build>,
  scaled: ScaledEnemy,
  objective: 'ttk' | 'dps',
  attenuation: string | AttenuationProfile | null | undefined,
  mode: 'steady' | 'simulate' | 'plain' = 'plain',
): (mods: BuildMod[], exilus: BuildMod | null) => number {
  return (mods, exilus) => {
    try {
      const resolved = resolveBuild(snapshot, { ...base, weapon, mods: exilus ? [...mods, exilus] : mods });
      const hit = hitEnemy(snapshot, resolved, scaled, { attenuation, steadyStatus: mode === 'steady', simulate: mode === 'simulate' });
      if (objective === 'dps') return hit.totalDps;
      if (hit.timeToKill === null) return -Infinity;
      // Builds that one-shot all share a kill time; the harder hit wins the tie (at most a 1e-4
      // relative nudge, so it never reorders builds whose times really differ).
      return (1 / Math.max(hit.timeToKill, 1e-9)) * (1 + 1e-4 * Math.min(1, Math.log10(1 + hit.damagePerShotHealth) / 10));
    } catch {
      return -Infinity;
    }
  };
}

/**
 * Walks the combination tree and scores this shard's share of the leaves.
 *
 * A node is a set of candidates (in candidate order) that fits. Its children add one later
 * candidate; an infeasible child is pruned with its whole subtree, which is sound because adding
 * a mod never lowers drain or Forma. A node is a leaf when it is full, or when no later candidate
 * fits (a seven-mod build is the answer when nothing else fits the capacity).
 */
export function runShard(
  snapshot: Snapshot,
  plan: BruteForcePlan,
  shard = 0,
  shards = 1,
  limit = 5,
  onProgress?: (done: number) => void,
): ShardResult {
  const weapon = snapshot.weapons[plan.weapon];
  const enemy = snapshot.enemies[plan.enemy];
  const scaled = scaleTarget(snapshot, plan, enemy, plan.level);
  const scoreOf = makeScorer(snapshot, weapon.name, plan.base, scaled, plan.objective, plan.attenuation, plan.simulate ? 'steady' : 'plain');
  const innate = innateElements(weapon, plan.base);
  const exilusDrain = exilusCost(snapshot, weapon, plan.exilus);

  const mods = plan.candidates.map((name) => snapshot.mods[name]);
  const elementByName = new Map<string, BaseElement | null>(
    [...plan.fixed.map((mod) => mod.name), ...plan.candidates].map((name) => [name, modElement(snapshot.mods[name])]),
  );
  const elementOf = (name: string): BaseElement | null => elementByName.get(name) ?? null;
  // Incompatibility as index pairs, so the inner loop does not compare strings.
  const index = new Map(plan.candidates.map((name, i) => [name, i]));
  const clashes = mods.map((mod) => new Set(mod.incompatible.map((name) => index.get(name)).filter((i): i is number => i !== undefined)));
  // The riven fits like a fixed mod: its card drain in its slot.
  const rivenMod = plan.base.riven ? rivenAsMod(plan.base.riven) : null;
  const fixedEntries = [
    ...plan.fixed.map((mod) => ({ mod: snapshot.mods[mod.name], rank: mod.rank ?? 0 })),
    ...(rivenMod ? [{ mod: rivenMod, rank: 0 }] : []),
  ];

  // Every worker walks the whole tree, so feasibility must be cheap. A set's drain lies between
  // the sum of halved costs (every slot matched) and the sum of mismatched costs (+25%, rounded
  // up): under the upper bound it fits with no Forma, over the lower bound nothing fits, and with
  // unlimited Forma the lower bound decides alone. Only a Forma budget in between needs the exact
  // placement (fitMods).
  const capacity = plan.capacity - exilusDrain;
  const fullCost = mods.map((mod) => (mod.baseDrain ?? 0) + mod.maxRank);
  const halfCost = fullCost.map((cost) => Math.ceil(cost / 2));
  const fixedFull = fixedEntries.reduce((sum, entry) => sum + (entry.mod.baseDrain ?? 0) + entry.rank, 0);
  const fixedHalf = fixedEntries.reduce((sum, entry) => sum + Math.ceil(((entry.mod.baseDrain ?? 0) + entry.rank) / 2), 0);
  const sumOf = (chosen: number[], costs: number[], start: number): number => chosen.reduce((sum, i) => sum + costs[i], start);
  const fits = (chosen: number[]): boolean => {
    // Full cost plus the 25% mismatch penalty everywhere is an upper bound on the drain.
    if (sumOf(chosen, fullCost, fixedFull) * 1.25 + chosen.length + fixedEntries.length <= capacity) return true;
    if (sumOf(chosen, halfCost, fixedHalf) > capacity) return false;
    if (plan.maxForma === null) return true;
    const entries = [...fixedEntries, ...chosen.map((i) => ({ mod: mods[i], rank: mods[i].maxRank }))];
    const fit = fitMods(entries, weapon, capacity);
    return fit.drain <= capacity && fit.formaNeeded <= plan.maxForma;
  };

  const top: ScoredCombination[] = [];
  const keep = (candidate: ScoredCombination): void => {
    if (top.length >= limit && candidate.score <= top[top.length - 1].score) return;
    top.push(candidate);
    top.sort((a, b) => b.score - a.score);
    if (top.length > limit) top.pop();
  };

  let leaf = 0;
  let evaluated = 0;
  const visit = (chosen: number[]): void => {
    const current = leaf++;
    if (onProgress && current % 4096 === 0) onProgress(current);
    if (current % shards !== shard) return;
    const set: BuildMod[] = [...plan.fixed, ...chosen.map((i) => ({ name: plan.candidates[i] }))];
    let best: ScoredCombination | null = null;
    for (const order of elementalOrders(set, elementOf, innate)) {
      const score = scoreOf(order, plan.exilus);
      evaluated++;
      if (!best || score > best.score) best = { mods: order, score };
    }
    if (best && Number.isFinite(best.score)) keep(best);
  };

  const walk = (chosen: number[], start: number): void => {
    if (chosen.length === plan.freeSlots) { visit(chosen); return; }
    let extended = false;
    for (let i = start; i < mods.length; i++) {
      if (chosen.some((j) => clashes[i].has(j) || clashes[j].has(i))) continue;
      const next = [...chosen, i];
      if (!fits(next)) continue;
      extended = true;
      walk(next, i + 1);
    }
    // Nothing more fits after this set: it is a leaf in its own right. A set that could have
    // grown is not, since a fuller set with the same mods is scored on its own branch.
    if (!extended && !canGrow(chosen)) visit(chosen);
  };
  // True when some candidate (earlier ones included) could still be added: then a superset
  // exists on another branch, and this smaller set does not need scoring.
  const canGrow = (chosen: number[]): boolean => {
    for (let i = 0; i < mods.length; i++) {
      if (chosen.includes(i)) continue;
      if (chosen.some((j) => clashes[i].has(j) || clashes[j].has(i))) continue;
      if (fits([...chosen, i])) return true;
    }
    return false;
  };
  walk([], 0);
  return { top, evaluated, combinations: leaf };
}

/** Full report for one winning combination. */
function describe(snapshot: Snapshot, plan: BruteForcePlan, scaled: ScaledEnemy, combination: ScoredCombination): BruteForceBuild {
  const weapon = snapshot.weapons[plan.weapon];
  const fixedNames = new Set(plan.fixed.map((mod) => mod.name));
  const resolved = resolveBuild(snapshot, { ...plan.base, weapon: weapon.name, mods: plan.exilus ? [...combination.mods, plan.exilus] : combination.mods });
  const hit = hitEnemy(snapshot, resolved, scaled, { attenuation: plan.attenuation, simulate: plan.simulate });
  const rivenMod = plan.base.riven ? rivenAsMod(plan.base.riven) : null;
  const entries = [
    ...combination.mods.map((mod) => ({ mod: snapshot.mods[mod.name], rank: mod.rank ?? snapshot.mods[mod.name].maxRank })),
    ...(rivenMod ? [{ mod: rivenMod, rank: 0 }] : []),
  ];
  const exilusDrain = exilusCost(snapshot, weapon, plan.exilus);
  const fit = fitMods(entries, weapon, plan.capacity - exilusDrain);
  const total = resolved.damage.projectileTotal || 1;
  return {
    mods: fit.entries.map((entry) => ({ ...entry, fixed: fixedNames.has(entry.name) || entry.name === 'Riven' })),
    riven: resolved.rivenLines,
    exilus: plan.exilus ? { name: plan.exilus.name, rank: plan.exilus.rank ?? 0 } : null,
    capacityUsed: fit.drain + exilusDrain,
    capacity: plan.capacity,
    formaNeeded: fit.formaNeeded,
    damagePerShot: resolved.averageShotDamage,
    burstDps: resolved.burstDps,
    sustainedDps: resolved.sustainedDps,
    totalDps: hit.totalDps,
    timeToKill: hit.timeToKill,
    shotsToKill: Number.isFinite(hit.shotsToKill) ? hit.shotsToKill : null,
    critChance: resolved.critChance,
    critMultiplier: resolved.critMultiplier,
    statusChance: resolved.statusChance,
    multishot: resolved.multishot,
    elements: (Object.entries(resolved.damage.perProjectile) as Array<[DamageType, number]>)
      .filter(([, amount]) => amount > 0)
      .map(([type, amount]) => ({ type, share: amount / total }))
      .sort((a, b) => b.share - a.share),
    statusAtKill: hit.simulation?.atEnd ?? null,
    damageBySource: hit.simulation?.damageBySource ?? null,
    warnings: [...resolved.warnings, ...hit.warnings],
  };
}

function mergeTop(results: ShardResult[], limit: number): ScoredCombination[] {
  return results.flatMap((result) => result.top).sort((a, b) => b.score - a.score).slice(0, limit);
}

function runInWorkers(
  plan: BruteForcePlan,
  snapshotPath: string | undefined,
  workers: number,
  limit: number,
  onProgress?: (done: number) => void,
): Promise<ShardResult[]> {
  const progress = new Array<number>(workers).fill(0);
  return Promise.all(Array.from({ length: workers }, (_, shard) => new Promise<ShardResult>((resolve, reject) => {
    const worker = new Worker(new URL('./bruteforce-worker.ts', import.meta.url), {
      workerData: { plan, snapshotPath, shard, shards: workers, limit },
    });
    worker.on('message', (message: { type: 'progress'; done: number } | { type: 'done'; result: ShardResult }) => {
      if (message.type === 'progress') {
        progress[shard] = message.done;
        onProgress?.(Math.max(...progress));
      } else {
        resolve(message.result);
      }
    });
    worker.on('error', reject);
    worker.on('exit', (code) => { if (code !== 0) reject(new Error(`brute-force worker ${shard} exited with code ${code}`)); });
  })));
}

/** Plans, enumerates (in parallel when allowed) and reports the best builds. */
export async function bruteForce(snapshot: Snapshot, request: BruteForceRequest): Promise<BruteForceResult> {
  const started = performance.now();
  const plan = planBruteForce(snapshot, request);
  const limit = request.limit ?? 5;
  // Small trees are not worth a thread start-up each.
  const wanted = request.workers ?? availableParallelism();
  const loadable = request.snapshotPath !== undefined || snapshot === loadSnapshot();
  const workers = !loadable || plan.plannedCombinations < 2000 ? 1 : Math.max(1, Math.min(wanted, 64));
  const progress = request.onProgress
    ? (done: number) => request.onProgress!(Math.min(done, plan.plannedCombinations), plan.plannedCombinations)
    : undefined;

  // Ranking uses steady-state status stacks; the best few are then simulated shot by shot,
  // because the stacks a fight actually reaches can reorder close builds.
  const pool = plan.simulate ? Math.max(request.rerank ?? limit * 40, 200, limit) : limit;
  const shards = workers === 1
    ? [runShard(snapshot, plan, 0, 1, pool, progress)]
    : await runInWorkers(plan, request.snapshotPath, workers, pool, progress);

  const scaled = scaleTarget(snapshot, plan, snapshot.enemies[plan.enemy], plan.level);
  let winners = mergeTop(shards, pool);
  if (plan.simulate) {
    const simulated = makeScorer(snapshot, plan.weapon, plan.base, scaled, plan.objective, plan.attenuation, 'simulate');
    winners = winners
      .map((winner) => ({ ...winner, score: simulated(winner.mods, plan.exilus) }))
      .sort((a, b) => b.score - a.score);
  }
  winners = winners.slice(0, limit);
  const notes = [...plan.notes];
  if (plan.simulate) notes.push(`Ranked with steady-state status stacks; the best ${pool} were simulated over the fight for the final order.`);
  if (!winners.length) notes.push('No combination of the candidates fits the capacity and Forma limits.');
  // Every worker counts every leaf it walks, so one shard's count is the tree's.
  const combinations = shards[0]?.combinations ?? 0;

  return {
    weapon: plan.weapon,
    objective: plan.objective,
    enemy: plan.enemy,
    level: plan.level,
    steelPath: plan.steelPath,
    health: scaled.health,
    shield: scaled.shield,
    armor: scaled.armor,
    overguard: scaled.overguard,
    capacity: plan.capacity,
    combinations,
    evaluated: shards.reduce((sum, shard) => sum + shard.evaluated, 0),
    elapsedMs: Math.round(performance.now() - started),
    workers,
    exhaustive: plan.exhaustive,
    candidates: plan.candidates,
    leftOut: plan.leftOut,
    builds: winners.map((winner) => describe(snapshot, plan, scaled, winner)),
    assumptions: plan.assumptions,
    notes,
  };
}
