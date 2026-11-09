/**
 * Part optimiser for modular weapons: which strike/grip/link (zaw), chamber/grip/loader (kitgun)
 * or prism/scaffold/brace (amp) makes the best weapon, mods and arcane included.
 *
 * A full mod search per combination (~2,000 zaws) would take minutes, and the mods that suit a
 * weapon barely change with its grip or link. So:
 *   1. per first part (strike, chamber, prism): the combination that scores best without mods
 *      gets a mod search, and those mods score every combination with that first part;
 *   2. the best `top` combinations get a search of their own (arcane included when asked) and
 *      are ranked by it.
 * Amps take no mods, so step 1 is exact for them; their scaffold is picked by its alt-fire.
 */
import type { ModularKind, Snapshot } from '../types.ts';
import { InputError } from '../errors.ts';
import { makeScorer } from './bruteforce.ts';
import { DEFAULT_KILLS } from './damage.ts';
import { scaleEnemy } from './enemy.ts';
import { combinations, modularParts } from './modular.ts';
import { search, type SearchBuild, type SearchRequest } from './search.ts';

export interface PartSearchRequest extends Omit<SearchRequest, 'weapon' | 'limit'> {
  kind: ModularKind;
  /** Allowed parts per position (the parts the player owns); missing or empty means all. */
  parts?: Array<string[] | null | undefined>;
  /** How many combinations get a full search in the last step. */
  top?: number;
}

export interface PartSearchResult {
  kind: ModularKind;
  objective: 'ttk' | 'dps' | 'kpm';
  enemy: string;
  level: number;
  /** Combinations scored in step 1 (amps: prism x brace, the scaffold is picked afterwards). */
  combinations: number;
  elapsedMs: number;
  /** Best first, each with the build its own search found. */
  results: Array<{ weapon: string; parts: string[]; build: SearchBuild }>;
}

/** Higher is better, as in search(): the score of a search's best build. */
export function buildScore(build: SearchBuild | undefined, objective: PartSearchResult['objective']): number {
  if (!build) return -Infinity;
  if (objective === 'kpm') return build.killsPerMinute || -Infinity;
  if (objective === 'dps') return build.totalDps;
  return build.timeToKill === null ? -Infinity : -build.timeToKill;
}

export function partSearch(snapshot: Snapshot, request: PartSearchRequest): PartSearchResult {
  const started = performance.now();
  if (!snapshot.modular) throw new Error('no modular weapon data in the snapshot (run node tools/fetch-modular.ts)');
  const objective = request.objective ?? 'ttk';
  const all = modularParts(snapshot.modular)[request.kind];
  if (!all) throw new InputError(`unknown modular kind: ${request.kind}`, 'invalid_argument');
  const lists = all.map((names, index) => {
    const allowed = request.parts?.[index]?.filter(Boolean) ?? [];
    return allowed.length ? names.filter((name) => allowed.includes(name)) : names;
  });
  if (lists.some((list) => !list.length)) throw new InputError('none of the allowed parts exist for one of the positions', 'invalid_argument');

  const enemyName = request.enemy ?? 'Bombard';
  const enemy = snapshot.enemies[enemyName];
  if (!enemy) throw new InputError(`enemy not found: ${enemyName}`, 'enemy_not_found');
  const scaled = scaleEnemy(snapshot, enemy, request.level ?? 150, { eximus: request.eximus, overguard: request.overguard, steelPath: request.steelPath });
  // search() assumes a 12x melee combo unless told otherwise; the scores here have to match.
  const base = request.kind === 'zaw' && request.base?.comboHits === undefined ? { ...(request.base ?? {}), comboHits: 220 } : (request.base ?? {});
  const score = (parts: string[], build: Partial<SearchBuild> = {}, mode = base.mode): number => makeScorer(
    snapshot, parts.join(' / '), { ...base, mode, arcanes: build.arcanes ?? base.arcanes }, scaled, objective, request.attenuation, request.simulate ? 'steady' : 'plain', [], request.kills ?? DEFAULT_KILLS,
  )((build.mods ?? []).map(({ name, rank }) => ({ name, rank })), null);
  const searchFor = (parts: string[], chooseArcane: boolean): SearchBuild | undefined =>
    search(snapshot, { ...request, weapon: parts.join(' / '), limit: 1, chooseArcane }).builds[0];

  // An amp's scaffold is its alt-fire and never changes the prism's shot: prism + brace are ranked
  // with one scaffold, then each result gets the scaffold whose own alt-fire scores best.
  const scaffolds = request.kind === 'amp' ? lists[1] : null;
  if (scaffolds) lists[1] = [scaffolds[0]];
  const every = combinations(lists);
  const scored: Array<{ parts: string[]; score: number }> = [];
  for (const first of lists[0]) {
    const group = every.filter((parts) => parts[0] === first);
    const plain = group.map((parts) => score(parts));
    const seed = group[plain.indexOf(Math.max(...plain))];
    const build = searchFor(seed, false);
    for (const parts of group) scored.push({ parts, score: score(parts, build) });
  }
  scored.sort((a, b) => b.score - a.score);

  const results = scored.slice(0, Math.max(1, request.top ?? 5)).flatMap(({ parts }) => {
    const build = searchFor(parts, Boolean(request.chooseArcane));
    return build ? [{ weapon: parts.join(' / '), parts, build }] : [];
  });
  results.sort((a, b) => buildScore(b.build, objective) - buildScore(a.build, objective));
  for (const result of scaffolds ? results : []) {
    const alt = scaffolds!.map((scaffold) => score([result.parts[0], scaffold, result.parts[2]], result.build, scaffold));
    result.parts[1] = scaffolds![alt.indexOf(Math.max(...alt))];
    result.weapon = result.parts.join(' / ');
  }
  return { kind: request.kind, objective, enemy: enemyName, level: request.level ?? 150, combinations: every.length, elapsedMs: Math.round(performance.now() - started), results };
}
