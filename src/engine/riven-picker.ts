/**
 * Riven picker: for every riven a weapon can roll (three positive stats, one negative, every stat
 * at its maximum), which mod of the player's build it should replace.
 *
 * Values: the +3 -1 layout at the best roll (wiki: Riven Mods, disposition 1.2 for every weapon);
 * the negative stat at its largest magnitude, the worst case. At most one spliced stat per riven.
 *
 * Many stats do nothing to damage (zoom, recoil, ammo, projectile speed, punch through, a faction
 * other than the target's), so rivens are grouped by the effects that do: each group is scored once
 * with the exact engine and the result applies to every riven in it.
 *
 * A riven carrying a combined element (Viral) can make one of the build's element mods (the Cold
 * or Toxin one) redundant: after the best replacement is known, each of those mods is also tried
 * against every other mod that fits the weapon.
 *
 * Capacity is not checked: the riven takes the replaced mod's slot whatever the drain.
 */
import type { Build, BuildMod } from './build.ts';
import { modElement, makeScorer, scaleTarget, runOnPool } from './bruteforce.ts';
import { rivenClass, rivenEffects, RIVEN_ATTRIBUTES, type RivenSpec } from './riven.ts';
import { searchableMods } from './search.ts';
import { ELEMENT_COMBINATIONS, type Snapshot } from '../types.ts';
import { InputError } from '../errors.ts';
import { availableParallelism } from 'node:os';
import { loadSnapshot } from '../data.ts';

export interface RivenPickerRequest {
  weapon: string;
  /** The build's mods (Build tab), riven excluded. */
  mods: BuildMod[];
  /** Everything else of the build: arcanes, buffs, Incarnon, conditions... (its riven is ignored). */
  base?: Partial<Build>;
  enemy?: string;
  level?: number;
  steelPath?: boolean;
  eximus?: boolean;
  objective?: 'ttk' | 'dps';
  /** How many of the best riven groups to report (default 200). */
  limit?: number;
  /** Only rivens with all of these positive stats (ids), e.g. a riven the player owns. */
  stats?: string[];
  /** Only rivens with this negative stat. */
  malus?: string;
  workers?: number;
  snapshotPath?: string;
}

export interface RivenPick {
  stats: string[];
  malus: string;
  /** The riven's stat lines as rolled at maximum. */
  lines: string[];
  /** The build mod the riven replaces. */
  replaces: string;
  score: number;
  timeToKill: number | null;
  /** With a combined element on the riven: one of its element mods swapped for another mod. */
  swap?: { out: string; in: string; score: number; timeToKill: number | null };
  /** Rivens with the same effect on this target (they differ in stats that do nothing here). */
  equivalent: number;
  /** A few of those, as "+a +b +c -d". */
  examples: string[];
}

export interface RivenPickerResult {
  weapon: string;
  enemy: string;
  level: number;
  objective: 'ttk' | 'dps';
  baseline: { score: number; timeToKill: number | null };
  /** Rivens enumerated, effect groups scored, builds evaluated. */
  rivens: number;
  groups: number;
  evaluated: number;
  workers: number;
  elapsedMs: number;
  /** The best riven groups, best first: one row per distinct effect on this target. */
  picks: RivenPick[];
  /** For every build mod, how many of all rivens replace it. */
  replacedCounts: Record<string, number>;
  assumptions: string[];
}

/** Stats that never change damage in this engine. */
const NEUTRAL_TARGETS = new Set(['zoom', 'recoil', 'ammoMax', 'ammoEfficiency', 'projectileSpeed', 'punchThrough']);

/** Every riven the weapon can roll: three positives (at most one spliced), one malus. */
export function enumerateRivens(snapshot: Snapshot, weaponName: string): RivenSpec[] {
  const weapon = snapshot.weapons[weaponName];
  const table = snapshot.rivenStats[rivenClass(weapon)] ?? {};
  const attributes = RIVEN_ATTRIBUTES.filter((attribute) => (table[attribute.label] ?? 0) > 0);
  const rivens: RivenSpec[] = [];
  for (let a = 0; a < attributes.length; a++) {
    for (let b = a + 1; b < attributes.length; b++) {
      for (let c = b + 1; c < attributes.length; c++) {
        const positives = [attributes[a], attributes[b], attributes[c]];
        if (positives.filter((attribute) => attribute.spliced).length > 1) continue;
        for (const malus of attributes) {
          if (malus.noMalus || malus.spliced || positives.includes(malus)) continue;
          rivens.push({ stats: positives.map((attribute) => attribute.id), malus: malus.id, roll: 1.1, rank: 8 });
        }
      }
    }
  }
  return rivens;
}

/** What a riven does to damage against this target: rivens with the same key score the same. */
function damageKey(snapshot: Snapshot, weaponName: string, spec: RivenSpec, faction: string): string {
  const { effects } = rivenEffects(snapshot, snapshot.weapons[weaponName], spec);
  return effects
    .filter((effect) => !NEUTRAL_TARGETS.has(String(effect.target)))
    .filter((effect) => effect.target !== 'factionDamage' || effect.faction === faction)
    .map((effect) => `${effect.target}:${effect.element ?? ''}:${effect.faction ?? ''}:${effect.value.toFixed(6)}`)
    .sort()
    .join('|');
}

export interface RivenShardJob {
  kind: 'riven';
  request: RivenPickerRequest;
  /** One representative riven per effect group. */
  rivens: RivenSpec[];
}

export interface RivenShardResult {
  picks: Array<Omit<RivenPick, 'lines' | 'equivalent' | 'examples'>>;
  evaluated: number;
}

/** Scores a slice of the effect groups exactly (one worker's share). */
export function rivenShard(snapshot: Snapshot, job: RivenShardJob): RivenShardResult {
  const { request } = job;
  const weapon = snapshot.weapons[request.weapon];
  const enemy = snapshot.enemies[request.enemy ?? 'Bombard'];
  const scaled = scaleTarget(snapshot, { steelPath: request.steelPath, eximus: request.eximus }, enemy, request.level ?? 150);
  const objective = request.objective ?? 'ttk';
  const mods = request.mods;
  const pool = searchableMods(snapshot, weapon).map((mod) => mod.name).filter((name) => !mods.some((mod) => mod.name === name));
  let evaluated = 0;
  const picks: RivenShardResult['picks'] = [];
  for (const riven of job.rivens) {
    const scoreOf = makeScorer(snapshot, weapon.name, { ...(request.base ?? {}), riven }, scaled, objective, null, 'steady');
    const ttkOf = (score: number): number | null => (objective === 'ttk' && score > 0 && Number.isFinite(score) ? 1 / score : null);
    let best = { index: -1, score: -Infinity };
    mods.forEach((_, index) => {
      const score = scoreOf(mods.filter((__, i) => i !== index), null);
      evaluated++;
      if (score > best.score) best = { index, score };
    });
    if (best.index < 0) continue;
    const kept = mods.filter((_, i) => i !== best.index);
    const pick: RivenShardResult['picks'][number] = {
      stats: riven.stats, malus: riven.malus!, replaces: mods[best.index].name, score: best.score, timeToKill: ttkOf(best.score),
    };
    // A combined element on the riven: maybe one of the build's element mods for it is now spare.
    const combined = riven.stats.map((id) => RIVEN_ATTRIBUTES.find((attribute) => attribute.id === id)?.element)
      .find((element) => element && ELEMENT_COMBINATIONS[element]);
    if (combined) {
      const parts = ELEMENT_COMBINATIONS[combined];
      let swap: RivenPick['swap'] | undefined;
      for (const out of kept) {
        const element = modElement(snapshot.mods[out.name]);
        if (!element || !parts.includes(element)) continue;
        for (const candidate of pool) {
          if (snapshot.mods[candidate]?.incompatible.some((name) => kept.some((mod) => mod.name === name))) continue;
          const score = scoreOf(kept.map((mod) => (mod === out ? { name: candidate } : mod)), null);
          evaluated++;
          if (score > (swap?.score ?? best.score)) swap = { out: out.name, in: candidate, score, timeToKill: ttkOf(score) };
        }
      }
      if (swap) pick.swap = swap;
    }
    picks.push(pick);
  }
  return { picks, evaluated };
}

/** Plans, scores every effect group on the warm worker threads, and reports the best rivens. */
export async function rivenPicker(snapshot: Snapshot, request: RivenPickerRequest): Promise<RivenPickerResult> {
  const started = performance.now();
  const weapon = snapshot.weapons[request.weapon];
  if (!weapon) throw new InputError(`unknown weapon: ${request.weapon}`, 'unknown_weapon');
  const enemyName = request.enemy ?? 'Bombard';
  const enemy = snapshot.enemies[enemyName];
  if (!enemy) throw new InputError(`unknown enemy: ${enemyName}`, 'unknown_enemy');
  const mods = request.mods.filter((mod) => mod.name && snapshot.mods[mod.name]);
  if (!mods.length) throw new InputError('the build has no mods to replace', 'invalid_argument');
  const objective = request.objective ?? 'ttk';
  const base: Partial<Build> = { ...(request.base ?? {}), riven: undefined, mods: [] };
  const job = { ...request, mods, base, objective, enemy: enemyName };

  const rivens = enumerateRivens(snapshot, weapon.name);
  const faction = (enemy.faction ?? '').toLowerCase();
  const groups = new Map<string, RivenSpec[]>();
  for (const riven of rivens) {
    const key = damageKey(snapshot, weapon.name, riven, faction);
    groups.set(key, [...(groups.get(key) ?? []), riven]);
  }
  const representatives = [...groups.values()].map((members) => members[0]);

  // Small requests run here; big ones on the warm worker threads (snapshot loaded once each).
  const loadable = request.snapshotPath !== undefined || snapshot === loadSnapshot();
  const workers = loadable ? Math.max(1, Math.min(request.workers ?? availableParallelism(), 64, Math.ceil(representatives.length / 50))) : 1;
  const size = Math.ceil(representatives.length / workers);
  const shards = workers === 1
    ? [rivenShard(snapshot, { kind: 'riven', request: job, rivens: representatives })]
    : await runOnPool<RivenShardResult>(request.snapshotPath, Array.from({ length: workers }, (_, shard) => (
      { kind: 'riven', request: job, rivens: representatives.slice(shard * size, (shard + 1) * size) })));

  // Every riven of a group shares its representative's result; the counts cover all rivens.
  const byRepresentative = new Map(shards.flatMap((shard) => shard.picks).map((pick) => [`${pick.stats.join(',')}/${pick.malus}`, pick]));
  const replacedCounts: Record<string, number> = Object.fromEntries(mods.map((mod) => [mod.name, 0]));
  const wanted = (riven: RivenSpec): boolean => (request.stats ?? []).every((id) => riven.stats.includes(id))
    && (!request.malus || riven.malus === request.malus);
  const label = (riven: RivenSpec): string => `+${riven.stats.join(' +')} -${riven.malus}`;
  const rows: RivenPick[] = [];
  for (const members of groups.values()) {
    const result = byRepresentative.get(`${members[0].stats.join(',')}/${members[0].malus}`);
    if (!result) continue;
    replacedCounts[result.replaces] = (replacedCounts[result.replaces] ?? 0) + members.length;
    const matching = members.filter(wanted);
    if (!matching.length) continue;
    rows.push({
      ...result, stats: matching[0].stats, malus: matching[0].malus!, lines: [],
      equivalent: matching.length, examples: matching.slice(1, 6).map(label),
    });
  }
  const limit = request.limit ?? 200;
  const best = (pick: RivenPick): number => Math.max(pick.score, pick.swap?.score ?? -Infinity);
  rows.sort((a, b) => best(b) - best(a));
  const picks = rows.slice(0, limit).map((pick) => ({
    ...pick,
    lines: rivenEffects(snapshot, weapon, { stats: pick.stats, malus: pick.malus, roll: 1.1, rank: 8 }).lines,
  }));

  const scaled = scaleTarget(snapshot, { steelPath: request.steelPath, eximus: request.eximus }, enemy, request.level ?? 150);
  const baselineScore = makeScorer(snapshot, weapon.name, base, scaled, objective, null, 'steady')(mods, null);
  return {
    weapon: weapon.name,
    enemy: enemyName,
    level: request.level ?? 150,
    objective,
    baseline: { score: baselineScore, timeToKill: objective === 'ttk' && baselineScore > 0 ? 1 / baselineScore : null },
    rivens: rivens.length,
    groups: representatives.length,
    evaluated: shards.reduce((sum, shard) => sum + shard.evaluated, 0),
    workers,
    elapsedMs: Math.round(performance.now() - started),
    picks,
    replacedCounts,
    assumptions: [
      'Riven values: +3 -1 layout, best roll, rank 8, disposition 1.2 (wiki); the negative stat at its worst',
      'At most one spliced stat per riven; capacity is not checked (the riven takes the replaced slot)',
      `Scored with steady-state status stacks against ${enemyName} level ${request.level ?? 150}`,
    ],
  };
}
