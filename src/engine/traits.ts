/**
 * Weapon traits: what a weapon does beyond its stats (wiki: each weapon's Characteristics).
 *
 * Every weapon page was read (data/raw/weapon-pages, 2026-10-28); what is here is what changes
 * damage, written in the engine's effect language so stack modes, conditions and ranks apply:
 *
 *   - Signature bonuses: only with that Warframe (`build.frame`).
 *   - Triggered buffs: on weak-point hit/kill, on kill, after a heavy attack... gated like any
 *     conditional effect ("max" stacks assume them; weak-point ones need head hits).
 *   - Innate bonuses: headshot damage, weak-point crit chance, physical damage.
 *   - "Next shot" effects (Sagek Prime, Gotva Prime): the expected share of shots they set.
 *   - Spool-up: the shots lost at the start of every magazine (fire rate starts low).
 *   - Combo exceptions (Venka Prime, Dex Nikana).
 *
 * Guaranteed procs come from the wiki's data per attack (snapshot.forcedProcs), Ammo
 * Efficiency traits from ammo.ts.
 *
 * Not modelled, by choice: utility (pinning corpses, stagger, movement speed, projectile speed,
 * ammo maximum), alt-fire charge mechanics (Battacor, Javlok, Tenet Tetra, Cyanex), field and orb
 * mechanics (Mandonel, Simulor, Mutalist Quanta), reload mini-games (Sirocco, Reconifex), random
 * buffs (Amanata), Vadarya Prime's lightning (no damage value), block charges (Cobra Crane,
 * Silva & Aegis, Sigma & Octantis, Ack & Brunt) and the Kohm family's pellet and ammo spool.
 */
import type { Effect, WeaponData } from '../types.ts';

export interface TraitContext {
  frame?: string;
}

const add = (target: string, value: number, raw: string, extra: Partial<Effect> = {}): Effect => ({ target, op: 'add', value, raw, ...extra });
const flat = (target: string, value: number, raw: string, extra: Partial<Effect> = {}): Effect => ({ target, op: 'flat', value, raw, ...extra });
const mult = (target: string, value: number, raw: string, extra: Partial<Effect> = {}): Effect => ({ target, op: 'mult', value, raw, ...extra });
const physical = (value: number, raw: string): Effect[] => (['impact', 'puncture', 'slash'] as const).map((element) => add('element', value, raw, { element }));
/** Signature bonus: only in the hands of `frames` (their Prime counts too). */
const signature = (frames: string, effects: Effect[]) => (context: TraitContext): Effect[] =>
  (new RegExp(`^(${frames})( Prime)?$`, 'i').test(context.frame ?? '') ? effects : []);
const always = (effects: Effect[]) => (): Effect[] => effects;
const both = (...parts: Array<(context: TraitContext) => Effect[]>) => (context: TraitContext): Effect[] => parts.flatMap((part) => part(context));
/** The same traits on several variants. */
const variants = (names: string[], trait: (context: TraitContext) => Effect[]) => Object.fromEntries(names.map((name) => [name, trait]));

const knell = always([
  // Death Knell: +0.5x final critical multiplier and +20% final status chance per stack, 3 stacks.
  flat('critDamage', 0.5, 'Death Knell (weak point hit): +0.5x final Critical Multiplier, up to 3x', { condition: 'onWeakPointHit', maxStacks: 3 }),
  flat('statusChance', 0.2, 'Death Knell (weak point hit): +20% final Status Chance, up to 3x', { condition: 'onWeakPointHit', maxStacks: 3 }),
]);
const sprintReload = (value: number) => (context: TraitContext): Effect[] => {
  const gauss = /^Gauss( Prime)?$/i.test(context.frame ?? '');
  const amount = gauss ? 2 * value : value;
  return [add('reloadSpeed', amount, `Reloading while sprinting: +${amount * 100}% Reload Speed${gauss ? ' (Gauss)' : ''}`, { condition: 'sprinting' })];
};

const TRAITS: Record<string, (context: TraitContext) => Effect[]> = {
  // ---- signature bonuses
  ...variants(['Alternox', 'Alternox Prime'], signature('Gyre', [add('multishot', 0.2, 'Signature (Gyre): +20% Multishot')])),
  ...variants(['Epitaph', 'Epitaph Prime'], signature('Sevagoth', [add('headshotMultiplier', 0.2, 'Signature (Sevagoth): +20% headshot damage')])),
  ...variants(['Tekko', 'Tekko Prime'], signature('Atlas', [add('statusChance', 0.06, 'Signature (Atlas): +6% base Status Chance', { base: true })])),
  ...variants(['Phantasma', 'Phantasma Prime'], signature('Revenant', [add('magazine', 4, 'Signature (Revenant): +4 Magazine', { base: true })])),
  ...variants(['Acceltra', 'Acceltra Prime'], sprintReload(0.25)),
  ...variants(['Akarius', 'Akarius Prime'], sprintReload(0.5)),
  ...variants(['Knell', 'Knell Prime'], both(knell, signature('Harrow', [add('magazine', 1, 'Signature (Harrow): +1 Magazine', { base: true })]))),
  // ---- triggered buffs
  'Arca Scisco': always([
    flat('critChance', 0.04, 'Target Analysis (on hit): +4% Critical Chance after mods, up to 5x', { condition: 'onHit', maxStacks: 5 }),
    flat('statusChance', 0.04, 'Target Analysis (on hit): +4% Status Chance after mods, up to 5x', { condition: 'onHit', maxStacks: 5 }),
  ]),
  Buzlok: always([flat('critChance', 0.5, 'Tracer on the target: +50% Critical Chance after mods', { condition: 'tracerTagged' })]),
  'Dual Toxocyst': always([
    // Frenzy: multiplicative fire rate, Toxin added like an elemental mod (wiki).
    mult('fireRateMult', 1.5, 'Frenzy (headshot): x2.5 Fire Rate', { condition: 'onWeakPointHit' }),
    add('element', 1, 'Frenzy (headshot): +100% Toxin', { condition: 'onWeakPointHit', element: 'toxin' }),
  ]),
  ...variants(['Athodai', 'Athodai Prime'], always([add('fireRate', 1, 'Overdrive (weak point kill): +100% Fire Rate', { condition: 'onWeakPointKill' })])),
  'Tenet Spirex': always([add('reloadSpeed', 0.25, 'Bullseye Reload (headshot): +25% Reload Speed, up to 2x', { condition: 'onWeakPointHit', maxStacks: 2 })]),
  ...variants(['Nagantaka', 'Nagantaka Prime'], always([add('reloadSpeed', 0.5, 'Headshot kill: +50% Reload Speed', { condition: 'onWeakPointKill' })])),
  Evensong: always([add('multishot', 0.35, 'Evensong Devotion (on kill): +35% Multishot', { condition: 'onKill' })]),
  'Pyrana Prime': always([
    mult('fireRateMult', 0.4, 'Second Pyrana (3 quick kills): x1.4 Fire Rate', { condition: 'pyranaTwin' }),
    add('magazine', 1, 'Second Pyrana (3 quick kills): x2 Magazine', { condition: 'pyranaTwin' }),
  ]),
  'Coda Bassocyst': always([
    add('baseDamage', 1, 'Mercy kill: +100% Damage', { condition: 'onMercyKill' }),
    add('multishot', 1, 'Mercy kill: +100% Multishot', { condition: 'onMercyKill' }),
  ]),
  'Vesper 77': always([add('critDamage', 0.4, 'Aiming: +40% Critical Damage', { condition: 'aiming' })]),
  'Ax-52': always([add('weakPointCritChance', 4, 'Aiming: +400% Critical Chance on headshots', { condition: 'aiming' })]),
  // ---- innate bonuses
  'Cernos Prime': always([mult('headshotMultiplierMult', 0.5, '+50% headshot damage, multiplicative with other headshot bonuses')]),
  'Kuva Chakkhurr': always([add('headshotMultiplier', 0.5, '+50% headshot damage on direct hits')]),
  ...variants(['Synapse', 'Coda Synapse'], always([add('headshotMultiplier', 0.2, '+20% headshot damage')])),
  'Daikyu Prime': always([add('weakPointCritChance', 2.5, '+250% Critical Chance on weak point hits')]),
  Stropha: always([add('weakPointOverride', 1, 'No bonus damage on headshots (x1)')]),
  ...variants(['Sarpa', 'Vastilok'], always(physical(0.25, '+25% to each physical damage type'))),
  // ---- per status type on the target (the Condition Overload family; overload.ts decides Adding)
  ...variants(['Cedo', 'Cedo Prime'], always([add('baseDamage', 0.6, '+60% damage per status type on the target', { perStatusType: true })])),
  'Galariak Prime': always([flat('critChance', 0.1, '+10% Critical Chance per status type on the target', { perStatusType: true })]),
  // ---- melee
  'Ekhein': always([
    add('baseDamage', 0.8, 'Heavy Insight (after a heavy attack): +80% Damage', { condition: 'afterHeavyAttack' }),
    add('fireRate', 0.2, 'Heavy Insight (after a heavy attack): +20% Attack Speed', { condition: 'afterHeavyAttack' }),
  ]),
  Sibear: always([flat('statusChance', 0.5, 'After a heavy attack: +50% Status Chance after mods', { condition: 'afterHeavyAttack' })]),
  Pride: always([add('statusChance', 0.15, 'Coronal Ejection (slam): +15% Status Chance per enemy hit, up to 10x', { condition: 'afterSlam', maxStacks: 10 })]),
  Wrath: always([add('critChance', 0.15, 'Gravitic Slash (slam): +15% Critical Chance per enemy hit, up to 10x', { condition: 'afterSlam', maxStacks: 10 })]),
  Lesion: always([flat('statusChance', 0.25, 'Frenzy (on status): +25% Status Chance after mods', { condition: 'on_status_effect' })]),
  'Dual Viciss': always([add('fireRate', 0.07, 'On Gas status: +7% Attack Speed, up to 5x', { condition: 'on_gas_status_effect', maxStacks: 5 })]),
  Tonkkatt: always([add('element', 0.04, 'Combo increase: +4% Heat, up to 30x', { condition: 'onComboIncrease', maxStacks: 30, element: 'heat' })]),
  Pennant: always([add('fireRate', 0.5, 'Heavy attack kill: +50% Attack Speed', { condition: 'afterHeavyAttack' })]),
  Dorrclave: always([flat('statusChance', 1, 'Rising Vendetta (10 kills): +100% Status Chance after mods', { condition: 'risingVendetta' })]),
};

export function weaponTraitEffects(weapon: WeaponData, context: TraitContext): Effect[] {
  return TRAITS[weapon.name]?.(context) ?? [];
}

/**
 * "Next shot" traits: a share of shots gets a set crit or status chance. Sagek Prime: a crit has
 * 6% to set the next shot's status chance to 500%; Gotva Prime: a status effect has 15% to set the
 * next hit's crit chance to 300% (wiki). Damage is linear in both, so the average works.
 */
export const NEXT_SHOT: Record<string, { trigger: 'crit' | 'status'; chance: number; sets: 'statusChance' | 'critChance'; value: number }> = {
  'Sagek Prime': { trigger: 'crit', chance: 0.06, sets: 'statusChance', value: 5 },
  'Gotva Prime': { trigger: 'status', chance: 0.15, sets: 'critChance', value: 3 },
};

/**
 * Spool-up (wiki): fire rate starts at `start` of the listed value and rises by `step` per shot.
 * The extra seconds a magazine takes for it, against firing it all at full rate.
 */
const SPOOL: Record<string, { start: number; step: number }> = {
  Soma: { start: 0.25, step: 0.15 }, 'Soma Prime': { start: 0.25, step: 0.3 }, Aksomati: { start: 0.25, step: 0.15 }, 'Aksomati Prime': { start: 0.25, step: 0.15 },
  Gorgon: { start: 0.2, step: 0.10667 }, 'Gorgon Wraith': { start: 0.2, step: 0.16 }, 'Prisma Gorgon': { start: 0.2, step: 0.1333 },
  Grattler: { start: 0.4, step: 0.2 }, 'Kuva Grattler': { start: 0.4, step: 0.2 }, 'Imperator Vandal': { start: 0.5333, step: 0.0311 },
  'Kuva Kohm': { start: 0.2, step: 0.2 }, Kohmak: { start: 0.2, step: 0.32 }, 'Twin Kohmak': { start: 0.2, step: 0.08 },
  Phaedra: { start: 0.5, step: 0.05 }, Supra: { start: 0.1, step: 0.225 }, 'Supra Vandal': { start: 0.4, step: 0.2 },
  Tenora: { start: 0.4, step: 0.075 }, 'Tenora Prime': { start: 0.4, step: 0.075 },
  Cestra: { start: 0.6, step: 0.08 }, 'Secura Dual Cestra': { start: 0.6, step: 0.08 }, 'Dual Cestra': { start: 0.6, step: 0.08 },
  'Coda Bubonico': { start: 0.3, step: 0.1167 },
};
export function spoolSeconds(weaponName: string, magazine: number, fireRate: number): number {
  const spool = SPOOL[weaponName];
  if (!spool || !(fireRate > 0)) return 0;
  let extra = 0;
  for (let shot = 0; shot < magazine; shot++) {
    const rate = Math.min(1, spool.start + spool.step * shot);
    if (rate >= 1) break;
    extra += (1 / rate - 1) / fireRate;
  }
  return extra;
}

/** Melee combo rules that differ (wiki): hits per step and the highest multiplier. */
export const COMBO: Record<string, { hitsPerStep: number; max: number }> = {
  'Venka Prime': { hitsPerStep: 20, max: 13 },
  'Dex Nikana': { hitsPerStep: 11, max: 11 },
};
