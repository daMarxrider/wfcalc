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
 * Left out of the model (the exact pass still has them): quantization, attenuation caps, Primed
 * Debilitate, proc damage, conversions, the shot-by-shot simulation.
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

/** Offsets into `params`. */
export const P = (() => {
  const layout = {};
  let at = 0;
  const field = (name, size = 1) => { layout[name] = at; at += size; };
  field('stats', 16); field('critChance'); field('critMultiplier'); field('statusChance'); field('multishot');
  field('fireRate'); field('reloadTime'); field('magazineSize'); field('comboFactor');
  field('healthMod', 16); field('overguardMod', 16);
  field('armor'); field('armored'); field('health'); field('shield'); field('overguard'); field('toxinBypass');
  field('head'); field('weakPointBase'); field('critHeadshot'); field('weakPointOverride');
  field('viralFloor'); field('corrosiveFloor'); field('corrosiveCap'); field('toxinStatusBonus'); field('overguardMultiplier');
  field('fixedStatusTypes'); field('extraStatusTypes'); field('requireMask'); field('fixedElementMask');
  field('vigilante', 8); field('gladiator', 8); field('capacityHalf'); field('steady');
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
const DOT = [[T.slash, 0.35, 6], [T.heat, 0.5, 6], [T.toxin, 0.5, 6], [T.electricity, 0.5, 6], [T.gas, 0.5, 6], [T.blast, 0.5, 1]];

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

function scoreOrder(params, A, B, order) {
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
  const critDamage = Math.max(1, params[P.critMultiplier] * (1 + S[CH.critDamage]) + S[CH.critDamageFlat]);
  const multishot = params[P.multishot] * (1 + S[CH.multishot]);
  const fireRate = S[CH.fireRateLock] > 0 ? params[P.fireRate] : params[P.fireRate] * (1 + S[CH.fireRate]);
  const reload = params[P.reloadTime] / (1 + S[CH.reloadSpeed]);
  const magazine = Math.max(1, Math.round(params[P.magazineSize] * (1 + S[CH.magazine])));
  const status = params[P.statusChance] * (1 + S[CH.statusChance]) + S[CH.statusChanceFlat];
  const tier = pieces(P.vigilante, S[CH.vigilante]);
  const head = params[P.head] > 0;
  const location = head
    ? ((params[P.weakPointOverride] || params[P.weakPointBase]) + 1.5 * S[CH.weakPointDamage]) * (1 + S[CH.headshotMultiplier])
    : Math.max(0, 1 + S[CH.bodyshotMultiplier]);
  const crit = Math.max(0, critBase + (head ? params[P.critChance] * S[CH.weakPointCritChance] : 0));
  const perTier = head && params[P.critHeadshot] > 0 ? 2 * critDamage - 1 : critDamage - 1;
  const averageCrit = 1 + (crit + Math.min(1, crit) * tier) * perTier;
  const pCrit = Math.min(1, crit);
  const critOnCrit = pCrit > 0 ? (averageCrit - (1 - pCrit)) / pCrit : 1 + perTier;
  const faction = 1 + S[CH.faction];

  // Steady-state Viral, Corrosive and Heat from the build's own proc rate (damage.ts steadyStatusDebuffs).
  const cycle = magazine / Math.max(0.01, fireRate) + reload;
  const pulls = magazine / cycle;
  const pellets = multishot * pulls;
  const duration = 1 + Math.max(-0.9, S[CH.statusDuration]);
  const forcedOf = (t) => S[CH['forcedCrit:impact'] + t] * Math.min(1, critBase) + S[CH['forced:impact'] + t];
  // Without the status build-up (simulate off) only the player's own stacks count.
  const steady = params[P.steady] > 0 ? 1 : 0;
  const rate = (t) => steady * pellets * (status * (damage[t] / total) + forcedOf(t));
  const viral = viralMultiplier(Math.max(params[P.viralFloor], Math.min(10, rate(T.viral) * 6 * duration)));
  const corrosive = Math.max(params[P.corrosiveFloor], Math.min(params[P.corrosiveCap], rate(T.corrosive) * 8 * duration));
  const heat = 0.5 * (1 - Math.exp(-rate(T.heat) * 6 * duration));
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

  // Status DoT (dot.ts computeDot).
  const seed = (baseTotal + S[CH.baseDamageFlat]) * db * finalFactor;
  let dotDps = 0;
  for (const [t, coefficient, ticks] of DOT) {
    const share = damage[t] / total;
    const forcedCrit = multishot * fireRate * S[CH['forcedCrit:impact'] + t] * pCrit;
    const forcedPlain = multishot * fireRate * S[CH['forced:impact'] + t];
    if (!(share > 0) && forcedCrit + forcedPlain <= 0) continue;
    const natural = status * share * multishot * fireRate;
    const weighted = (natural + forcedPlain) * averageCrit + forcedCrit * critOnCrit;
    const elemental = t >= T.heat && t <= T.toxin ? S[4 + t] : 0;
    const typeBonus = t === T.toxin ? 1 + params[P.toxinStatusBonus] : 1;
    const raw = (seed * faction + 1) * coefficient * (1 + elemental) * (1 + S[CH.statusDamage]) * typeBonus * faction;
    const trueDamage = t === T.slash;
    const tick = raw * location * (1 + (trueDamage ? 0 : params[P.healthMod + t])) * (1 - (trueDamage ? 0 : dr)) * viral;
    dotDps += weighted * tick * ticks;
  }

  // Sequential kill: Overguard, then shields (Toxin chewing health meanwhile), then health.
  const healthDps = health * perShot * pulls + dotDps;
  const shieldDps = shield * perShot * pulls;
  const overguardDps = overguard * perShot * pulls;
  let seconds = 0;
  if (params[P.overguard] > 0) {
    if (!(overguardDps > 0)) return 0;
    seconds += params[P.overguard] / overguardDps;
  }
  let remaining = params[P.health];
  if (params[P.shield] > 0 && shieldDps > 0) {
    const shieldSeconds = params[P.shield] / shieldDps;
    seconds += shieldSeconds;
    remaining = Math.max(0, remaining - shieldSeconds * bypass * perShot * pulls);
  }
  if (remaining > 0) {
    if (!(healthDps > 0)) return 0;
    seconds += remaining / healthDps;
  }
  return seconds > 0 ? 1 / seconds : 0;
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

/** The damage model in WGSL, shared by both searches; layout constants baked in. */
function scoringWgsl() {
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

fn scoreOrder(order: array<u32, 4>, len: u32) -> f32 {
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
  let critDamage = max(1.0, params[${P.critMultiplier}u] * (1.0 + S[${CH.critDamage}u]) + S[${CH.critDamageFlat}u]);
  let multishot = params[${P.multishot}u] * (1.0 + S[${CH.multishot}u]);
  var fireRate = params[${P.fireRate}u] * (1.0 + S[${CH.fireRate}u]);
  if (S[${CH.fireRateLock}u] > 0.0) { fireRate = params[${P.fireRate}u]; }
  let reload = params[${P.reloadTime}u] / (1.0 + S[${CH.reloadSpeed}u]);
  let magazine = max(1.0, round(params[${P.magazineSize}u] * (1.0 + S[${CH.magazine}u])));
  let status = params[${P.statusChance}u] * (1.0 + S[${CH.statusChance}u]) + S[${CH.statusChanceFlat}u];
  let tier = pieces(${P.vigilante}u, S[${CH.vigilante}u]);
  let head = params[${P.head}u] > 0.0;
  var zoneMul = max(0.0, 1.0 + S[${CH.bodyshotMultiplier}u]);
  var crit = max(0.0, critBase);
  var perTier = critDamage - 1.0;
  if (head) {
    var wp = params[${P.weakPointOverride}u];
    if (wp == 0.0) { wp = params[${P.weakPointBase}u]; }
    zoneMul = (wp + 1.5 * S[${CH.weakPointDamage}u]) * (1.0 + S[${CH.headshotMultiplier}u]);
    crit = max(0.0, critBase + params[${P.critChance}u] * S[${CH.weakPointCritChance}u]);
    if (params[${P.critHeadshot}u] > 0.0) { perTier = 2.0 * critDamage - 1.0; }
  }
  let averageCrit = 1.0 + (crit + min(1.0, crit) * tier) * perTier;
  let pCrit = min(1.0, crit);
  var critOnCrit = 1.0 + perTier;
  if (pCrit > 0.0) { critOnCrit = (averageCrit - (1.0 - pCrit)) / pCrit; }
  let faction = 1.0 + S[${CH.faction}u];

  let cycle = magazine / max(0.01, fireRate) + reload;
  let pulls = magazine / cycle;
  let pellets = multishot * pulls;
  let duration = 1.0 + max(-0.9, S[${CH.statusDuration}u]);
  let critCap = min(1.0, critBase);
  let steady = select(0.0, 1.0, params[${P.steady}u] > 0.0);
  let rViral = steady * pellets * (status * (dmg[${T.viral}u] / total) + S[${CH['forcedCrit:impact']}u + ${T.viral}u] * critCap + S[${CH['forced:impact']}u + ${T.viral}u]);
  let rCorr = steady * pellets * (status * (dmg[${T.corrosive}u] / total) + S[${CH['forcedCrit:impact']}u + ${T.corrosive}u] * critCap + S[${CH['forced:impact']}u + ${T.corrosive}u]);
  let rHeat = steady * pellets * (status * (dmg[${T.heat}u] / total) + S[${CH['forcedCrit:impact']}u + ${T.heat}u] * critCap + S[${CH['forced:impact']}u + ${T.heat}u]);
  let viral = viralMul(max(params[${P.viralFloor}u], min(10.0, rViral * 6.0 * duration)));
  let corrosive = max(params[${P.corrosiveFloor}u], min(params[${P.corrosiveCap}u], rCorr * 8.0 * duration));
  let heat = 0.5 * (1.0 - exp(-rHeat * 6.0 * duration));
  let armored = params[${P.armored}u] > 0.0;
  var dr = 0.0;
  if (armored) { dr = armorDr(params[${P.armor}u] * corrMul(corrosive) * (1.0 - heat)); }

  var health = 0.0;
  var shield = 0.0;
  var overguard = 0.0;
  var bypass = 0.0;
  for (var t = 0u; t < 16u; t++) {
    if (!(dmg[t] > 0.0)) { continue; }
    let landed = dmg[t] * zoneMul;
    var minimum = 0.0;
    if (armored) { minimum = 1.0; }
    let toHealth = max(landed * (1.0 + params[${P.healthMod}u + t]) * (1.0 - dr) * viral, minimum);
    health += toHealth;
    let bypasses = t == ${T.toxin}u && params[${P.toxinBypass}u] > 0.0;
    if (params[${P.shield}u] > 0.0 && !bypasses) { shield += landed * (1.0 + params[${P.healthMod}u + t]); }
    if (bypasses) { bypass += toHealth; }
    overguard += landed * (1.0 + params[${P.overguardMod}u + t]) * params[${P.overguardMultiplier}u];
  }
  let perShot = averageCrit * multishot * faction;

  let seed = (baseTotal + S[${CH.baseDamageFlat}u]) * db * finalFactor;
  var dotDps = 0.0;
  var dotTypes = array<u32, 6>(${DOT.map(([t]) => `${t}u`).join(', ')});
  var dotC = array<f32, 6>(${DOT.map(([, c]) => c.toFixed(2)).join(', ')});
  var dotTicks = array<f32, 6>(${DOT.map(([, , n]) => n.toFixed(1)).join(', ')});
  for (var d = 0u; d < 6u; d++) {
    let t = dotTypes[d];
    let share = dmg[t] / total;
    let forcedCrit = multishot * fireRate * S[${CH['forcedCrit:impact']}u + t] * pCrit;
    let forcedPlain = multishot * fireRate * S[${CH['forced:impact']}u + t];
    if (!(share > 0.0) && forcedCrit + forcedPlain <= 0.0) { continue; }
    let natural = status * share * multishot * fireRate;
    let weighted = (natural + forcedPlain) * averageCrit + forcedCrit * critOnCrit;
    var elemental = 0.0;
    if (t >= ${T.heat}u && t <= ${T.toxin}u) { elemental = S[4u + t]; }
    var typeBonus = 1.0;
    if (t == ${T.toxin}u) { typeBonus = 1.0 + params[${P.toxinStatusBonus}u]; }
    let rawTick = (seed * faction + 1.0) * dotC[d] * (1.0 + elemental) * (1.0 + S[${CH.statusDamage}u]) * typeBonus * faction;
    var hm = params[${P.healthMod}u + t];
    var tdr = dr;
    if (t == ${T.slash}u) { hm = 0.0; tdr = 0.0; }
    dotDps += weighted * rawTick * zoneMul * (1.0 + hm) * (1.0 - tdr) * viral * dotTicks[d];
  }

  let healthDps = health * perShot * pulls + dotDps;
  let shieldDps = shield * perShot * pulls;
  let overguardDps = overguard * perShot * pulls;
  var seconds = 0.0;
  if (params[${P.overguard}u] > 0.0) {
    if (!(overguardDps > 0.0)) { return 0.0; }
    seconds += params[${P.overguard}u] / overguardDps;
  }
  var remaining = params[${P.health}u];
  if (params[${P.shield}u] > 0.0 && shieldDps > 0.0) {
    let shieldSeconds = params[${P.shield}u] / shieldDps;
    seconds += shieldSeconds;
    remaining = max(0.0, remaining - shieldSeconds * bypass * perShot * pulls);
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
export function shaderSource(model) {
  const k = model.slots;
  return scoringWgsl() + /* wgsl */ `
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
export function rivenShaderSource() {
  return scoringWgsl() + /* wgsl */ `
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
export async function gpuAdapter(allowFallback = false) {
  if (typeof navigator === 'undefined' || !navigator.gpu) return null;
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' }).catch(() => null);
  if (!adapter || (!allowFallback && (adapter.isFallbackAdapter || adapter.info?.isFallbackAdapter))) return null;
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
  const { device, pipeline } = await devicePipeline(adapter, shaderSource(model));
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
  const { device, pipeline } = await devicePipeline(adapter, rivenShaderSource());
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
