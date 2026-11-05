/**
 * GPU pre-filter for the brute force (WebGPU, so AMD, Nvidia, Intel and Apple alike).
 *
 * The exact engine (build.ts + damage.ts) is too branchy for a shader, so the GPU scores every
 * combination with a reduced model and keeps the best few thousand; the server then scores those
 * exactly (bruteForceFromCombinations). This file is that reduced model, written twice: `proxyScore`
 * in JS (tests, CPU fallback, and a runtime check of the shader) and the WGSL in `shaderSource`.
 * Both read the same flat layout, defined once here and also used by src/engine/gpu-model.ts.
 *
 * Every mod is a vector of additive channels, valued by the engine itself at 1 and 2 status types
 * (A + B x status types), so ranks, conditions, stacks and bow doubling are the engine's.
 * Left out of the model (the exact pass still has them): quantization, attenuation caps, proc
 * damage, conversions, spool-up, the shot-by-shot simulation.
 */

export const DAMAGE_TYPES = ['impact', 'puncture', 'slash', 'heat', 'cold', 'electricity', 'toxin', 'blast',
  'corrosive', 'gas', 'magnetic', 'radiation', 'viral', 'true', 'void', 'tau'];
const T = Object.fromEntries(DAMAGE_TYPES.map((type, index) => [type, index]));

/** Channel names; 4 + type index is that type's bonus (base elements: their elemental mod bonus). */
export const CHANNELS = [
  'baseDamage', 'overloadAdd', 'directDamage', 'damageMultiplier',
  ...DAMAGE_TYPES.map((type) => `type:${type}`),
  'critChance', 'critChanceFlat', 'critDamage', 'critDamageFlat', 'statusChance', 'statusChanceFlat',
  'multishot', 'fireRate', 'fireRateLock', 'reloadSpeed', 'magazine', 'statusDamage', 'statusDuration',
  'faction', 'weakPointDamage', 'headshotMultiplier', 'bodyshotMultiplier', 'weakPointCritChance',
  ...DAMAGE_TYPES.map((type) => `forcedCrit:${type}`),
  ...DAMAGE_TYPES.map((type) => `forced:${type}`),
  'vigilante', 'gladiator', 'baseDamageFlat',
];
export const CH = Object.fromEntries(CHANNELS.map((name, index) => [name, index]));
const NC = CHANNELS.length;
/** Floats per candidate: A channels, B channels, half drain, base element index (-1 none). */
export const STRIDE = 2 * NC + 2;

/**
 * Timed ammo buffs of the fixed part (ammo.ts): slots of chance, seconds, refresh, efficiency
 * (1: Infinite Ammo), events per trigger and 1 when a kill triggers it. Mods with only ammo
 * effects are never candidates (searchableMods), so candidates carry no ammo channels.
 */
export const AMMO_SLOTS = 3;
export const AMMO_FIELDS = 6;
/** Additive Ammo Efficiency cap (ammo.ts AMMO_EFFICIENCY_CAP). */
const AMMO_CAP = 0.75;

/** Offsets into `params`. */
export const P = (() => {
  const layout = {};
  let at = 0;
  const field = (name, size = 1) => { layout[name] = at; at += size; };
  field('stats', 16); field('critChance'); field('critMultiplier'); field('statusChance'); field('multishot');
  field('fireRate'); field('reloadTime'); field('comboFactor');
  field('healthMod', 16); field('overguardMod', 16);
  field('armor'); field('armored'); field('health'); field('shield'); field('overguard'); field('toxinBypass');
  field('head'); field('weakPointBase'); field('critHeadshot'); field('weakPointOverride');
  field('viralFloor'); field('corrosiveFloor'); field('corrosiveCap'); field('toxinStatusBonus'); field('overguardMultiplier');
  field('fixedStatusTypes'); field('extraStatusTypes'); field('requireMask'); field('fixedElementMask');
  field('vigilante', 8); field('gladiator', 8); field('capacityHalf'); field('steady');
  field('timedSeconds'); field('timedFireRate'); field('kpm');
  field('reloadPerShell'); field('shellMagazine'); field('cryogenic'); field('madurai');
  field('ammoEfficiency'); field('ammoScale'); field('plainAmmoScale'); field('killBuffs');
  field('ammoBuffs', AMMO_SLOTS * AMMO_FIELDS); field('beamStart'); field('encumber'); field('debilitate');
  layout.size = at;
  return layout;
})();

/** Which combined element two base elements (heat 0, cold 1, electricity 2, toxin 3) make. */
const COMBINE = [
  [-1, T.blast, T.radiation, T.gas],
  [T.blast, -1, T.magnetic, T.viral],
  [T.radiation, T.magnetic, -1, T.corrosive],
  [T.gas, T.viral, T.corrosive, -1],
];
/**
 * Per DoT type: coefficient, ticks (0: one per second of the stretched duration, dot.ts dotTicks), seconds
 * before it ticks, seconds it ticks (Blast: a short window, unscaled).
 */
const DOT = [[T.slash, 0.35, 0, 1, 6], [T.heat, 0.5, 0, 1, 6], [T.toxin, 0.5, 0, 1, 6], [T.electricity, 0.5, 0, 0, 6], [T.gas, 0.5, 0, 0, 6], [T.blast, 0.5, 1, 1.5, 0.25]];
/** Gas stacks on a target (dot.ts GAS_CAP). */
const GAS_CAP = 10;
/** Beam ramp (simulate.ts): climb to full over this many seconds of fire, decay after a pause. */
const BEAM_RAMP_TIME = 0.6;
const BEAM_DECAY_DELAY = 0.8;
const BEAM_DECAY_TIME = 2;
/** Magazines one integration step may span for the beam ramp (steps are a few seconds at most). */
const BEAM_CYCLES = 64;
/** Heat's armour strip rises by these every 0.5 s of the chain (damage.ts HEAT_RAMP_STEPS). */
const HEAT_RAMP = [0.15, 0.15, 0.1, 0.1];

/** Chance a Poisson count with this mean is 10 or more (dot.ts atLeastTen). */
function atLeastTen(mean) {
  if (!(mean > 0)) return 0;
  let term = Math.exp(-mean);
  let below = term;
  for (let i = 1; i < 10; i++) { term *= mean / i; below += term; }
  return Math.max(0, 1 - below);
}

/** Combined statuses Primed Debilitate splits: [combined, part, part, seconds a stack lasts] (dot.ts COMBINED_PARTS). */
const DEBILITATE = [[T.viral, T.cold, T.toxin, 6], [T.corrosive, T.electricity, T.toxin, 8], [T.magnetic, T.cold, T.electricity, 6],
  [T.gas, T.heat, T.toxin, 6], [T.blast, T.heat, T.cold, 1.5], [T.radiation, T.heat, T.electricity, 12]];
/** Statuses Secondary Encumber picks from: every type up to Viral (dot.ts ENCUMBER_TYPES). */
const ENCUMBER_COUNT = T.viral + 1;

/**
 * Procs per second Encumber and Primed Debilitate add on top of `rateOf` (dot.ts arcaneProcRates):
 * Encumber at most one random status per pull, Debilitate a base status on combined procs that
 * land on 10+ stacks.
 */
function arcaneExtra(params, rateOf, chance, multishot, pulls, duration) {
  const extra = new Array(16).fill(0);
  const encumber = Math.min(1, params[P.encumber]);
  if (encumber > 0 && chance > 0) {
    const each = (pulls * (1 - Math.pow(1 - encumber * Math.min(1, chance), Math.max(1, multishot)))) / ENCUMBER_COUNT;
    for (let t = 0; t < ENCUMBER_COUNT; t++) extra[t] = each;
  }
  const debilitate = Math.min(1, params[P.debilitate]);
  if (debilitate > 0) {
    for (const [combined, a, b, seconds] of DEBILITATE) {
      const rate = rateOf(combined) + extra[combined];
      const added = (rate * debilitate * atLeastTen(rate * seconds * duration)) / 2;
      extra[a] += added;
      extra[b] += added;
    }
  }
  return extra;
}

/** Cold's crit multiplier bonus, freeze cycle included (damage.ts coldCritBonus). */
function coldBonus(procs, rate, duration, canFreeze) {
  if (!(procs > 0)) return 0;
  if (!canFreeze || procs < 10) return Math.min(0.5, 0.1 + 0.05 * (procs - 1));
  const frozen = (3 * duration) / (3 * duration + 7 / rate);
  return frozen + (1 - frozen) * 0.35;
}

const armorReduction = (armor) => (armor <= 0 ? 0 : armor <= 2700 ? Math.min(0.9, 0.9 * Math.sqrt(armor / 2700)) : armor / (armor + 300));
const viralMultiplier = (stacks) => (stacks <= 0 ? 1 : 1 + Math.min(3.25, 1 + 0.25 * (stacks - 1)));
const corrosiveMultiplier = (stacks) => (stacks <= 0 ? 1 : 1 - Math.min(1, 0.26 + 0.06 * (stacks - 1)));

/** All orders of the elements in `mask` (bits 0-3), as arrays. */
function permutations(mask) {
  const items = [0, 1, 2, 3].filter((bit) => mask & (1 << bit));
  const out = [];
  const walk = (rest, chosen) => {
    if (!rest.length) { out.push(chosen); return; }
    rest.forEach((item, i) => walk([...rest.slice(0, i), ...rest.slice(i + 1)], [...chosen, item]));
  };
  walk(items, []);
  return out;
}

/** Damage per projectile by type (pre-crit) for one elemental order, with `db` as the base damage bonus. */
function composition(params, S, db, order) {
  const stats = params.slice(P.stats, P.stats + 16);
  const baseTotal = stats.reduce((sum, value) => sum + value, 0);
  const damage = new Array(16).fill(0);
  for (let t = 0; t < 3; t++) damage[t] = stats[t] * (1 + S[4 + t]) * db;
  // Madurai Phoenix Talons (build.ts): a share of the whole base, split by the modded physical weights.
  const physical = damage[0] + damage[1] + damage[2];
  if (params[P.madurai] > 0 && physical > 0) {
    const added = baseTotal * params[P.madurai] * db;
    for (let t = 0; t < 3; t++) damage[t] += (added * damage[t]) / physical;
  }
  for (let t = 7; t < 16; t++) damage[t] = stats[t] * db + baseTotal * S[4 + t] * db;
  const amount = [0, 1, 2, 3].map((e) => baseTotal * S[4 + 3 + e] * db + stats[3 + e] * db);
  const hierarchy = [...order];
  for (let e = 0; e < 4; e++) if (!hierarchy.includes(e) && stats[3 + e] > 0) hierarchy.push(e);
  for (let i = 0; i < hierarchy.length; i += 2) {
    const first = hierarchy[i];
    if (i + 1 >= hierarchy.length) { damage[3 + first] += amount[first]; continue; }
    damage[COMBINE[first][hierarchy[i + 1]]] += amount[first] + amount[hierarchy[i + 1]];
  }
  return damage;
}

/** Sums the A and B halves of base + chosen candidates. */
function sums(model, combo) {
  const A = model.params.slice(P.size, P.size + NC);
  const B = model.params.slice(P.size + NC, P.size + 2 * NC);
  for (const i of combo) {
    const at = i * STRIDE;
    for (let c = 0; c < NC; c++) { A[c] += model.vectors[at + c]; B[c] += model.vectors[at + NC + c]; }
  }
  return { A, B };
}

/** Proxy score (higher is better: 1 / seconds to kill) of one combination of candidate indices. 0 = infeasible. */
export function proxyScore(model, combo) {
  const params = model.params;
  // Incompatible pairs and the drain lower bound (every mod in a matching slot).
  let half = 0;
  for (const i of combo) {
    half += model.vectors[i * STRIDE + 2 * NC];
    for (const j of combo) {
      if (j !== i && (j < 32 ? model.clash[2 * i] & (1 << j) : model.clash[2 * i + 1] & (1 << (j - 32)))) return 0;
    }
  }
  if (half > params[P.capacityHalf]) return 0;
  // A drawback twin (Heavy Caliber) only next to its clean mod (Serration).
  if (combo.some((i) => (model.requires?.[i] ?? -1) >= 0 && !combo.includes(model.requires[i]))) return 0;
  const { A, B } = sums(model, combo);
  let mask = params[P.fixedElementMask];
  for (const i of combo) {
    const element = model.vectors[i * STRIDE + 2 * NC + 1];
    if (element >= 0) mask |= 1 << element;
  }
  let best = 0;
  for (const order of permutations(mask)) best = Math.max(best, scoreOrder(params, A, B, order));
  return best;
}

/**
 * A timed trait buff (Athodai's Overdrive, damage.ts hitEnemy): the kill speed with it and without
 * it, blended by its uptime, seconds / (seconds + kill time at the plain rate).
 */
function scoreOrder(params, A, B, order) {
  const on = scoreAmmo(params, A, B, order, false);
  const seconds = params[P.timedSeconds];
  if (!(seconds > 0) || !(on > 0)) return on;
  const plain = scoreAmmo(params, A, B, order, true);
  const uptime = plain > 0 ? seconds / (seconds + 1 / plain) : 0;
  return uptime * on + (1 - uptime) * plain;
}

/**
 * Ammo buffs a kill triggers (Arcane Pistoleer) need the kill spacing: scored once without them,
 * then again with that spacing (damage.ts ammoHit repeats this until it settles).
 * shortcut: one round, and 1 / score as the spacing (exact: shots to kill at the sustained rate).
 */
function scoreAmmo(params, A, B, order, plain) {
  const first = scoreState(params, A, B, order, plain, 0);
  return params[P.killBuffs] > 0 && first > 0 ? scoreState(params, A, B, order, plain, 1 / first) : first;
}

/** Share of the time a timed ammo buff is up at `interval` seconds between its events (ammo.ts ammoBuffUptime). */
function ammoUptime(chance, seconds, refresh, interval) {
  const c = Math.min(1, Math.max(0, chance));
  if (!(c > 0) || !(interval > 0) || !Number.isFinite(interval)) return 0;
  if (refresh) return c >= 1 ? 1 : 1 - Math.pow(1 - c, seconds / interval);
  return seconds / (seconds + interval / c);
}

/**
 * Average ammo per shot (ammo.ts expectedAmmoCost): the fixed part's Ammo Efficiency, capped, times the
 * multiplicative sources, with the timed buffs at their uptimes. Hit-triggered buffs depend on the
 * pellet rate, which depends on the cost: iterated as damage.ts ammoHit does.
 */
function ammoCostOf(params, plain, shells, fireRate, reload, multishot, killSpacing) {
  const scale = params[plain ? P.plainAmmoScale : P.ammoScale];
  const costWith = (extra) => (1 - Math.min(AMMO_CAP, Math.max(0, params[P.ammoEfficiency] + extra))) * scale;
  const slot = (i, field) => params[P.ammoBuffs + i * AMMO_FIELDS + field];
  const chances = Array.from({ length: AMMO_SLOTS }, (_, i) => slot(i, 0));
  let cost = costWith(0);
  if (!chances.some((c) => c > 0) || !(reload > 0)) return cost;
  let uptimes = chances.map(() => 0);
  for (let round = 0; round < 20; round++) {
    const shots = Math.max(1, shells) / Math.max(1e-6, cost);
    const pellets = (cost > 1e-9 ? shots / (shots / Math.max(0.01, fireRate) + reload) : fireRate) * Math.max(1, multishot);
    const next = chances.map((c, i) => ammoUptime(c, slot(i, 1), slot(i, 2) > 0, slot(i, 5) > 0 ? killSpacing : (slot(i, 4) || 1) / pellets));
    if (next.every((u, i) => Math.abs(u - uptimes[i]) < 1e-6)) break;
    uptimes = next;
    cost = 0;
    for (let mask = 0; mask < 1 << AMMO_SLOTS; mask++) {
      let odds = 1;
      let extra = 0;
      let free = false;
      for (let i = 0; i < AMMO_SLOTS; i++) {
        const on = (mask >> i) & 1;
        odds *= on ? uptimes[i] : 1 - uptimes[i];
        if (on && slot(i, 3) >= 1) free = true;
        else if (on) extra += slot(i, 3);
      }
      if (odds > 0 && !free) cost += odds * costWith(extra);
    }
  }
  return cost;
}

/**
 * Kill speed with the timed buff on, or `plain` without its fire rate and Infinite Ammo;
 * `killSpacing` seconds between kills for kill-triggered ammo buffs (0: off).
 */
function scoreState(params, A, B, order, plain, killSpacing) {
  const stats = params.slice(P.stats, P.stats + 16);
  // Status types: the build's own (types it deals, forced ones) plus the extra ones, unless pinned.
  const shape = composition(params, A.map((a, c) => a + B[c]), 1, order);
  const status0 = params[P.statusChance] * (1 + A[CH.statusChance] + B[CH.statusChance]) + A[CH.statusChanceFlat] + B[CH.statusChanceFlat];
  let own = 0;
  for (let t = 0; t < 16; t++) {
    const forced = A[CH['forcedCrit:impact'] + t] + A[CH['forced:impact'] + t] > 0;
    if ((status0 > 0 && t !== T.true && shape[t] > 0) || forced) own++;
  }
  const types = params[P.fixedStatusTypes] >= 0 ? params[P.fixedStatusTypes] : Math.max(1, own + params[P.extraStatusTypes]);
  const S = A.map((a, c) => a + B[c] * (types - 1));

  const db = 1 + S[CH.baseDamage];
  const overloadShare = S[CH.overloadAdd] / db;
  const finalFactor = (1 - overloadShare) * (1 + S[CH.damageMultiplier]) + overloadShare;
  const direct = (1 + S[CH.directDamage]) * finalFactor;
  const damage = composition(params, S, db, order).map((value) => value * direct);
  const baseTotal = stats.reduce((sum, value) => sum + value, 0);
  const flat = S[CH.baseDamageFlat] * db;
  let total = damage.reduce((sum, value) => sum + value, 0);
  if (flat > 0 && total > 0) {
    const grow = 1 + flat / total;
    for (let t = 0; t < 16; t++) damage[t] *= grow;
    total *= grow;
  }
  const require = params[P.requireMask];
  for (let t = 0; t < 16; t++) if ((require & (1 << t)) && !(damage[t] > 0)) return 0;
  if (!(total > 0)) return 0;

  const pieces = (table, count) => params[table + Math.min(7, Math.max(0, Math.round(count)))];
  const critBase = params[P.critChance] * (1 + S[CH.critChance]) + S[CH.critChanceFlat] + pieces(P.gladiator, S[CH.gladiator]) * params[P.comboFactor];
  const critMods = params[P.critMultiplier] * (1 + S[CH.critDamage]) + S[CH.critDamageFlat];
  const multishot = params[P.multishot] * (1 + S[CH.multishot]);
  const fireRate = S[CH.fireRateLock] > 0 ? params[P.fireRate] : params[P.fireRate] * (1 + S[CH.fireRate] - (plain ? params[P.timedFireRate] : 0));
  // Shell-by-shell reloads load the real capacity, not the Ammo Efficiency stretched magazine.
  const shells = Math.max(1, Math.round(params[P.shellMagazine] * (1 + S[CH.magazine])));
  const reload = (params[P.reloadTime] + params[P.reloadPerShell] * shells) / (1 + S[CH.reloadSpeed]);
  // Ammo Efficiency stretches the magazine: shots per reload.
  const magazine = shells / Math.max(1e-6, ammoCostOf(params, plain, shells, fireRate, reload, multishot, killSpacing));
  const status = params[P.statusChance] * (1 + S[CH.statusChance]) + S[CH.statusChanceFlat];
  const tier = pieces(P.vigilante, S[CH.vigilante]);
  const head = params[P.head] > 0;
  const location = head
    ? ((params[P.weakPointOverride] || params[P.weakPointBase]) + 1.5 * S[CH.weakPointDamage]) * (1 + S[CH.headshotMultiplier])
    : Math.max(0, 1 + S[CH.bodyshotMultiplier]);
  const crit0 = Math.max(0, critBase + (head ? params[P.critChance] * S[CH.weakPointCritChance] : 0));
  const faction = 1 + S[CH.faction];

  const fireTime = magazine / Math.max(0.01, fireRate);
  const cycle = fireTime + reload;
  const pulls = magazine / cycle;
  const duration = 1 + Math.max(-0.9, S[CH.statusDuration]);
  const forcedOf = (t, pCrit) => S[CH['forcedCrit:impact'] + t] * pCrit + S[CH['forced:impact'] + t];
  // Without the status build-up (simulate off) only the player's own stacks count.
  const steady = params[P.steady] > 0;
  const seed = (baseTotal + S[CH.baseDamageFlat]) * db * finalFactor;
  // Pulls fired in the first `seconds`: a magazine at the fire rate, then the reload (damage.ts pullsBy).
  const firedBy = (seconds) => {
    if (!(seconds > 0)) return 0;
    const cycles = Math.floor(seconds / cycle);
    return (cycles * fireTime + Math.min(fireTime, seconds - cycles * cycle)) * fireRate;
  };
  // Seconds of sustained fire in the `life` seconds up to `at` (damage.ts firedWithin).
  const within = (at, life) => (at === Infinity ? life : (firedBy(at) - firedBy(at - life)) / pulls);
  // Beam ramp averaged over the fire between `from` and `to` (damage.ts beamShare).
  const start = params[P.beamStart];
  const restart = Math.max(start, 1 - ((1 - start) * Math.max(0, reload - BEAM_DECAY_DELAY)) / BEAM_DECAY_TIME);
  const area = (level, x) => {
    const rising = Math.min(x, ((1 - level) * BEAM_RAMP_TIME) / (1 - start));
    return rising * level + ((1 - start) * rising * rising) / (2 * BEAM_RAMP_TIME) + (x - rising);
  };
  const beamShare = (from, to) => {
    if (!(start > 0) || !steady) return 1;
    if (from === Infinity) return area(restart, fireTime) / fireTime;
    let summed = 0;
    let fired = 0;
    for (let c = Math.floor(from / cycle); c * cycle < to && c < Math.floor(from / cycle) + BEAM_CYCLES; c++) {
      const lo = Math.max(from, c * cycle) - c * cycle;
      const hi = Math.min(to, c * cycle + fireTime) - c * cycle;
      if (hi <= lo) continue;
      summed += area(c === 0 ? start : restart, hi) - area(c === 0 ? start : restart, lo);
      fired += hi - lo;
    }
    return fired > 0 ? summed / fired : 1;
  };

  // 1 / seconds to kill with the target's state `at` seconds in, the trigger at `firing` x the
  // sustained pull rate (damage.ts hitOnce in steady mode: withSteadyCrit, steadyStatusDebuffs).
  const killRate = (at, firing, beam) => {
    const stacks = (rate, life, cap) => (steady ? Math.min(cap, rate * within(at, life)) : 0);
    const rateAt = (t, chance, pCrit) => multishot * pulls * (chance * (damage[t] / total) + forcedOf(t, pCrit));
    const pCrit0 = Math.min(1, crit0);
    // Encumber and Debilitate procs, at the crit and status before the build-up (damage.ts withSteadyCrit).
    const extra0 = arcaneExtra(params, (t) => rateAt(t, status, pCrit0), status, multishot, pulls, duration);
    const puncture = stacks(rateAt(T.puncture, status, pCrit0) + extra0[T.puncture], 10 * duration, 5);
    // Secondary Cryogenic: Cold stacks per Puncture proc.
    const coldRate = rateAt(T.cold, status, pCrit0) + extra0[T.cold] + params[P.cryogenic] * (rateAt(T.puncture, status, pCrit0) + extra0[T.puncture]);
    const cold = stacks(coldRate, 6 * duration, Infinity);
    const tau = stacks(rateAt(T.tau, status, pCrit0), 8 * duration, 10);
    const crit = crit0 + 0.05 * puncture;
    const critDamage = Math.max(1, critMods + coldBonus(cold, coldRate, duration, true));
    const chance = status * (1 + Math.min(1, 0.1 * tau));
    const perTier = head && params[P.critHeadshot] > 0 ? 2 * critDamage - 1 : critDamage - 1;
    const averageCrit = 1 + (crit + Math.min(1, crit) * tier) * perTier;
    // On Overguard only Cold lands: at most 4 stacks, no freeze, no Puncture (damage.ts withSteadyCrit).
    const guardCritDamage = Math.max(1, critMods + coldBonus(stacks(coldRate, 6 * duration, 4), coldRate, duration, false));
    const guardPerTier = head && params[P.critHeadshot] > 0 ? 2 * guardCritDamage - 1 : guardCritDamage - 1;
    const guardCrit = 1 + (crit0 + Math.min(1, crit0) * tier) * guardPerTier;
    const pCrit = Math.min(1, crit);
    const critOnCrit = pCrit > 0 ? (averageCrit - (1 - pCrit)) / pCrit : 1 + perTier;
    // With the build-up's crit and status (damage.ts steadyStatusDebuffs, computeDot).
    const extra = arcaneExtra(params, (t) => rateAt(t, chance, pCrit), chance, multishot, pulls, duration);
    const rate = (t) => rateAt(t, chance, pCrit) + extra[t];
    const viral = viralMultiplier(Math.max(params[P.viralFloor], stacks(rate(T.viral), 6 * duration, 10)));
    const corrosive = Math.max(params[P.corrosiveFloor], stacks(rate(T.corrosive), 8 * duration, params[P.corrosiveCap]));
    const ramp = at === Infinity ? 0.5 : HEAT_RAMP.reduce((sum, rise, i) => sum + (at >= 0.5 * (i + 1) * duration ? rise : 0), 0);
    const heat = ramp * (1 - Math.exp(-stacks(rate(T.heat), 6 * duration, Infinity)));
    const armored = params[P.armored] > 0;
    const dr = armored ? armorReduction(params[P.armor] * corrosiveMultiplier(corrosive) * (1 - heat)) : 0;

    let health = 0;
    let shield = 0;
    let overguard = 0;
    let bypass = 0;
    for (let t = 0; t < 16; t++) {
      if (!(damage[t] > 0)) continue;
      const landed = damage[t] * location;
      const toHealth = Math.max(landed * (1 + params[P.healthMod + t]) * (1 - dr) * viral, armored ? 1 : 0);
      health += toHealth;
      const bypasses = t === T.toxin && params[P.toxinBypass] > 0;
      if (params[P.shield] > 0 && !bypasses) shield += landed * (1 + params[P.healthMod + t]);
      if (bypasses) bypass += toHealth;
      overguard += landed * (1 + params[P.overguardMod + t]) * params[P.overguardMultiplier];
    }
    const perShot = averageCrit * multishot * faction;

    // Status DoT (dot.ts computeDot), only the ticks that land by `at`.
    let dotDps = 0;
    let dotShield = 0;
    for (const [t, coefficient, fixedTicks, delay, length] of DOT) {
      const ticks = fixedTicks || Math.max(1, Math.floor(6 * duration + 1e-9));
      const share = damage[t] / total;
      const forcedCrit = multishot * pulls * S[CH['forcedCrit:impact'] + t] * pCrit;
      const forcedPlain = multishot * pulls * S[CH['forced:impact'] + t];
      if (!(share > 0) && forcedCrit + forcedPlain + extra[t] <= 0) continue;
      const natural = chance * share * multishot * pulls + extra[t];
      const weighted = (natural + forcedPlain) * averageCrit + forcedCrit * critOnCrit;
      const elemental = t >= T.heat && t <= T.toxin ? S[4 + t] : 0;
      const typeBonus = t === T.toxin ? 1 + params[P.toxinStatusBonus] : 1;
      const scale = coefficient * (1 + elemental) * (1 + S[CH.statusDamage]) * typeBonus * faction;
      // Heat and Gas stacks tick together: one +1 per tick while any is up (dot.ts MERGED_TICKS).
      const merged = t === T.heat || t === T.gas;
      const raw = (seed * faction + (merged ? 0 : 1)) * scale;
      const trueDamage = t === T.slash;
      const toShield = location * (1 + (trueDamage ? 0 : params[P.healthMod + t]));
      const toHealth = (1 - (trueDamage ? 0 : dr)) * viral;
      const span = t === T.blast ? length : length * duration;
      let landed = steady && at !== Infinity ? within(at - delay, span) / span : 1;
      const procs = natural + forcedPlain + forcedCrit;
      if (t === T.heat && steady && at !== Infinity) {
        // A refreshing Heat chain ticks every stack it has once 1 s old (damage.ts hitOnce).
        const windowed = procs * within(at, span);
        const stacks = at >= delay ? windowed + (1 - Math.exp(-windowed)) * (procs * within(at, at) - windowed) : 0;
        landed = procs > 0 ? stacks / (procs * ticks) : 0;
      }
      const active = procs * 6 * duration;
      const kept = t === T.gas && active > GAS_CAP ? GAS_CAP / active : 1;
      const plusOne = merged ? (1 - Math.exp(-active)) * scale : 0;
      const attacker = (weighted * raw * ticks * kept + plusOne) * toShield * landed;
      dotDps += attacker * toHealth * beam;
      if (params[P.shield] > 0 && !(t === T.toxin && params[P.toxinBypass] > 0)) dotShield += attacker * beam;
    }

    // Sequential kill: Overguard, then shields (Toxin chewing health meanwhile), then health.
    const fired = perShot * pulls * firing * beam;
    const healthDps = health * fired + dotDps;
    const shieldDps = shield * fired + dotShield;
    const overguardDps = overguard * guardCrit * multishot * faction * pulls * firing * beam;
    let seconds = 0;
    if (params[P.overguard] > 0) {
      if (!(overguardDps > 0)) return 0;
      seconds += params[P.overguard] / overguardDps;
    }
    let remaining = params[P.health];
    if (params[P.shield] > 0 && shieldDps > 0) {
      const shieldSeconds = params[P.shield] / shieldDps;
      seconds += shieldSeconds;
      remaining = Math.max(0, remaining - shieldSeconds * bypass * fired);
    }
    if (remaining > 0) {
      if (!(healthDps > 0)) return 0;
      seconds += remaining / healthDps;
    }
    return seconds > 0 ? 1 / seconds : 0;
  };

  // Kill progress summed over time steps, as damage.ts fightLengthHit does.
  const full = killRate(Infinity, 1, beamShare(Infinity));
  if (!steady || !(full > 0)) return full;
  // Kills per minute (damage.ts killRate): pulls per second over the pulls the kill took, so a
  // kill inside the first magazine does not get the reloads' credit 1 / seconds would give it.
  const finish = (seconds) => (params[P.kpm] > 0 ? pulls / firedBy(seconds) : 1 / seconds);
  const progress = (a, b) => (b - a) * killRate((a + b) / 2, (firedBy(b) - firedBy(a)) / ((b - a) * pulls), beamShare(a, b));
  // A refreshing Heat chain keeps growing: with Heat, step to the kill (damage.ts fightLengthHit).
  const heatChain = status * damage[T.heat] > 0 || S[CH['forced:impact'] + T.heat] + S[CH['forcedCrit:impact'] + T.heat] > 0
    || arcaneExtra(params, (t) => multishot * pulls * status * (damage[t] / total), status, multishot, pulls, duration)[T.heat] > 0;
  const settled = heatChain ? Infinity : 8 * duration + 1.5;
  // Steps end where the state jumps (damage.ts fightLengthHit).
  const breaks = [0.5 * duration, duration, 1.5 * duration, 2 * duration, 1, 1.5, 1.75].sort((x, y) => x - y);
  // Seconds to fire `p` pulls with whole reloads (damage.ts secondsToFire).
  const secondsToFire = (p) => {
    const cycles = Math.max(0, Math.ceil(p / magazine) - 1);
    return cycles * cycle + (p - cycles * magazine) / fireRate;
  };
  let t = 0;
  let done = 0;
  const first = Math.min(1 / full / 4, settled / 8);
  let step = first;
  for (let i = 0; i < 48 && t < settled; i++) {
    let next = Math.min(settled, t + Math.min(step, Math.max(first, t)), breaks.find((x) => x > t + 1e-9) ?? Infinity);
    let area = progress(t, next);
    for (let k = 0; k < 4 && done + area > 1 + 1e-3; k++) {
      next = t + ((next - t) * (1 - done)) / area;
      area = progress(t, next);
    }
    if (done + area >= 1 - 1e-3) return finish(next);
    done += area;
    t = next;
    step *= 1.6;
  }
  return finish(secondsToFire(firedBy(t) + ((1 - done) / full) * pulls));
}

/** n choose k as a float (exact below 2^53). */
export function binomial(n, k) {
  if (k < 0 || k > n) return 0;
  let result = 1;
  for (let i = 1; i <= k; i++) result = (result * (n - k + i)) / i;
  return Math.round(result);
}

/**
 * Keeps the `limit` best (score, combination) pairs. `threshold` is the score to beat once full,
 * which the GPU uses to skip writing everything below it.
 */
class TopList {
  constructor(limit) { this.limit = limit; this.items = []; this.threshold = 0; }
  add(score, combo) {
    if (score <= this.threshold) return;
    this.items.push({ score, combo });
    if (this.items.length >= 2 * this.limit) this.trim();
  }
  trim() {
    this.items.sort((a, b) => b.score - a.score);
    if (this.items.length > this.limit) this.items.length = this.limit;
    if (this.items.length === this.limit) this.threshold = this.items[this.limit - 1].score;
  }
  result() { this.trim(); return this.items; }
}

/** Every combination of `k` of `n` indices, in colex order. */
function* combinations(n, k) {
  const combo = Array.from({ length: k }, (_, i) => i);
  if (k > n) return;
  for (;;) {
    yield combo;
    let i = 0;
    while (i < k - 1 && combo[i] + 1 === combo[i + 1]) { combo[i] = i; i++; }
    if (i === k - 1 && combo[i] + 1 >= n) return;
    combo[i]++;
  }
}

/** The same pre-filter on the CPU: for tests, and for browsers without WebGPU (small searches). */
export function cpuSearch(model, limit = model.keep) {
  const top = new TopList(limit);
  for (const combo of combinations(model.candidates.length, model.slots)) top.add(proxyScore(model, combo), [...combo]);
  return top.result();
}

/**
 * The damage model in WGSL, shared by both searches; layout constants baked in. `unroll` writes
 * killRate's two loops out per type: 1.7x faster on hardware GPUs in Chromium and Firefox, but
 * SwiftShader's compiler needs over 5 GB for it, so software adapters get the loops.
 */
function scoringWgsl(unroll) {
  const repeat = (name, values, body) => (unroll
    ? values.map((value) => `{ let ${name} = ${value}u; ${body} }`).join('\n  ')
    : `for (var ${name} = 0u; ${name} < ${values.length}u; ${name}++) { ${body} }`);
  // Orders of 1, 2, 3 and 4 elements, rows of 4 (unused entries 0), starting at rows 0, 1, 3, 9.
  const rows = [1, 3, 7, 15].flatMap((mask) => permutations(mask)).map((order) => [...order, 0, 0, 0].slice(0, 4));
  return /* wgsl */ `
const NC: u32 = ${NC}u;
const STRIDE: u32 = ${STRIDE}u;
@group(0) @binding(0) var<storage, read> params: array<f32>;
@group(0) @binding(1) var<storage, read> vectors: array<f32>;

var<private> PERMS: array<u32, ${rows.length * 4}> = array<u32, ${rows.length * 4}>(${rows.flat().map((v) => `${v}u`).join(',')});
var<private> COMBINE: array<i32, 16> = array<i32, 16>(${COMBINE.flat().join(',')});
var<private> PERM_START: array<u32, 5> = array<u32, 5>(0u, 0u, 1u, 3u, 9u);
var<private> PERM_COUNT: array<u32, 5> = array<u32, 5>(1u, 1u, 2u, 6u, 24u);

fn armorDr(a: f32) -> f32 {
  if (a <= 0.0) { return 0.0; }
  if (a <= 2700.0) { return min(0.9, 0.9 * sqrt(a / 2700.0)); }
  return a / (a + 300.0);
}
fn viralMul(s: f32) -> f32 { if (s <= 0.0) { return 1.0; } return 1.0 + min(3.25, 1.0 + 0.25 * (s - 1.0)); }
fn corrMul(s: f32) -> f32 { if (s <= 0.0) { return 1.0; } return 1.0 - min(1.0, 0.26 + 0.06 * (s - 1.0)); }
fn coldCrit(procs: f32, rate: f32, d: f32, canFreeze: bool) -> f32 {
  if (!(procs > 0.0)) { return 0.0; }
  if (!canFreeze || procs < 10.0) { return min(0.5, 0.1 + 0.05 * (procs - 1.0)); }
  let frozen = 3.0 * d / (3.0 * d + 7.0 / rate);
  return frozen + (1.0 - frozen) * 0.35;
}
fn pieces(table: u32, count: f32) -> f32 { return params[table + u32(clamp(round(count), 0.0, 7.0))]; }

var<private> S: array<f32, ${NC}>;
var<private> A: array<f32, ${NC}>;
var<private> B: array<f32, ${NC}>;
var<private> dmg: array<f32, 16>;

fn compose(db: f32, orderIn: array<u32, 4>, len: u32) {
  var order = orderIn;
  var baseTotal = 0.0;
  for (var t = 0u; t < 16u; t++) { baseTotal += params[${P.stats}u + t]; dmg[t] = 0.0; }
  for (var t = 0u; t < 3u; t++) { dmg[t] = params[${P.stats}u + t] * (1.0 + S[4u + t]) * db; }
  let physical = dmg[0] + dmg[1] + dmg[2];
  if (params[${P.madurai}u] > 0.0 && physical > 0.0) {
    let added = baseTotal * params[${P.madurai}u] * db;
    for (var t = 0u; t < 3u; t++) { dmg[t] += added * dmg[t] / physical; }
  }
  for (var t = 7u; t < 16u; t++) { dmg[t] = params[${P.stats}u + t] * db + baseTotal * S[4u + t] * db; }
  var hierarchy: array<u32, 4>;
  var used = 0u;
  var n = 0u;
  for (var i = 0u; i < len; i++) { hierarchy[n] = order[i]; n++; used |= 1u << order[i]; }
  for (var e = 0u; e < 4u; e++) {
    if ((used & (1u << e)) == 0u && params[${P.stats}u + 3u + e] > 0.0) { hierarchy[n] = e; n++; }
  }
  var i = 0u;
  loop {
    if (i >= n) { break; }
    let first = hierarchy[i];
    let a = baseTotal * S[7u + first] * db + params[${P.stats}u + 3u + first] * db;
    if (i + 1u >= n) { dmg[3u + first] += a; break; }
    let second = hierarchy[i + 1u];
    let b = baseTotal * S[7u + second] * db + params[${P.stats}u + 3u + second] * db;
    dmg[u32(COMBINE[first * 4u + second])] += a + b;
    i += 2u;
  }
}

// A timed trait buff (Athodai's Overdrive): on and plain kill speeds blended by uptime (JS scoreOrder).
fn scoreOrder(order: array<u32, 4>, len: u32) -> f32 {
  let on = scoreAmmo(order, len, false);
  let seconds = params[${P.timedSeconds}u];
  if (!(seconds > 0.0) || !(on > 0.0)) { return on; }
  let plain = scoreAmmo(order, len, true);
  var uptime = 0.0;
  if (plain > 0.0) { uptime = seconds / (seconds + 1.0 / plain); }
  return uptime * on + (1.0 - uptime) * plain;
}

// Kill-triggered ammo buffs: scored without them, then with that kill spacing (JS scoreAmmo).
// One call site in a loop: the compiler inlines scoreState at each call (SwiftShader took 19x longer with two).
fn scoreAmmo(order: array<u32, 4>, len: u32, plain: bool) -> f32 {
  var score = 0.0;
  var spacing = 0.0;
  for (var k = 0u; k < 2u; k++) {
    score = scoreState(order, len, plain, spacing);
    if (!(params[${P.killBuffs}u] > 0.0 && score > 0.0)) { break; }
    spacing = 1.0 / score;
  }
  return score;
}

fn ammoUptime(chance: f32, seconds: f32, refreshes: bool, interval: f32) -> f32 {
  let c = clamp(chance, 0.0, 1.0);
  if (!(c > 0.0) || !(interval > 0.0) || interval > 1e30) { return 0.0; }
  if (refreshes) {
    if (c >= 1.0) { return 1.0; }
    return 1.0 - pow(1.0 - c, seconds / interval);
  }
  return seconds / (seconds + interval / c);
}
fn ammoSlot(i: u32, field: u32) -> f32 { return params[${P.ammoBuffs}u + i * ${AMMO_FIELDS}u + field]; }
fn ammoCostWith(extra: f32, plain: bool) -> f32 {
  var scale = params[${P.ammoScale}u];
  if (plain) { scale = params[${P.plainAmmoScale}u]; }
  return (1.0 - min(${AMMO_CAP}, max(0.0, params[${P.ammoEfficiency}u] + extra))) * scale;
}
// Average ammo per shot with the timed buffs at their uptimes (JS ammoCostOf).
fn ammoCost(plain: bool, shells: f32, fireRate: f32, reload: f32, multishot: f32, killSpacing: f32) -> f32 {
  var chances: array<f32, ${AMMO_SLOTS}>;
  var hasBuff = false;
  for (var i = 0u; i < ${AMMO_SLOTS}u; i++) {
    chances[i] = ammoSlot(i, 0u);
    if (chances[i] > 0.0) { hasBuff = true; }
  }
  var cost = ammoCostWith(0.0, plain);
  if (!hasBuff || !(reload > 0.0)) { return cost; }
  var uptimes: array<f32, ${AMMO_SLOTS}>;
  for (var tries = 0u; tries < 20u; tries++) {
    let shots = max(1.0, shells) / max(1e-6, cost);
    var pellets = fireRate;
    if (cost > 1e-9) { pellets = shots / (shots / max(0.01, fireRate) + reload); }
    pellets *= max(1.0, multishot);
    var settled = true;
    var next: array<f32, ${AMMO_SLOTS}>;
    for (var i = 0u; i < ${AMMO_SLOTS}u; i++) {
      var interval = killSpacing;
      if (ammoSlot(i, 5u) <= 0.0) {
        var every = ammoSlot(i, 4u);
        if (every == 0.0) { every = 1.0; }
        interval = every / pellets;
      }
      next[i] = ammoUptime(chances[i], ammoSlot(i, 1u), ammoSlot(i, 2u) > 0.0, interval);
      if (abs(next[i] - uptimes[i]) >= 1e-6) { settled = false; }
    }
    if (settled) { break; }
    uptimes = next;
    cost = 0.0;
    for (var mask = 0u; mask < ${1 << AMMO_SLOTS}u; mask++) {
      var odds = 1.0;
      var extra = 0.0;
      var free = false;
      for (var i = 0u; i < ${AMMO_SLOTS}u; i++) {
        if (((mask >> i) & 1u) == 1u) {
          odds *= uptimes[i];
          if (ammoSlot(i, 3u) >= 1.0) { free = true; } else { extra += ammoSlot(i, 3u); }
        } else {
          odds *= 1.0 - uptimes[i];
        }
      }
      if (odds > 0.0 && !free) { cost += odds * ammoCostWith(extra, plain); }
    }
  }
  return cost;
}

fn scoreState(order: array<u32, 4>, len: u32, plain: bool, killSpacing: f32) -> f32 {
  for (var c = 0u; c < NC; c++) { S[c] = A[c] + B[c]; }
  compose(1.0, order, len);
  let status0 = params[${P.statusChance}u] * (1.0 + S[${CH.statusChance}u]) + S[${CH.statusChanceFlat}u];
  var own = 0.0;
  for (var t = 0u; t < 16u; t++) {
    let forced = A[${CH['forcedCrit:impact']}u + t] + A[${CH['forced:impact']}u + t] > 0.0;
    if ((status0 > 0.0 && t != ${T.true}u && dmg[t] > 0.0) || forced) { own += 1.0; }
  }
  var types = max(1.0, own + params[${P.extraStatusTypes}u]);
  if (params[${P.fixedStatusTypes}u] >= 0.0) { types = params[${P.fixedStatusTypes}u]; }
  for (var c = 0u; c < NC; c++) { S[c] = A[c] + B[c] * (types - 1.0); }

  let db = 1.0 + S[${CH.baseDamage}u];
  let overloadShare = S[${CH.overloadAdd}u] / db;
  let finalFactor = (1.0 - overloadShare) * (1.0 + S[${CH.damageMultiplier}u]) + overloadShare;
  let direct = (1.0 + S[${CH.directDamage}u]) * finalFactor;
  compose(db, order, len);
  var baseTotal = 0.0;
  var total = 0.0;
  for (var t = 0u; t < 16u; t++) { baseTotal += params[${P.stats}u + t]; dmg[t] *= direct; total += dmg[t]; }
  let flatAdd = S[${CH.baseDamageFlat}u] * db;
  if (flatAdd > 0.0 && total > 0.0) {
    let grow = 1.0 + flatAdd / total;
    for (var t = 0u; t < 16u; t++) { dmg[t] *= grow; }
    total *= grow;
  }
  let needed = u32(params[${P.requireMask}u]);
  for (var t = 0u; t < 16u; t++) { if ((needed & (1u << t)) != 0u && !(dmg[t] > 0.0)) { return 0.0; } }
  if (!(total > 0.0)) { return 0.0; }

  let critBase = params[${P.critChance}u] * (1.0 + S[${CH.critChance}u]) + S[${CH.critChanceFlat}u] + pieces(${P.gladiator}u, S[${CH.gladiator}u]) * params[${P.comboFactor}u];
  kCritMods = params[${P.critMultiplier}u] * (1.0 + S[${CH.critDamage}u]) + S[${CH.critDamageFlat}u];
  kMultishot = params[${P.multishot}u] * (1.0 + S[${CH.multishot}u]);
  var timedFireRate = 0.0;
  if (plain) { timedFireRate = params[${P.timedFireRate}u]; }
  kFireRate = params[${P.fireRate}u] * (1.0 + S[${CH.fireRate}u] - timedFireRate);
  if (S[${CH.fireRateLock}u] > 0.0) { kFireRate = params[${P.fireRate}u]; }
  let shells = max(1.0, round(params[${P.shellMagazine}u] * (1.0 + S[${CH.magazine}u])));
  let reload = (params[${P.reloadTime}u] + params[${P.reloadPerShell}u] * shells) / (1.0 + S[${CH.reloadSpeed}u]);
  let magazine = shells / max(1e-6, ammoCost(plain, shells, kFireRate, reload, kMultishot, killSpacing));
  kStatus = params[${P.statusChance}u] * (1.0 + S[${CH.statusChance}u]) + S[${CH.statusChanceFlat}u];
  kTier = pieces(${P.vigilante}u, S[${CH.vigilante}u]);
  kHead = params[${P.head}u] > 0.0;
  kZoneMul = max(0.0, 1.0 + S[${CH.bodyshotMultiplier}u]);
  kCrit0 = max(0.0, critBase);
  if (kHead) {
    var wp = params[${P.weakPointOverride}u];
    if (wp == 0.0) { wp = params[${P.weakPointBase}u]; }
    kZoneMul = (wp + 1.5 * S[${CH.weakPointDamage}u]) * (1.0 + S[${CH.headshotMultiplier}u]);
    kCrit0 = max(0.0, critBase + params[${P.critChance}u] * S[${CH.weakPointCritChance}u]);
  }
  kFaction = 1.0 + S[${CH.faction}u];
  kTotal = total;
  kFireTime = magazine / max(0.01, kFireRate);
  kCycle = kFireTime + reload;
  kPulls = magazine / kCycle;
  kDuration = 1.0 + max(-0.9, S[${CH.statusDuration}u]);
  kSteady = params[${P.steady}u] > 0.0;
  kSeed = (baseTotal + S[${CH.baseDamageFlat}u]) * db * finalFactor;
  kMagazine = magazine;
  kBeamStart = params[${P.beamStart}u];
  kRestart = max(kBeamStart, 1.0 - (1.0 - kBeamStart) * max(0.0, reload - ${BEAM_DECAY_DELAY.toFixed(2)}) / ${BEAM_DECAY_TIME.toFixed(2)});

  // Kill progress summed over time steps, as damage.ts fightLengthHit does.
  let full = killRate(0.0, 1.0, true, beamShare(0.0, 0.0, true));
  if (!kSteady || !(full > 0.0)) { return full; }
  var settled = 8.0 * kDuration + 1.5;
  // A refreshing Heat chain keeps growing: with Heat, step to the kill (JS heatChain).
  // Encumber can proc Heat; Debilitate does on Gas, Blast or Radiation procs.
  let debilitateHeat = params[${P.debilitate}u] > 0.0 && kStatus * (dmg[${T.gas}u] + dmg[${T.blast}u] + dmg[${T.radiation}u]) > 0.0;
  if (kStatus * dmg[${T.heat}u] > 0.0 || S[${CH['forced:impact']}u + ${T.heat}u] + S[${CH['forcedCrit:impact']}u + ${T.heat}u] > 0.0
    || (params[${P.encumber}u] > 0.0 && kStatus > 0.0) || debilitateHeat) { settled = 1e30; }
  var t = 0.0;
  var done = 0.0;
  let first = min(1.0 / full / 4.0, settled / 8.0);
  var step = first;
  // The JS loop with its inner shrink loop, flattened: progress has one call site, since the
  // compiler copies it (and killRate inside) per call site.
  var next = min(min(settled, t + min(step, max(first, t))), nextBreak(t));
  var steps = 0u;
  var shrinks = 0u;
  for (var turn = 0u; turn < 240u; turn++) {
    let area = progress(t, next);
    if (done + area > 1.001 && shrinks < 4u) {
      next = t + (next - t) * (1.0 - done) / area;
      shrinks++;
      continue;
    }
    if (done + area >= 0.999) { return finish(next); }
    done += area;
    t = next;
    step *= 1.6;
    steps++;
    shrinks = 0u;
    if (steps >= 48u || t >= settled) { break; }
    next = min(min(settled, t + min(step, max(first, t))), nextBreak(t));
  }
  return finish(secondsToFire(firedBy(t) + (1.0 - done) / full * kPulls));
}

// Steps end where the state jumps: Heat's strip steps, the DoT delays, Blast's window (JS breaks).
fn nextBreak(t: f32) -> f32 {
  var best = 1e30;
  best = laterBreak(best, 0.5 * kDuration, t);
  best = laterBreak(best, kDuration, t);
  best = laterBreak(best, 1.5 * kDuration, t);
  best = laterBreak(best, 2.0 * kDuration, t);
  best = laterBreak(best, 1.0, t);
  best = laterBreak(best, 1.5, t);
  return laterBreak(best, 1.75, t);
}
fn laterBreak(best: f32, x: f32, t: f32) -> f32 { return select(best, min(best, x), x > t + 1e-6); }
// Seconds to fire p pulls with whole reloads (JS secondsToFire).
fn secondsToFire(p: f32) -> f32 {
  let cycles = max(0.0, ceil(p / kMagazine) - 1.0);
  return cycles * kCycle + (p - cycles * kMagazine) / kFireRate;
}
// The beam ramp summed over the first x seconds of a magazine that starts at level.
fn beamArea(level: f32, x: f32) -> f32 {
  let rising = min(x, (1.0 - level) * ${BEAM_RAMP_TIME.toFixed(2)} / (1.0 - kBeamStart));
  return rising * level + (1.0 - kBeamStart) * rising * rising / (2.0 * ${BEAM_RAMP_TIME.toFixed(2)}) + (x - rising);
}
// Beam ramp averaged over the fire between a and b (inf: a later magazine; JS beamShare).
fn beamShare(a: f32, b: f32, inf: bool) -> f32 {
  if (!(kBeamStart > 0.0) || !kSteady) { return 1.0; }
  if (inf) { return beamArea(kRestart, kFireTime) / kFireTime; }
  var summed = 0.0;
  var fired = 0.0;
  let first = floor(a / kCycle);
  for (var c = first; c * kCycle < b && c < first + ${BEAM_CYCLES}.0; c += 1.0) {
    let lo = max(a, c * kCycle) - c * kCycle;
    let hi = min(b, c * kCycle + kFireTime) - c * kCycle;
    if (hi <= lo) { continue; }
    var level = kRestart;
    if (c == 0.0) { level = kBeamStart; }
    summed += beamArea(level, hi) - beamArea(level, lo);
    fired += hi - lo;
  }
  if (fired > 0.0) { return summed / fired; }
  return 1.0;
}

// 1 / kill time, or kills per second at the sustained pull rate (proxyScore's finish).
fn finish(seconds: f32) -> f32 {
  if (params[${P.kpm}u] > 0.0) { return kPulls / firedBy(seconds); }
  return 1.0 / seconds;
}

// What scoreOrder's kill rate needs that does not change during the fight.
var<private> kTotal: f32;
var<private> kCrit0: f32;
var<private> kCritMods: f32;
var<private> kMultishot: f32;
var<private> kFireRate: f32;
var<private> kFireTime: f32;
var<private> kCycle: f32;
var<private> kPulls: f32;
var<private> kStatus: f32;
var<private> kTier: f32;
var<private> kHead: bool;
var<private> kZoneMul: f32;
var<private> kFaction: f32;
var<private> kDuration: f32;
var<private> kSteady: bool;
var<private> kSeed: f32;
var<private> kMagazine: f32;
var<private> kBeamStart: f32;
var<private> kRestart: f32;

// Pulls fired in the first s seconds: a magazine at the fire rate, then the reload (damage.ts pullsBy).
fn firedBy(s: f32) -> f32 {
  if (!(s > 0.0)) { return 0.0; }
  let cycles = floor(s / kCycle);
  return (cycles * kFireTime + min(kFireTime, s - cycles * kCycle)) * kFireRate;
}
// Seconds of sustained fire in the life seconds up to at (damage.ts firedWithin).
fn within(at: f32, life: f32, inf: bool) -> f32 {
  if (inf) { return life; }
  return (firedBy(at) - firedBy(at - life)) / kPulls;
}
fn stacksAt(rate: f32, life: f32, cap: f32, at: f32, inf: bool) -> f32 {
  if (!kSteady) { return 0.0; }
  return min(cap, rate * within(at, life, inf));
}
var<private> extraProc: array<f32, 16>;
fn atLeastTen(mean: f32) -> f32 {
  if (!(mean > 0.0)) { return 0.0; }
  var term = exp(-mean);
  var below = term;
  for (var i = 1u; i < 10u; i++) { term *= mean / f32(i); below += term; }
  return max(0.0, 1.0 - below);
}
var<private> DEB_TYPES: array<u32, ${DEBILITATE.length * 3}> = array<u32, ${DEBILITATE.length * 3}>(${DEBILITATE.flatMap(([c, a, b]) => [c, a, b]).map((v) => `${v}u`).join(', ')});
var<private> DEB_SECONDS: array<f32, ${DEBILITATE.length}> = array<f32, ${DEBILITATE.length}>(${DEBILITATE.map(([, , , sec]) => sec.toFixed(1)).join(', ')});
// Encumber and Primed Debilitate procs per second into extraProc (JS arcaneExtra).
fn arcaneExtra(chance: f32, pCrit: f32) {
  for (var t = 0u; t < 16u; t++) { extraProc[t] = 0.0; }
  let encumber = min(1.0, params[${P.encumber}u]);
  if (encumber > 0.0 && chance > 0.0) {
    let miss = 1.0 - encumber * min(1.0, chance);
    var perPull = 1.0;
    if (miss > 0.0) { perPull = 1.0 - pow(miss, max(1.0, kMultishot)); }
    for (var t = 0u; t < ${ENCUMBER_COUNT}u; t++) { extraProc[t] = kPulls * perPull / ${ENCUMBER_COUNT}.0; }
  }
  let debilitate = min(1.0, params[${P.debilitate}u]);
  if (debilitate > 0.0) {
    for (var j = 0u; j < ${DEBILITATE.length}u; j++) {
      let combined = DEB_TYPES[3u * j];
      let rate = rateAt(combined, chance, pCrit) + extraProc[combined];
      let added = rate * debilitate * atLeastTen(rate * DEB_SECONDS[j] * kDuration) / 2.0;
      extraProc[DEB_TYPES[3u * j + 1u]] += added;
      extraProc[DEB_TYPES[3u * j + 2u]] += added;
    }
  }
}
fn rateAt(t: u32, chance: f32, pCrit: f32) -> f32 {
  return kMultishot * kPulls * (chance * (dmg[t] / kTotal) + S[${CH['forcedCrit:impact']}u + t] * pCrit + S[${CH['forced:impact']}u + t]);
}
fn progress(a: f32, b: f32) -> f32 {
  return (b - a) * killRate((a + b) / 2.0, (firedBy(b) - firedBy(a)) / ((b - a) * kPulls), false, beamShare(a, b, false));
}

// 1 / seconds to kill with the target's state at seconds in (inf: settled), the trigger at firing x
// the sustained pull rate (the JS killRate in scoreOrder).
fn killRate(at: f32, firing: f32, inf: bool, beam: f32) -> f32 {
  let d = kDuration;
  let pCrit0 = min(1.0, kCrit0);
  // Encumber and Debilitate procs before the build-up (JS extra0), then with it (JS extra): one
  // call site in a loop, since the compiler copies a function per call site.
  var puncture = 0.0;
  var coldRate = 0.0;
  var tau = 0.0;
  var chance = kStatus;
  var pCrit = pCrit0;
  for (var round2 = 0u; round2 < 2u; round2++) {
    arcaneExtra(chance, pCrit);
    if (round2 == 1u) { break; }
    puncture = stacksAt(rateAt(${T.puncture}u, kStatus, pCrit0) + extraProc[${T.puncture}u], 10.0 * d, 5.0, at, inf);
    coldRate = rateAt(${T.cold}u, kStatus, pCrit0) + extraProc[${T.cold}u] + params[${P.cryogenic}u] * (rateAt(${T.puncture}u, kStatus, pCrit0) + extraProc[${T.puncture}u]);
    tau = stacksAt(rateAt(${T.tau}u, kStatus, pCrit0), 8.0 * d, 10.0, at, inf);
    chance = kStatus * (1.0 + min(1.0, 0.1 * tau));
    pCrit = min(1.0, kCrit0 + 0.05 * puncture);
  }
  let cold = stacksAt(coldRate, 6.0 * d, 1e30, at, inf);
  let crit = kCrit0 + 0.05 * puncture;
  let critDamage = max(1.0, kCritMods + coldCrit(cold, coldRate, d, true));
  // On Overguard only Cold lands: at most 4 stacks, no freeze, no Puncture (JS killRate).
  let guardCritDamage = max(1.0, kCritMods + coldCrit(stacksAt(coldRate, 6.0 * d, 4.0, at, inf), coldRate, d, false));
  var guardPerTier = guardCritDamage - 1.0;
  if (kHead && params[${P.critHeadshot}u] > 0.0) { guardPerTier = 2.0 * guardCritDamage - 1.0; }
  let guardCrit = 1.0 + (kCrit0 + min(1.0, kCrit0) * kTier) * guardPerTier;
  var perTier = critDamage - 1.0;
  if (kHead && params[${P.critHeadshot}u] > 0.0) { perTier = 2.0 * critDamage - 1.0; }
  let averageCrit = 1.0 + (crit + min(1.0, crit) * kTier) * perTier;
  var critOnCrit = 1.0 + perTier;
  if (pCrit > 0.0) { critOnCrit = (averageCrit - (1.0 - pCrit)) / pCrit; }
  let viral = viralMul(max(params[${P.viralFloor}u], stacksAt(rateAt(${T.viral}u, chance, pCrit) + extraProc[${T.viral}u], 6.0 * d, 10.0, at, inf)));
  let corrosive = max(params[${P.corrosiveFloor}u], stacksAt(rateAt(${T.corrosive}u, chance, pCrit) + extraProc[${T.corrosive}u], 8.0 * d, params[${P.corrosiveCap}u], at, inf));
  var ramp = 0.5;
  if (!inf) {
    ramp = select(0.0, 0.15, at >= 0.5 * d) + select(0.0, 0.15, at >= 1.0 * d) + select(0.0, 0.1, at >= 1.5 * d) + select(0.0, 0.1, at >= 2.0 * d);
  }
  let heat = ramp * (1.0 - exp(-stacksAt(rateAt(${T.heat}u, chance, pCrit) + extraProc[${T.heat}u], 6.0 * d, 1e30, at, inf)));
  let armored = params[${P.armored}u] > 0.0;
  var dr = 0.0;
  if (armored) { dr = armorDr(params[${P.armor}u] * corrMul(corrosive) * (1.0 - heat)); }

  var health = 0.0;
  var shield = 0.0;
  var overguard = 0.0;
  var bypass = 0.0;
  ${repeat('t', Array.from({ length: 16 }, (_, t) => t), `if (dmg[t] > 0.0) {
    let landed = dmg[t] * kZoneMul;
    var minimum = 0.0;
    if (armored) { minimum = 1.0; }
    let toHealth = max(landed * (1.0 + params[${P.healthMod}u + t]) * (1.0 - dr) * viral, minimum);
    health += toHealth;
    let bypasses = t == ${T.toxin}u && params[${P.toxinBypass}u] > 0.0;
    if (params[${P.shield}u] > 0.0 && !bypasses) { shield += landed * (1.0 + params[${P.healthMod}u + t]); }
    if (bypasses) { bypass += toHealth; }
    overguard += landed * (1.0 + params[${P.overguardMod}u + t]) * params[${P.overguardMultiplier}u];
  }`)}
  let perShot = averageCrit * kMultishot * kFaction;

  var dotDps = 0.0;
  var dotShield = 0.0;
  var dotTypes = array<u32, 6>(${DOT.map(([t]) => `${t}u`).join(', ')});
  var dotC = array<f32, 6>(${DOT.map(([, c]) => c.toFixed(2)).join(', ')});
  var dotTicks = array<f32, 6>(${DOT.map(([, , n]) => n.toFixed(1)).join(', ')});
  var dotDelay = array<f32, 6>(${DOT.map(([, , , delay]) => delay.toFixed(2)).join(', ')});
  var dotLength = array<f32, 6>(${DOT.map(([, , , , length]) => length.toFixed(2)).join(', ')});
  ${repeat('e', DOT.map((_, e) => e), `
    let t = dotTypes[e];
    let share = dmg[t] / kTotal;
    let forcedCrit = kMultishot * kPulls * S[${CH['forcedCrit:impact']}u + t] * pCrit;
    let forcedPlain = kMultishot * kPulls * S[${CH['forced:impact']}u + t];
    if (!(!(share > 0.0) && forcedCrit + forcedPlain + extraProc[t] <= 0.0)) {
    let natural = chance * share * kMultishot * kPulls + extraProc[t];
    let weighted = (natural + forcedPlain) * averageCrit + forcedCrit * critOnCrit;
    var elemental = 0.0;
    if (t >= ${T.heat}u && t <= ${T.toxin}u) { elemental = S[4u + t]; }
    var typeBonus = 1.0;
    if (t == ${T.toxin}u) { typeBonus = 1.0 + params[${P.toxinStatusBonus}u]; }
    let scale = dotC[e] * (1.0 + elemental) * (1.0 + S[${CH.statusDamage}u]) * typeBonus * kFaction;
    let merged = t == ${T.heat}u || t == ${T.gas}u;
    var plusOne = 1.0;
    if (merged) { plusOne = 0.0; }
    let rawTick = (kSeed * kFaction + plusOne) * scale;
    var hm = params[${P.healthMod}u + t];
    var tdr = dr;
    if (t == ${T.slash}u) { hm = 0.0; tdr = 0.0; }
    var span = dotLength[e] * d;
    if (t == ${T.blast}u) { span = dotLength[e]; }
    var landedShare = 1.0;
    if (kSteady && !inf) { landedShare = within(at - dotDelay[e], span, false) / span; }
    var ticks = dotTicks[e];
    if (ticks == 0.0) { ticks = max(1.0, floor(6.0 * d + 1e-6)); }
    let procs = natural + forcedPlain + forcedCrit;
    if (t == ${T.heat}u && kSteady && !inf) {
      // A refreshing Heat chain ticks every stack it has once 1 s old (JS killRate).
      let windowed = procs * within(at, span, false);
      var heatStacks = 0.0;
      if (at >= dotDelay[e]) { heatStacks = windowed + (1.0 - exp(-windowed)) * (procs * within(at, at, false) - windowed); }
      landedShare = 0.0;
      if (procs > 0.0) { landedShare = heatStacks / (procs * ticks); }
    }
    let stacked = (natural + forcedPlain + forcedCrit) * 6.0 * d;
    var kept = 1.0;
    if (t == ${T.gas}u && stacked > ${GAS_CAP.toFixed(1)}) { kept = ${GAS_CAP.toFixed(1)} / stacked; }
    var mergedOne = 0.0;
    if (merged) { mergedOne = (1.0 - exp(-stacked)) * scale; }
    let landed = (weighted * rawTick * ticks * kept + mergedOne) * kZoneMul * (1.0 + hm) * landedShare;
    dotDps += landed * (1.0 - tdr) * viral * beam;
    if (params[${P.shield}u] > 0.0 && !(t == ${T.toxin}u && params[${P.toxinBypass}u] > 0.0)) { dotShield += landed * beam; }
  }`)}

  let fired = perShot * kPulls * firing * beam;
  let healthDps = health * fired + dotDps;
  let shieldDps = shield * fired + dotShield;
  let overguardDps = overguard * guardCrit * kMultishot * kFaction * kPulls * firing * beam;
  var seconds = 0.0;
  if (params[${P.overguard}u] > 0.0) {
    if (!(overguardDps > 0.0)) { return 0.0; }
    seconds += params[${P.overguard}u] / overguardDps;
  }
  var remaining = params[${P.health}u];
  if (params[${P.shield}u] > 0.0 && shieldDps > 0.0) {
    let shieldSeconds = params[${P.shield}u] / shieldDps;
    seconds += shieldSeconds;
    remaining = max(0.0, remaining - shieldSeconds * bypass * fired);
  }
  if (remaining > 0.0) {
    if (!(healthDps > 0.0)) { return 0.0; }
    seconds += remaining / healthDps;
  }
  if (seconds > 0.0) { return 1.0 / seconds; }
  return 0.0;
}

// The best score over every order of the distinct elements in mask (at most 4! = 24).
fn bestScore(mask: u32) -> f32 {
  var count = 0u;
  for (var e = 0u; e < 4u; e++) { if ((mask & (1u << e)) != 0u) { count++; } }
  var best = 0.0;
  if (count == 0u) {
    best = scoreOrder(array<u32, 4>(0u, 0u, 0u, 0u), 0u);
  } else {
    var items: array<u32, 4>;
    var n = 0u;
    for (var e = 0u; e < 4u; e++) { if ((mask & (1u << e)) != 0u) { items[n] = e; n++; } }
    for (var p = 0u; p < PERM_COUNT[count]; p++) {
      var order: array<u32, 4>;
      for (var j = 0u; j < count; j++) { order[j] = items[PERMS[(PERM_START[count] + p) * 4u + j]]; }
      best = max(best, scoreOrder(order, count));
    }
  }
  return best;
}

`;
}

/** WGSL for the combination search of one model. */
export function shaderSource(model, unroll = true) {
  const k = model.slots;
  return scoringWgsl(unroll) + /* wgsl */ `
const K: u32 = ${k}u;
struct Batch { top: u32, base: u32, count: u32, threshold: f32 }
struct Hit { score: f32, rank: u32 }
@group(0) @binding(2) var<storage, read> clash: array<u32>;
@group(0) @binding(3) var<storage, read> choose: array<u32>;
@group(0) @binding(4) var<uniform> batch: Batch;
@group(0) @binding(5) var<storage, read_write> counter: atomic<u32>;
@group(0) @binding(6) var<storage, read_write> hits: array<Hit>;
@group(0) @binding(7) var<storage, read> twinOf: array<i32>;

fn binom(n: u32, r: u32) -> u32 { return choose[n * 9u + r]; }

@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) gid: vec3<u32>, @builtin(num_workgroups) groups: vec3<u32>) {
  let idx = gid.x + gid.y * groups.x * 256u;
  if (idx >= batch.count) { return; }
  // Unrank (colex): the top element is fixed per batch, the other K-1 come from [0, top).
  var combo: array<u32, ${Math.max(1, k)}>;
  combo[K - 1u] = batch.top;
  var r = batch.base + idx;
  var c = batch.top;
  for (var i = K - 1u; i >= 1u; i--) {
    c -= 1u;
    while (binom(c, i) > r) { c -= 1u; }
    r -= binom(c, i);
    combo[i - 1u] = c;
  }
  var drain = 0.0;
  var lo = 0u;
  var hi = 0u;
  for (var i = 0u; i < K; i++) {
    let m = combo[i];
    if (m < 32u) {
      if ((lo & clash[2u * m]) != 0u || (hi & clash[2u * m + 1u]) != 0u) { return; }
      lo |= 1u << m;
    } else {
      if ((lo & clash[2u * m]) != 0u || (hi & clash[2u * m + 1u]) != 0u) { return; }
      hi |= 1u << (m - 32u);
    }
    drain += vectors[m * STRIDE + 2u * NC];
  }
  if (drain > params[${P.capacityHalf}u]) { return; }
  // A drawback twin (Heavy Caliber) only next to its clean mod (Serration).
  for (var i = 0u; i < K; i++) {
    let need = twinOf[combo[i]];
    if (need < 0) { continue; }
    let bit = u32(need);
    if (bit < 32u && (lo & (1u << bit)) == 0u) { return; }
    if (bit >= 32u && (hi & (1u << (bit - 32u))) == 0u) { return; }
  }
  for (var c2 = 0u; c2 < NC; c2++) { A[c2] = params[${P.size}u + c2]; B[c2] = params[${P.size}u + NC + c2]; }
  var mask = u32(params[${P.fixedElementMask}u]);
  for (var i = 0u; i < K; i++) {
    let at = combo[i] * STRIDE;
    // Dense on purpose: summing only the non-zero channels (A[channel] at a data-dependent index)
    // measured 1.7x slower on an RTX 3050 Ti.
    for (var c2 = 0u; c2 < NC; c2++) { A[c2] += vectors[at + c2]; B[c2] += vectors[at + NC + c2]; }
    let element = vectors[at + 2u * NC + 1u];
    if (element >= 0.0) { mask |= 1u << u32(element); }
  }
  let best = bestScore(mask);
  if (best > batch.threshold) {
    let slot = atomicAdd(&counter, 1u);
    if (slot < arrayLength(&hits)) { hits[slot] = Hit(best, batch.base + idx); }
  }
}
`;
}

/**
 * WGSL for the riven picker: thread (riven r, slot i) scores the build without its mod i plus the
 * riven's four stat vectors (candidates slots + ... in the model).
 */
export function rivenShaderSource(unroll = true) {
  return scoringWgsl(unroll) + /* wgsl */ `
struct RivenBatch { base: u32, count: u32, slots: u32, pad: u32 }
@group(0) @binding(2) var<storage, read> rivens: array<u32>;
@group(0) @binding(3) var<uniform> rivenBatch: RivenBatch;
@group(0) @binding(4) var<storage, read_write> scores: array<f32>;

@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) gid: vec3<u32>, @builtin(num_workgroups) groups: vec3<u32>) {
  let idx = gid.x + gid.y * groups.x * 256u;
  if (idx >= rivenBatch.count) { return; }
  let job = rivenBatch.base + idx;
  let riven = job / rivenBatch.slots;
  let replaced = job % rivenBatch.slots;
  for (var c2 = 0u; c2 < NC; c2++) { A[c2] = params[${P.size}u + c2]; B[c2] = params[${P.size}u + NC + c2]; }
  var mask = u32(params[${P.fixedElementMask}u]);
  for (var k = 0u; k < rivenBatch.slots + 4u; k++) {
    var m = k;
    if (k == replaced) { continue; }
    if (k >= rivenBatch.slots) { m = rivens[riven * 4u + (k - rivenBatch.slots)]; }
    let at = m * STRIDE;
    for (var c2 = 0u; c2 < NC; c2++) { A[c2] += vectors[at + c2]; B[c2] += vectors[at + NC + c2]; }
    let element = vectors[at + 2u * NC + 1u];
    if (element >= 0.0) { mask |= 1u << u32(element); }
  }
  scores[idx] = bestScore(mask);
}
`;
}

/** Colex unrank of the K-1 lower elements of a batch combination (mirror of the shader). */
function unrank(top, rank, k) {
  const combo = new Array(k);
  combo[k - 1] = top;
  let r = rank;
  let c = top;
  for (let i = k - 1; i >= 1; i--) {
    c -= 1;
    while (binomial(c, i) > r) c -= 1;
    r -= binomial(c, i);
    combo[i - 1] = c;
  }
  return combo;
}

/**
 * The GPU to use, or null. A software fallback adapter (SwiftShader) is refused unless asked for:
 * it runs on the CPU and is slower than the server's own brute force.
 */
const isFallback = (adapter) => Boolean(adapter.isFallbackAdapter || adapter.info?.isFallbackAdapter);

export async function gpuAdapter(allowFallback = false) {
  if (typeof navigator === 'undefined' || !navigator.gpu) return null;
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' }).catch(() => null);
  if (!adapter || (!allowFallback && isFallback(adapter))) return null;
  return adapter;
}

/** A short name for an adapter, for the settings and the result notes. Brave's Shields blank it out. */
export const adapterName = (adapter) => [adapter?.info?.vendor, adapter?.info?.architecture, adapter?.info?.description]
  .filter(Boolean).join(' ') || 'a hardware GPU (the browser hides its name)';

/**
 * Runs the pre-filter on the GPU. Resolves to the best `model.keep` combinations (candidate
 * indices) and a check of the shader against `proxyScore` on the winners.
 */
// The device and the compiled shader are kept between searches with the same shader source:
// compiling and waking the GPU otherwise cost a good part of a short search.
let cached = null;

async function devicePipeline(adapter, code) {
  if (cached?.code === code) return cached;
  cached?.device.destroy();
  cached = null;
  const device = await adapter.requestDevice({
    requiredLimits: { maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize },
  });
  device.lost.then(() => { if (cached?.device === device) cached = null; });
  const module = device.createShaderModule({ code });
  const info = await module.getCompilationInfo();
  const errors = info.messages.filter((message) => message.type === 'error');
  if (errors.length) {
    device.destroy();
    throw new Error(`WebGPU shader: ${errors.map((message) => `${message.lineNum}: ${message.message}`).join('; ')}`);
  }
  const pipeline = await device.createComputePipelineAsync({ layout: 'auto', compute: { module, entryPoint: 'main' } });
  cached = { code, device, pipeline };
  return cached;
}

export async function gpuSearch(model, { onProgress, signal, allowFallback = false } = {}) {
  const adapter = await gpuAdapter(allowFallback);
  if (!adapter) throw new Error('WebGPU: no hardware GPU adapter in this browser');
  const setupStarted = performance.now();
  const { device, pipeline } = await devicePipeline(adapter, shaderSource(model, !isFallback(adapter)));
  const setupMs = performance.now() - setupStarted;
  const buffers = [];
  try {
    const n = model.candidates.length;
    const k = model.slots;
    const keep = model.keep;
    const capacity = Math.max(4 * keep, 1 << 16);
    const track = (buffer) => { buffers.push(buffer); return buffer; };
    const storage = (data, usage = GPUBufferUsage.STORAGE) => {
      const buffer = track(device.createBuffer({ size: Math.max(16, data.byteLength), usage: usage | GPUBufferUsage.COPY_DST }));
      device.queue.writeBuffer(buffer, 0, data);
      return buffer;
    };
    const choose = new Uint32Array(65 * 9);
    for (let a = 0; a <= 64; a++) for (let b = 0; b <= 8; b++) choose[a * 9 + b] = Math.min(binomial(a, b), 0xffffffff);
    const params = storage(new Float32Array(model.params));
    const vectors = storage(new Float32Array(model.vectors));
    const clash = storage(new Uint32Array(model.clash));
    const chooseBuffer = storage(choose);
    const requiresBuffer = storage(new Int32Array(model.requires ?? new Array(n).fill(-1)));
    const uniform = track(device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST }));
    const counter = track(device.createBuffer({ size: 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST }));
    const hits = track(device.createBuffer({ size: capacity * 8, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC }));
    const readCounter = track(device.createBuffer({ size: 4, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST }));
    const readHits = track(device.createBuffer({ size: capacity * 8, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST }));
    const group = device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [params, vectors, clash, chooseBuffer, uniform, counter, hits, requiresBuffer].map((buffer, binding) => ({ binding, resource: { buffer } })),
    });

    const top = new TopList(keep);
    const total = binomial(n, k);
    let done = 0;
    const timing = { dispatches: 0, waitMs: 0, setupMs };
    // Batches: one top element at a time (its lower elements count C(top, k-1), always < 2^32),
    // split into dispatches of 4M threads: short enough for the driver watchdog on a slow GPU.
    const perDispatch = 1 << 22;
    const run = async (topIndex, base, count, threshold) => {
      device.queue.writeBuffer(uniform, 0, new Uint32Array([topIndex, base, count, 0]));
      device.queue.writeBuffer(uniform, 12, new Float32Array([threshold]));
      device.queue.writeBuffer(counter, 0, new Uint32Array([0]));
      const groups = Math.ceil(count / 256);
      const encoder = device.createCommandEncoder();
      const pass = encoder.beginComputePass();
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, group);
      pass.dispatchWorkgroups(Math.min(groups, 65535), Math.ceil(groups / 65535));
      pass.end();
      encoder.copyBufferToBuffer(counter, 0, readCounter, 0, 4);
      encoder.copyBufferToBuffer(hits, 0, readHits, 0, capacity * 8);
      device.queue.submit([encoder.finish()]);
      const waited = performance.now();
      await readCounter.mapAsync(GPUMapMode.READ);
      timing.waitMs += performance.now() - waited;
      timing.dispatches++;
      const found = new Uint32Array(readCounter.getMappedRange().slice(0))[0];
      readCounter.unmap();
      await readHits.mapAsync(GPUMapMode.READ, 0, Math.min(found, capacity) * 8 || 8);
      const raw = readHits.getMappedRange(0, Math.min(found, capacity) * 8 || 8).slice(0);
      readHits.unmap();
      const scores = new Float32Array(raw);
      const ranks = new Uint32Array(raw);
      const entries = [];
      for (let i = 0; i < Math.min(found, capacity); i++) entries.push([scores[2 * i], ranks[2 * i + 1]]);
      return { found, entries };
    };
    for (let topIndex = k - 1; topIndex < n; topIndex++) {
      const count = binomial(topIndex, k - 1);
      for (let base = 0; base < count; base += perDispatch) {
        signal?.throwIfAborted();
        const size = Math.min(perDispatch, count - base);
        let threshold = top.threshold;
        let result = await run(topIndex, base, size, threshold);
        // More hits than the buffer holds: the K-th best of the ones we got is a safe higher bar
        // (it cannot exceed the true K-th best), so rerun with it until everything fits.
        while (result.found > capacity) {
          const sorted = result.entries.map(([score]) => score).sort((a, b) => b - a);
          const raised = sorted[Math.min(keep, sorted.length) - 1];
          threshold = raised > threshold ? raised : Math.max(threshold * 1.0001, threshold + 1e-30);
          result = await run(topIndex, base, size, threshold);
        }
        for (const [score, rank] of result.entries) top.add(score, unrank(topIndex, rank, k));
        done += size;
        onProgress?.(done, total);
      }
    }
    const winners = top.result();
    // The shader and proxyScore must agree; a drift between the two copies shows up here.
    const drift = winners.slice(0, 50).reduce((worst, { score, combo }) => {
      const expected = proxyScore(model, combo);
      return Math.max(worst, Math.abs(score - expected) / Math.max(1e-12, expected));
    }, 0);
    return { winners, drift, adapter: adapterName(adapter), timing };
  } finally {
    for (const buffer of buffers) buffer.destroy();
  }
}

/**
 * The riven picker on the GPU: every riven against every replaceable mod (thread = riven x slot),
 * scored with the reduced model. Returns, per riven, its best score and the slot it replaces.
 */
export async function gpuRivenSearch(model, { onProgress, signal, allowFallback = false } = {}) {
  const adapter = await gpuAdapter(allowFallback);
  if (!adapter) throw new Error('WebGPU: no hardware GPU adapter in this browser');
  const started = performance.now();
  const { device, pipeline } = await devicePipeline(adapter, rivenShaderSource(!isFallback(adapter)));
  const buffers = [];
  try {
    const slots = model.slots;
    const rivens = model.rivenIndex.length / 4;
    const total = rivens * slots;
    const perDispatch = 1 << 22;
    const storage = (data) => {
      const buffer = device.createBuffer({ size: Math.max(16, data.byteLength), usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
      device.queue.writeBuffer(buffer, 0, data);
      buffers.push(buffer);
      return buffer;
    };
    const params = storage(new Float32Array(model.params));
    const vectors = storage(new Float32Array(model.vectors));
    const indices = storage(new Uint32Array(model.rivenIndex));
    const uniform = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const scores = device.createBuffer({ size: perDispatch * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
    const readback = device.createBuffer({ size: perDispatch * 4, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    buffers.push(uniform, scores, readback);
    const group = device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [params, vectors, indices, uniform, scores].map((buffer, binding) => ({ binding, resource: { buffer } })),
    });
    const bestScore = new Float32Array(rivens).fill(-1);
    const bestSlot = new Uint8Array(rivens);
    for (let base = 0; base < total; base += perDispatch) {
      signal?.throwIfAborted();
      const count = Math.min(perDispatch, total - base);
      device.queue.writeBuffer(uniform, 0, new Uint32Array([base, count, slots, 0]));
      const groups = Math.ceil(count / 256);
      const encoder = device.createCommandEncoder();
      const pass = encoder.beginComputePass();
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, group);
      pass.dispatchWorkgroups(Math.min(groups, 65535), Math.ceil(groups / 65535));
      pass.end();
      encoder.copyBufferToBuffer(scores, 0, readback, 0, count * 4);
      device.queue.submit([encoder.finish()]);
      await readback.mapAsync(GPUMapMode.READ, 0, count * 4);
      const values = new Float32Array(readback.getMappedRange(0, count * 4).slice(0));
      readback.unmap();
      for (let k = 0; k < count; k++) {
        const job = base + k;
        const riven = Math.floor(job / slots);
        if (values[k] > bestScore[riven]) { bestScore[riven] = values[k]; bestSlot[riven] = job % slots; }
      }
      onProgress?.(Math.min(total, base + count), total);
    }
    // The shader and proxyScore must agree (same check as the build search).
    let drift = 0;
    for (let riven = 0; riven < Math.min(rivens, 40); riven++) {
      const slot = bestSlot[riven];
      const combo = [...Array.from({ length: slots }, (_, i) => i).filter((i) => i !== slot), ...model.rivenIndex.slice(riven * 4, riven * 4 + 4)];
      const expected = proxyScore({ ...model, requires: undefined }, combo);
      drift = Math.max(drift, Math.abs(bestScore[riven] - expected) / Math.max(1e-12, expected));
    }
    return { bestScore, bestSlot, drift, adapter: adapterName(adapter), elapsedMs: performance.now() - started };
  } finally {
    for (const buffer of buffers) buffer.destroy();
  }
}
