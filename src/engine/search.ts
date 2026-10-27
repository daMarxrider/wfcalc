/**
 * Build search.
 *
 * The calculator evaluates what it is given; this finds what to give it. Greedy fill followed
 * by local search over the mods that fit the weapon, under the real constraints: mod capacity,
 * polarities, how many Forma are available, the Exilus rule, and mods the player does not own.
 *
 * Every number it reports comes from the same engine the rest of the tool uses, so a build
 * found here can be pasted into the UI or the API and will resolve identically. What it cannot
 * do is stated in `notes` rather than hidden: the stance slot and Exilus slot are not searched,
 * and a mod marked `partial` makes the result a lower bound.
 */
import type { Build, BuildMod } from './build.ts';
import { ARCANE_SLOTS, resolveBuild } from './build.ts';
import { arcaneEffectsAt } from './arcanes.ts';
import { hitEnemy } from './damage.ts';
import { scaleEnemy } from './enemy.ts';
import { automaticAttenuation, resolveAttenuation, type AttenuationProfile, type ResolvedAttenuation } from './attenuation.ts';
import type { ModData, Snapshot, WeaponData } from '../types.ts';
import { LOWER_IS_BETTER } from '../types.ts';
import { modsForWeapon } from '../data.ts';

/** Effect axes that can change damage, and so are worth searching over. */
export const DAMAGE_TARGETS = new Set([
  'baseDamage', 'multishot', 'critChance', 'critDamage', 'statusChance', 'statusDuration',
  'statusDamage', 'fireRate', 'reloadSpeed', 'magazine', 'element', 'forcedProc',
  'directDamage', 'faction', 'headshotMultiplier', 'heavyAttackSpeed', 'comboDuration',
  'convert', 'ammoMax',
]);

export { LOWER_IS_BETTER };
export const isDrawback = (effect: { value: number; target: unknown }): boolean =>
  effect.value < 0 && !LOWER_IS_BETTER.has(String(effect.target));

/**
 * Mods that are another mod plus drawbacks, as twin -> clean mod: Heavy Caliber is Serration with
 * -55% accuracy, Hollow Point is Target Cracker with -15% damage. Among `mods` (the ones available),
 * a twin belongs in a build only next to its clean mod.
 */
export function drawbackTwins(mods: ModData[]): Map<string, string> {
  const useful = (mod: ModData): string => JSON.stringify(mod.effects
    .filter((effect) => !isDrawback(effect))
    .map(({ raw: _raw, ...rest }) => JSON.stringify({ ...rest, value: Math.round(rest.value * 1e6) / 1e6 }, Object.keys(rest).sort()))
    .sort());
  const clean = new Map<string, string>();
  for (const mod of mods) {
    if (mod.effects.length && !mod.effects.some(isDrawback) && !clean.has(useful(mod))) clean.set(useful(mod), mod.name);
  }
  const twins = new Map<string, string>();
  for (const mod of mods) {
    if (!mod.effects.some(isDrawback)) continue;
    const twin = clean.get(useful(mod));
    if (twin && twin !== mod.name) twins.set(mod.name, twin);
  }
  return twins;
}

/** Set bonuses build.ts turns into damage: Vigilante (enhanced crits), Gladiator (crit per combo). */
const DAMAGE_SETS = new Set(['Vigilante Set', 'Gladiator Set']);

/** Slots the search fills: the eight standard ones, not the Exilus or stance slot. */
const SEARCH_SLOTS = 8;

export interface SearchRequest {
  weapon: string;
  /** `ttk` minimises time to kill the target; `dps` maximises sustained damage. */
  objective?: 'ttk' | 'dps';
  enemy?: string;
  level?: number;
  /** Mod capacity: 30, or 60 with an Orokin Catalyst. */
  capacity?: number;
  /** How many Forma the player is willing to spend; null means as many as needed. */
  maxForma?: number | null;
  /** Mods the player does not own. */
  exclude?: string[];
  /** Mods that must be in the build, e.g. one the player already has equipped. */
  mustInclude?: string[];
  /**
   * Let the search choose the Incarnon evolutions. Off by default: the Incarnon form is an
   * endgame unlock (built through the Circuit, with a transformation to manage), so assuming
   * it would be assuming too much about the player's account.
   */
  chooseIncarnon?: boolean;
  /** Try every weapon arcane whose slot fits and keep the best result. */
  chooseArcane?: boolean;
  /** Target is an Eximus: add its level-scaled Overguard. */
  eximus?: boolean;
  /** Explicit Overguard amount (used as-is) instead of the Eximus formula. */
  overguard?: number;
  /** Steel Path target: health and shields x2.5. `level` stays the enemy's actual level. */
  steelPath?: boolean;
  /**
   * Status effects build up over the fight: builds are compared with steady-state stacks and the
   * returned ones are simulated (see simulate.ts). Default false here; the CLI and API turn it on.
   */
  simulate?: boolean;
  /** Boss damage attenuation: a profile id, an explicit profile, or null to disable. */
  attenuation?: string | AttenuationProfile | null;
  /** Everything else that affects the result: buffs, frame, arcanes, riven, debuffs. */
  base?: Partial<Build>;
  /** How many builds to return. */
  limit?: number;
  /** Evaluation budget; roughly 20k evaluations per second. */
  budget?: number;
}

export interface SearchBuild {
  mods: Array<{ name: string; rank: number; drain: number; polarity: string | null; halvedByPolarity: boolean }>;
  capacityUsed: number;
  capacity: number;
  formaNeeded: number;
  fits: boolean;
  damagePerShot: number;
  burstDps: number;
  /** Sustained direct damage, procs excluded. */
  sustainedDps: number;
  /** Damage per second against this target, status damage included. */
  totalDps: number;
  timeToKill: number | null;
  shotsToKill: number | null;
  critChance: number;
  critMultiplier: number;
  statusChance: number;
  multishot: number;
  warnings: string[];
  /** Weapon arcanes this build assumes (empty when none). */
  arcanes: Array<{ name: string; rank?: number }>;
  /** Mods whose value depends on a condition (`--stacks`, aiming, ...). */
  conditionalMods: string[];
  /** Incarnon evolutions this build assumes, as "EVO2:0" selections. */
  incarnon: string[];
  /** Evolution names, for showing to the player. */
  incarnonNames: string[];
  /** Mods in the build whose numbers are a lower bound. */
  partialMods: string[];
}

export interface SearchResult {
  weapon: string;
  objective: 'ttk' | 'dps';
  enemy: string;
  level: number;
  capacity: number;
  evaluated: number;
  elapsedMs: number;
  /** Target Overguard, 0 unless the request asked for an Eximus/custom amount. */
  overguard: number;
  /** Damage attenuation applied to the target, if any. */
  attenuation: ResolvedAttenuation | null;
  builds: SearchBuild[];
  assumptions: string[];
  notes: string[];
}

/**
 * Mods worth searching for a weapon: they fit it, can change damage, are not Conclave, Flawed or
 * Exilus, and the player owns them (`excluded` holds lower-cased names).
 */
export function searchableMods(snapshot: Snapshot, weapon: WeaponData, excluded: Set<string> = new Set(), exilus = false): ModData[] {
  // modsForWeapon also accepts the category-wide classes ("Primary": Hunter Munitions), which a
  // match on the weapon's own class ("Rifle") alone left out of every search.
  return modsForWeapon(snapshot, weapon).filter((mod) => {
    if (mod.conclave) return false;
    if (excluded.has(mod.name.toLowerCase())) return false;
    // Exilus mods only fit the Exilus slot, and nothing else does.
    if (Boolean(mod.isExilus) !== exilus) return false;
    // Cannonade mods lock the trigger to semi-auto, so they only fit weapons that have one.
    if (mod.effects.some((effect) => effect.target === 'requiresSemiTrigger') && weapon.trigger !== 'Semi') return false;
    // A set piece counts towards its set bonus even when its own line does nothing for damage
    // (Vigilante Supplies: enhanced crits), so it is worth searching too.
    if (mod.set && DAMAGE_SETS.has(mod.set)) return true;
    return mod.effects.some((effect) => DAMAGE_TARGETS.has(String(effect.target)));
  });
}

/** One slot's polarity in the game's own terms. */
function slotPolarity(weapon: WeaponData, index: number): string | null {
  return weapon.polarities[index] ?? null;
}

/**
 * Minimum Forma needed for a set of mods to fit, and the drain once spent.
 *
 * Slot rules (wiki: Polarity): a mod costs `baseDrain + rank`, halved (rounded up) in a slot of
 * its polarity, and 25% more (rounded up) in a slot of another polarity. The weapon's polarised
 * slots are filled with matching mods first, then the unpolarised slots; whatever is left has to
 * sit in a mismatched slot. Forma re-polarises one slot each and is spent where it saves the most
 * drain until the capacity fits.
 */
export function fitMods(
  mods: Array<{ mod: ModData; rank: number }>,
  weapon: WeaponData,
  capacity: number,
  slots = SEARCH_SLOTS,
): { drain: number; formaNeeded: number; entries: SearchBuild['mods'] } {
  const free = [...weapon.polarities];
  const neutralSlots = Math.max(0, slots - weapon.polarities.length);
  type Pending = { mod: ModData; rank: number; full: number; state: 'matched' | 'neutral' | 'mismatched'; formaed: boolean };
  const pending: Pending[] = [];

  for (const { mod, rank } of mods) {
    const full = (mod.baseDrain ?? 0) + rank;
    const matching = mod.polarity ? free.indexOf(mod.polarity) : -1;
    // A slot the weapon already has the right polarity on halves the cost for free.
    if (matching !== -1) {
      free.splice(matching, 1);
      pending.push({ mod, rank, full, state: 'matched', formaed: false });
    } else {
      pending.push({ mod, rank, full, state: 'neutral', formaed: false });
    }
  }
  // More unmatched mods than unpolarised slots: the cheapest-to-penalise ones take the leftover
  // polarised slots. A mod without a polarity pays no mismatch.
  const unmatched = pending.filter((entry) => entry.state === 'neutral');
  const overflow = Math.max(0, unmatched.length - neutralSlots);
  const penalty = (entry: Pending): number => (entry.mod.polarity ? Math.ceil(entry.full * 1.25) - entry.full : 0);
  for (const entry of [...unmatched].sort((a, b) => penalty(a) - penalty(b)).slice(0, overflow)) entry.state = 'mismatched';

  const cost = (entry: Pending): number => {
    if (entry.state === 'matched' || entry.formaed) return Math.ceil(entry.full / 2);
    if (entry.state === 'mismatched' && entry.mod.polarity) return Math.ceil(entry.full * 1.25);
    return entry.full;
  };
  let drain = pending.reduce((sum, entry) => sum + cost(entry), 0);
  let formaNeeded = 0;
  // Spend Forma on the remaining mods, biggest saving first, until the capacity fits.
  const candidates = pending
    .filter((entry) => entry.state !== 'matched' && entry.mod.polarity)
    .sort((a, b) => (cost(b) - Math.ceil(b.full / 2)) - (cost(a) - Math.ceil(a.full / 2)));
  for (const entry of candidates) {
    if (drain <= capacity) break;
    drain -= cost(entry) - Math.ceil(entry.full / 2);
    entry.formaed = true;
    formaNeeded++;
  }

  const entries: SearchBuild['mods'] = pending.map((entry) => ({
    name: entry.mod.name,
    rank: entry.rank,
    drain: cost(entry),
    polarity: entry.mod.polarity,
    halvedByPolarity: entry.state === 'matched' || entry.formaed,
  }));
  return { drain, formaNeeded, entries };
}

/**
 * Trying every order of the elemental mods matters: the game combines them in slot order, so
 * heat+cold+toxin can end up viral+heat or viral+cold depending on where each sits.
 */
function bestElementOrder(
  names: string[],
  evaluate: (order: string[]) => number,
): string[] {
  const elementPositions = names
    .map((name, index) => ({ name, index }))
    .filter((entry) => /Rounds$|Clip$|Fire$|Stormbringer|Charged Shell|Contagious Spread|Fever Strike|North Wind|Molten Impact|Infected Clip|Hellfire|Cryo Rounds/.test(entry.name));
  if (elementPositions.length < 2 || elementPositions.length > 5) return names;

  const slots = elementPositions.map((entry) => entry.index);
  const mods = elementPositions.map((entry) => entry.name);
  let best = names;
  let bestScore = evaluate(names);

  const permute = (rest: string[], chosen: string[]): void => {
    if (!rest.length) {
      const candidate = [...names];
      slots.forEach((slot, i) => { candidate[slot] = chosen[i]; });
      const score = evaluate(candidate);
      if (score > bestScore) { bestScore = score; best = candidate; }
      return;
    }
    for (let i = 0; i < rest.length; i++) {
      permute([...rest.slice(0, i), ...rest.slice(i + 1)], [...chosen, rest[i]]);
    }
  };
  permute(mods, []);
  return best;
}

function searchOnce(snapshot: Snapshot, request: SearchRequest): SearchResult {
  const started = performance.now();
  const weapon = snapshot.weapons[request.weapon];
  if (!weapon) throw new Error(`weapon not found: ${request.weapon}`);

  const objective = request.objective ?? 'ttk';
  const level = request.level ?? 150;
  const capacity = request.capacity ?? 60;
  const maxForma = request.maxForma ?? null;
  const limit = request.limit ?? 3;
  const budget = request.budget ?? 12000;

  const excluded = new Set((request.exclude ?? []).map((n) => n.toLowerCase()));
  const mustInclude = (request.mustInclude ?? []).filter(Boolean);
  // Blood Rush and Weeping Wounds scale with the melee combo multiplier and are worth nothing
  // at 1x, so a melee search assumes the 12x a player actually fights at unless told otherwise.
  // An explicit --combo-hits 0 means "no combo", and is respected.
  const assumedCombo = weapon.category === 'melee' && request.base?.comboHits === undefined;
  const base = assumedCombo ? { ...(request.base ?? {}), comboHits: 220 } : (request.base ?? {});

  const fitsWeapon = searchableMods(snapshot, weapon, excluded);

  const pool = new Map(fitsWeapon.map((mod) => [mod.name, mod]));
  for (const name of mustInclude) {
    const mod = snapshot.mods[name];
    if (mod) pool.set(name, mod);
  }

  // The target does not change during the search, so it is scaled once.
  const enemyName = request.enemy ?? 'Bombard';
  const enemy = snapshot.enemies[enemyName];
  if (!enemy) throw new Error(`enemy not found: ${enemyName}`);
  const scaled = scaleEnemy(snapshot, enemy, level, { eximus: request.eximus, overguard: request.overguard, steelPath: request.steelPath });
  const attenuation = resolveAttenuation(
    request.attenuation !== undefined ? request.attenuation : automaticAttenuation(enemy),
    scaled.health,
  );

  let evaluated = 0;
  const scoreCache = new Map<string, { score: number; resolved: ReturnType<typeof resolveBuild>; hit: ReturnType<typeof hitEnemy> }>();

  // Incarnon evolutions are part of the build: the same mods score differently depending on
  // which perks are installed, so the selection is part of the cache key.
  let incarnonSelection: string[] = base.incarnon ?? [];
  const keyOf = (names: string[]): string =>
    `${incarnonSelection.join('+')}#${names.join('|')}`;

  const evaluateOrder = (names: string[], quick = false): number => {
    if (!names.length) return quick ? -1 : 0;
    const key = keyOf(names);
    const cached = scoreCache.get(key);
    if (cached) return cached.score;
    const build: Build = {
      ...base,
      weapon: weapon.name,
      mods: names.map((name) => ({ name })),
      incarnon: incarnonSelection.length ? incarnonSelection : undefined,
    };
    evaluated++;
    let score: number;
    let resolved: ReturnType<typeof resolveBuild>;
    let hit: ReturnType<typeof hitEnemy>;
    try {
      resolved = resolveBuild(snapshot, build);
      hit = hitEnemy(snapshot, resolved, scaled, { attenuation: request.attenuation, steadyStatus: request.simulate });
      score = objective === 'ttk'
        ? (hit.timeToKill === null ? -1 : (1 / Math.max(hit.timeToKill, 1e-6)) * (1 + 1e-4 * Math.min(1, Math.log10(1 + hit.damagePerShotHealth) / 10)))
        // totalDps is the damage against this target including status procs. sustainedDps
        // alone ignores them, which made the dps objective blind to Weeping Wounds and to
        // every slash or heat build: identical score for 33.6k and 17.9k real damage.
        : hit.totalDps;
    } catch {
      return -1;
    }
    scoreCache.set(key, { score, resolved, hit });
    return score;
  };

  const candidates = [...pool.values()]
    .filter((mod) => !mustInclude.includes(mod.name))
    .map((mod) => ({ mod, rank: mod.maxRank ?? 0 }));

  // A mod that is another plus drawbacks (Heavy Caliber) only joins a build that has the other one.
  const twins = drawbackTwins([...pool.values()]);
  const twinsOk = (names: string[]): boolean => names.every((name) => {
    const clean = twins.get(name);
    return !clean || mustInclude.includes(name) || names.includes(clean);
  });

  // Feasibility: the build must fit, spending no more Forma than allowed.
  const fits = (names: string[]): { ok: boolean; drain: number; formaNeeded: number; entries: SearchBuild['mods'] } => {
    const mods = names
      .map((name) => ({ mod: pool.get(name) ?? snapshot.mods[name], rank: (pool.get(name) ?? snapshot.mods[name])?.maxRank ?? 0 }))
      .filter((entry): entry is { mod: ModData; rank: number } => Boolean(entry.mod));
    const result = fitMods(mods, weapon, capacity);
    // Two mods of the same family cannot be equipped together: Pressure Point and Primed
    // Pressure Point are the classic pair, and the data carries the incompatibility list.
    const chosen = new Set(names);
    const conflict = mods.some((entry) => entry.mod.incompatible.some((other) => chosen.has(other)));
    const ok = !conflict && twinsOk(names) && result.drain <= capacity && (maxForma === null || result.formaNeeded <= maxForma);
    return { ok, ...result };
  };

  /** Greedy fill plus local search for the current Incarnon selection. */
  const optimizeMods = (seed: string[]): { names: string[]; score: number } => {
    let names = [...seed];
    let score = evaluateOrder(names);
    const inUse = new Set(names);

    while (names.length < SEARCH_SLOTS && evaluated < budget) {
      let bestName: string | null = null;
      let bestScore = score;
      for (const { mod } of candidates) {
        if (inUse.has(mod.name)) continue;
        if (evaluated >= budget) break;
        const trial = [...names, mod.name];
        if (!fits(trial).ok) continue;
        const trialScore = evaluateOrder(trial, true);
        if (trialScore > bestScore + 1e-9) { bestScore = trialScore; bestName = mod.name; }
      }
      if (!bestName) break;
      names = [...names, bestName];
      inUse.add(bestName);
      score = bestScore;
    }

    let improved = true;
    while (improved && evaluated < budget) {
      improved = false;
      let bestScore = score;
      let bestNames = names;
      for (let slot = 0; slot < SEARCH_SLOTS; slot++) {
        // A mod the player already has equipped is not the search's to remove.
        if (mustInclude.includes(names[slot] ?? '')) continue;
        for (const { mod } of candidates) {
          if (evaluated >= budget) break;
          if (names[slot] === mod.name) continue;
          if (inUse.has(mod.name) && !names.includes(mod.name)) continue;
          const trial = [...names];
          if (slot < trial.length) trial[slot] = mod.name;
          else trial.push(mod.name);
          const unique = new Set(trial);
          if (unique.size !== trial.length) continue;
          if (!fits(trial).ok) continue;
          const trialScore = evaluateOrder(trial, true);
          if (trialScore > bestScore + 1e-9) { bestScore = trialScore; bestNames = trial; }
        }
        // Removing a mod is allowed too: sometimes seven mods beat eight.
        if (slot < names.length && evaluated < budget) {
          const trial = names.filter((_, index) => index !== slot);
          if (!twinsOk(trial)) continue;
          const trialScore = evaluateOrder(trial, true);
          if (trialScore > bestScore + 1e-9) { bestScore = trialScore; bestNames = trial; }
        }
      }
      if (bestNames !== names) {
        names = bestNames;
        score = bestScore;
        inUse.clear();
        for (const name of names) inUse.add(name);
        improved = true;
      }
    }
    return { names, score };
  };

  // Incarnon perks are chosen per tier, greedily, and re-chosen once the mods are known: the
  // best crit perk and the best base-damage perk swap places depending on the rest of the build.
  const incarnonTiers = (snapshot.incarnons[weapon.name] ?? []).reduce<Array<{ tier: string; options: Array<{ index: number; selection: string }> }>>(
    (tiers, option, index) => {
      const existing = tiers.find((entry) => entry.tier === option.tier);
      // Only perks the parser could turn into numbers can change a damage score.
      if (!option.effects.length) return tiers;
      const tierIndex = (snapshot.incarnons[weapon.name] ?? [])
        .filter((entry) => entry.tier === option.tier)
        .indexOf(option);
      void index;
      const selection = `${option.tier}:${tierIndex}`;
      if (existing) existing.options.push({ index: tierIndex, selection });
      else tiers.push({ tier: option.tier, options: [{ index: tierIndex, selection }] });
      return tiers;
    },
    [],
  );

  /**
   * Tries every combination of perks and keeps the best. A greedy tier-by-tier walk is not
   * enough: the perks interact (the Incarnon profile alone can score worse than the base
   * weapon, and only the full set overtakes it). Trees are small — the largest is 18
   * combinations — so exhausting them is both affordable and exact.
   */
  const chooseIncarnon = (): void => {
    // The form is the player's choice (base.incarnon carries "form"), never the search's.
    const combinations: string[][] = [[]];
    for (const tier of incarnonTiers) {
      const grown: string[][] = [];
      for (const prefix of combinations) {
        for (const option of tier.options) grown.push([...prefix, option.selection]);
      }
      combinations.length = 0;
      combinations.push(...grown);
    }
    // The form switch the player set stays as it is.
    const form = incarnonSelection.filter((choice) => choice.toLowerCase() === 'form');
    for (const combination of combinations) combination.unshift(...form);
    let best = incarnonSelection;
    let bestScore = -Infinity;
    for (const combination of combinations) {
      if (evaluated >= budget) break;
      incarnonSelection = combination;
      const score = evaluateOrder(currentMods, true);
      if (score > bestScore + 1e-9) { bestScore = score; best = combination; }
    }
    incarnonSelection = best;
  };

  let currentMods = [...mustInclude];
  const firstPass = optimizeMods(currentMods);
  let current = firstPass.names;
  currentMods = current;

  if (incarnonTiers.length && request.chooseIncarnon && (base.incarnon ?? []).every((choice) => choice.toLowerCase() === 'form')) {
    const beforeChoice = incarnonSelection.join('+');
    chooseIncarnon();
    // A different set of perks can favour different mods, so the mods are searched again.
    if (incarnonSelection.join('+') !== beforeChoice) {
      const secondPass = optimizeMods(current);
      current = secondPass.names;
      currentMods = current;
    }
  }

  // Element order is free to change without touching capacity.
  current = bestElementOrder(current, (order) => evaluateOrder(order, true));

  // Accuracy is not priced by the damage model, so Heavy Caliber can tie with Serration and win
  // on iteration order. When two choices score the same, prefer the one without an unmodelled
  // accuracy penalty; a real DPS loss is never traded for this.
  const hasAccuracyPenalty = (name: string): boolean =>
    (snapshot.mods[name]?.effects ?? []).some((effect) => effect.target === 'accuracy' && effect.value < 0);
  const burden = (names: string[]): number => names.filter(hasAccuracyPenalty).length;
  for (let index = 0; index < current.length; index++) {
    if (!hasAccuracyPenalty(current[index])) continue;
    const baseline = evaluateOrder(current, true);
    let bestNames = current;
    let bestBurden = burden(current);
    for (const { mod: candidate } of candidates) {
      if (current.includes(candidate.name)) continue;
      const trial = [...current];
      trial[index] = candidate.name;
      if (!fits(trial).ok) continue;
      const score = evaluateOrder(trial, true);
      const trialBurden = burden(trial);
      if (trialBurden < bestBurden && score >= baseline - 1e-9) {
        bestNames = trial;
        bestBurden = trialBurden;
      }
    }
    current = bestNames;
  }

  const buildFrom = (names: string[]): SearchBuild => {
    if (!scoreCache.get(keyOf(names))) evaluateOrder(names);
    const cached = scoreCache.get(keyOf(names))!;
    // What is reported comes from the fight simulation when asked for; the search itself ran on
    // steady-state stacks.
    const scored = request.simulate
      ? { ...cached, hit: hitEnemy(snapshot, cached.resolved, scaled, { attenuation: request.attenuation, simulate: true }) }
      : cached;
    const fit = fits(names);
    return {
      mods: fit.entries,
      capacityUsed: fit.drain,
      capacity,
      formaNeeded: fit.formaNeeded,
      fits: fit.ok,
      damagePerShot: scored.resolved.averageShotDamage,
      burstDps: scored.resolved.burstDps,
      sustainedDps: scored.resolved.sustainedDps,
      totalDps: scored.hit.totalDps,
      timeToKill: scored.hit.timeToKill,
      shotsToKill: scored.hit.shotsToKill,
      critChance: scored.resolved.critChance,
      critMultiplier: scored.resolved.critMultiplier,
      statusChance: scored.resolved.statusChance,
      multishot: scored.resolved.multishot,
      warnings: [...scored.resolved.warnings, ...scored.hit.warnings],
      arcanes: (base.arcanes ?? []).map((entry) => (typeof entry === 'string' ? { name: entry } : { name: entry.name, rank: entry.rank })),
      conditionalMods: names.filter((name) => (snapshot.mods[name]?.effects ?? []).some((effect) => effect.condition)),
      incarnon: [...incarnonSelection],
      incarnonNames: [...incarnonSelection].map((selection) => {
        const [tier, index] = selection.split(':');
        const options = (snapshot.incarnons[weapon.name] ?? []).filter((option) => option.tier === tier);
        return `${tier} ${options[Number(index)]?.name ?? selection}`;
      }),
      partialMods: names.filter((name) => snapshot.mods[name]?.partial),
    };
  };

  // Alternative builds: force each of the strongest few mods out and re-optimise, and keep the
  // results that are genuinely different, so the player sees a real choice rather than clones.
  const builds: SearchBuild[] = [buildFrom(current)];
  const leaders = [...candidates]
    .map(({ mod }) => ({ name: mod.name, score: evaluateOrder([...current.slice(0, SEARCH_SLOTS - 1), mod.name], true) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 4);

  for (const banned of leaders) {
    if (builds.length >= limit) break;
    if (evaluated >= budget) break;
    const without = current.filter((name) => name !== banned.name);
    const seen = new Set(without);
    let variant = without;
    let variantScore = evaluateOrder(variant, true);
    for (let round = 0; round < 2; round++) {
      let bestName: string | null = null;
      let bestScore = variantScore;
      for (const { mod } of candidates) {
        if (variant.length >= SEARCH_SLOTS) break;
        if (seen.has(mod.name) || mod.name === banned.name) continue;
        const trial = [...variant, mod.name];
        if (!fits(trial).ok) continue;
        const score = evaluateOrder(trial, true);
        if (score > bestScore + 1e-9) { bestScore = score; bestName = mod.name; }
      }
      if (!bestName) break;
      variant = [...variant, bestName];
      seen.add(bestName);
      variantScore = bestScore;
    }
    variant = bestElementOrder(variant, (order) => evaluateOrder(order, true));
    const signature = [...variant].sort().join('|');
    if (builds.some((existing) => existing.mods.map((m) => m.name).sort().join('|') === signature)) continue;
    builds.push(buildFrom(variant));
  }

  builds.sort((a, b) => (objective === 'ttk'
    ? (a.timeToKill ?? Infinity) - (b.timeToKill ?? Infinity)
    : b.totalDps - a.totalDps));

  const assumptions: string[] = [
    `All mods at max rank, ${capacity} capacity${capacity === 60 ? ' (Orokin Catalyst)' : ''}`,
    objective === 'ttk'
      ? `Objective: kill ${enemy.name} at level ${level} in the fewest shots`
      : `Objective: highest damage per second against ${enemy.name} at level ${level}, status damage included`,
  ];
  if (base.conditions && Object.keys(base.conditions).length) {
    assumptions.push(`Conditions: ${Object.entries(base.conditions).map(([k, v]) => `${k}=${v}`).join(', ')}`);
  }
  if (assumedCombo) assumptions.push('Melee combo assumed at 12x (220 hits)');
  if (base.arcanes?.length) {
    assumptions.push(`Arcane: ${base.arcanes.map((entry) => (typeof entry === 'string' ? entry : `${entry.name}${entry.rank !== undefined ? ` R${entry.rank}` : ''}`)).join(', ')}`);
  }
  if (request.steelPath) assumptions.push('Steel Path: target health and shields x2.5');
  if (scaled.overguard > 0) assumptions.push(`Target Overguard: ${Math.round(scaled.overguard)}`);
  if (attenuation) assumptions.push(`Damage attenuation: ${attenuation.id} (${Math.round(attenuation.mdpi)} per hit, ${Math.round(attenuation.mdps)} per second)`);
  if (base.buffs?.length) assumptions.push(`Buffs: ${base.buffs.join(', ')}`);
  if (base.frame) assumptions.push(`Warframe: ${base.frame}`);
  // Ability Strength decides how much a Roar or Eclipse is worth, so it is stated, not implied.
  const strength = scoreCache.get(current.join('|'))?.resolved.abilityStrength;
  if (base.buffs?.length && typeof strength === 'number') {
    assumptions.push(`Ability Strength: ${strength.toFixed(0)}%${base.frameMods?.length ? ' (from the frame mods)' : ''}`);
  }

  const notes: string[] = [
    'The Exilus and stance slots are not searched; an Exilus mod is never worth a standard slot.',
  ];
  if (incarnonTiers.length && base.incarnon === undefined) {
    notes.push(
      `Incarnon evolutions are not assumed: ${weapon.name} has ${incarnonTiers.length} tier(s) of perks, `
      + 'and the transformed profile plus those perks is modelled. Ask for them with --incarnon auto, '
      + 'or pick them with --incarnon "EVO2:0".',
    );
  }
  if (weapon.category === 'melee') {
    notes.push('Melee stance is not searched, so its extra capacity is not counted.');
  }
  const burdened = [...new Set(builds.flatMap((build) => build.mods.map((mod) => mod.name)).filter(hasAccuracyPenalty))];
  if (burdened.length) {
    notes.push(`Unmodelled accuracy penalty: ${burdened.join(', ')}; the search prefers an equal alternative when one fits.`);
  }
  if (builds.some((build) => build.partialMods.length)) {
    const names = [...new Set(builds.flatMap((build) => build.partialMods))];
    notes.push(`Lower bound: ${names.join(', ')} have lines this calculator does not model.`);
  }
  if (maxForma !== null) notes.push(`At most ${maxForma} Forma assumed.`);

  return {
    weapon: weapon.name,
    objective,
    enemy: enemy.name,
    level,
    capacity,
    evaluated,
    elapsedMs: Math.round(performance.now() - started),
    overguard: scaled.overguard,
    attenuation,
    builds: builds.slice(0, limit),
    assumptions,
    notes,
  };
}


/**
 * Search with or without an automatic arcane choice.
 *
 * An arcane is a 2-3x multiplier that the mod optimiser cannot see, so `--arcane auto` runs the
 * same search once per arcane whose slot fits and keeps the best answer. ~20 arcanes at ~55 ms
 * each is about a second, which is cheap for a decision this large.
 */
export function search(snapshot: Snapshot, request: SearchRequest): SearchResult {
  if (!request.chooseArcane) return searchOnce(snapshot, request);
  const weapon = snapshot.weapons[request.weapon];
  if (!weapon) throw new Error(`weapon not found: ${request.weapon}`);
  // An explicit arcane is a decision, not a suggestion: respect it.
  if (request.base?.arcanes?.length) return searchOnce(snapshot, { ...request, chooseArcane: false });

  const allowed = ARCANE_SLOTS[weapon.category] ?? [];
  const relevant = new Set([
    'baseDamage', 'multishot', 'critChance', 'critDamage', 'statusChance', 'fireRate',
    'element', 'directDamage', 'factionDamage', 'headshotMultiplier', 'reloadSpeed',
    'statusDamage', 'weakPointOverride', 'weakPointCritChance', 'damageMultiplier', 'doughty', 'duplicateChance',
    'platedRound', 'enervateResets', 'overguardDamage', 'procDamage',
  ]);
  const candidates = Object.values(snapshot.arcanes).filter(
    (arcane) => arcane.slot && allowed.includes(arcane.slot)
      && arcaneEffectsAt(arcane, arcane.maxRank, { heavyAttack: Boolean(request.base?.heavyAttack) }).some((effect) => relevant.has(String(effect.target))),
  );
  if (!candidates.length) return searchOnce(snapshot, { ...request, chooseArcane: false });

  const scoreOf = (result: SearchResult): number => {
    const top = result.builds[0];
    if (!top) return -Infinity;
    return request.objective === 'dps'
      ? top.totalDps
      : (top.timeToKill === null ? -Infinity : -top.timeToKill);
  };
  // A baseline with no arcane first: an arcane whose conditions are not active must not win a
  // tie just because it was iterated first (Fractalized Reset with no --stacks onAbilityCast).
  const baseline = searchOnce(snapshot, { ...request, chooseArcane: false });
  let best: { result: SearchResult; score: number } = { result: baseline, score: scoreOf(baseline) };

  for (const arcane of candidates) {
    const result = searchOnce(snapshot, {
      ...request,
      chooseArcane: false,
      base: { ...(request.base ?? {}), arcanes: [{ name: arcane.name, rank: arcane.maxRank }] },
    });
    const score = scoreOf(result);
    if (score > best.score + 1e-9) best = { result, score };
  }
  return best.result;
}
