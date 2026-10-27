#!/usr/bin/env node
/**
 * wfcalc CLI.
 *
 *   wfcalc weapons [query]                 list / search weapons
 *   wfcalc mods <weapon> [query]           mods that fit a weapon
 *   wfcalc enemies [query]                 list / search enemies
 *   wfcalc calc <weapon> [options]         damage report
 *   wfcalc compare <weapon> --vs a,b,c     compare mod setups or elemental choices
 *
 * Options for calc/compare:
 *   --mod Serration,R1          equip a mod (R<rank> to under-level it), repeatable
 *   --enemy Bombard --level 150 enemy and level (defaults: first enemy, level 100)
 *   --faction grineer           shorthand: picks a Grineer benchmark and enables faction mods
 *   --mode "Incarnon Form"      use an alternative fire mode
 *   --stacks onKill=5           activate a conditional effect
 *   --status-types 4            total status types on the target (default: each build's own + extra)
 *   --extra-status-types 2      status types other sources keep on the target
 *   --headshot                  treat every hit as a weak-point hit
 *   --brief                     one line per result (cheapest output for an agent)
 *   --json                      machine-readable output (only when you must parse it)
 *   --debug                     add the stack trace when a command fails
 */
import { readFileSync } from 'node:fs';
import { loadSnapshot, findEnemy, findMod, findWeapon, modsForWeapon } from './data.ts';
import { resolveBuild, type Build, type BuildMod, type HitZone, type StackMode } from './engine/build.ts';
import { search } from './engine/search.ts';
import { bruteForce } from './engine/bruteforce.ts';
import { capacityOf } from './engine/capacity.ts';
import { attenuationProfile, type AttenuationProfile } from './engine/attenuation.ts';
import { abilityCast } from './engine/ability.ts';
import { resolveStrip, type StripDebuff } from './engine/strip.ts';
import { buildFromJson } from './request.ts';
import { InputError } from './errors.ts';
import { scaleEnemy } from './engine/enemy.ts';
import { hitEnemy } from './engine/damage.ts';
import { BUFFS, availableBuffs } from './engine/buffs.ts';
import { RIVEN_ATTRIBUTES, type RivenSpec } from './engine/riven.ts';
import { SHARD_BONUSES, type ShardColor, type ShardSpec } from './engine/shards.ts';
import type { Snapshot } from './types.ts';

interface Args {
  command: string;
  positional: string[];
  flags: Map<string, string[]>;
}

function parseArgs(argv: string[]): Args {
  const positional: string[] = [];
  const flags = new Map<string, string[]>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) {
      positional.push(arg);
      continue;
    }
    const [rawKey, inlineValue] = arg.slice(2).split('=');
    const key = rawKey;
    const value = inlineValue ?? (argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : 'true');
    flags.set(key, [...(flags.get(key) ?? []), value]);
  }
  return { command: positional.shift() ?? 'help', positional, flags };
}

const flag = (args: Args, name: string): string | undefined => args.flags.get(name)?.at(-1);
const flagAll = (args: Args, name: string): string[] => args.flags.get(name) ?? [];

/** `--mod "Serration, Split Chamber"` and repeated `--mod` are the same thing. No mod name in
 *  the snapshot contains a comma, so splitting cannot break a name. */
const modsFromArgs = (args: Args): BuildMod[] =>
  flagAll(args, 'mod')
    .flatMap((entry) => entry.split(','))
    .map((name) => name.trim())
    .filter(Boolean)
    .map(parseModArg);

const pct = (value: number): string => `${(value * 100).toFixed(1)}%`;
const num = (value: number, digits = 1): string => value.toLocaleString('en-US', { maximumFractionDigits: digits, minimumFractionDigits: 0 });

/** `--mod Serration` or `--mod Serration:R4` or `--mod "Serration R4"`. */
function parseModArg(raw: string): BuildMod {
  const match = /^(.*?)[\s:]+R(\d+)$/i.exec(raw.trim());
  if (match) return { name: match[1].trim(), rank: Number(match[2]) };
  return { name: raw.trim() };
}

/** `--element-bonus toxin` or `toxin:45` -> Kuva/Tenet/Coda bonus element (60% when no number); `none` -> none. */
function parseElementBonus(args: Args) {
  const raw = flag(args, 'element-bonus');
  if (!raw) return undefined;
  const [type, value] = raw.split(':');
  const element = (type ?? '').trim().toLowerCase();
  if (element === 'none') return { type: 'heat' as never, value: 0 };
  const amount = value === undefined ? 60 : Number(String(value).replace('%', '').trim());
  if (!element || !Number.isFinite(amount)) return undefined;
  return { type: element as never, value: amount > 1 ? amount / 100 : amount };
}

/** `--riven damage,multishot,-zoom` -> a riven spec (- prefix means malus). */
function parseRiven(args: Args): RivenSpec | undefined {
  const raw = flag(args, 'riven');
  if (!raw) return undefined;
  const stats: string[] = [];
  let malus: string | undefined;
  // "crit-chance=142.3" gives the card's own value; a bare id estimates it from disposition.
  const values: Record<string, number> = {};
  for (const token of raw.split(',').map((entry) => entry.trim()).filter(Boolean)) {
    const negative = token.startsWith('-');
    const [id, rawValue] = (negative ? token.slice(1) : token).split('=').map((part) => part.trim());
    if (negative) malus = id;
    else stats.push(id);
    if (rawValue !== undefined) {
      const value = Number(rawValue.replace(/^[x+]/i, '').replace(/%$/, ''));
      if (!Number.isFinite(value)) throw new CliError(`--riven: bad value for ${id}: ${rawValue}`, 'invalid_argument');
      values[id] = value;
    }
  }
  const drain = flag(args, 'riven-drain');
  return {
    stats,
    malus,
    roll: flag(args, 'riven-roll') ? Number(flag(args, 'riven-roll')) : undefined,
    rank: flag(args, 'riven-rank') ? Number(flag(args, 'riven-rank')) : undefined,
    ...(Object.keys(values).length ? { values } : {}),
    ...(drain !== undefined ? { drain: Number(drain) } : {}),
    ...(flag(args, 'riven-polarity') ? { polarity: flag(args, 'riven-polarity')!.toLowerCase() } : {}),
  };
}

/** Conditions from `--stacks onKill=5` and friends. */
/** `--stacks none|max` picks a stack mode; `--stacks onKill=5` sets conditions (custom mode). */
const STACK_MODES: Record<string, StackMode> = { none: 'none', off: 'none', max: 'max', all: 'max', custom: 'custom' };

function parseStackMode(args: Args): StackMode | undefined {
  const modes = flagAll(args, 'stacks').map((entry) => STACK_MODES[entry.trim().toLowerCase()]).filter(Boolean);
  return modes.at(-1);
}

/** `--source-stacks "Primary Merciless=6,Galvanized Chamber=max"`: stacks per mod, arcane or buff. */
function parseSourceStacks(snapshot: Snapshot, args: Args): Record<string, number> | undefined {
  const entries = flagAll(args, 'source-stacks').flatMap((entry) => entry.split(',')).map((entry) => entry.trim()).filter(Boolean);
  if (!entries.length) return undefined;
  const out: Record<string, number> = {};
  for (const entry of entries) {
    const [rawName, rawValue = 'max'] = entry.split('=').map((part) => part.trim());
    // A cap comes from the data: the largest maxStacks among the source's conditional effects.
    const source = findMod(snapshot, rawName).item ?? snapshot.arcanes[rawName];
    const name = source?.name ?? rawName;
    const cap = Math.max(1, ...(source?.effects ?? []).filter((effect) => effect.condition).map((effect) => effect.maxStacks ?? 1));
    const value = /^(max|all)$/i.test(rawValue) ? cap : /^(none|off)$/i.test(rawValue) ? 0 : Number(rawValue);
    if (!Number.isFinite(value) || value < 0) throw new CliError(`--source-stacks: bad value for ${rawName}: ${rawValue}`, 'invalid_argument');
    out[name] = value;
  }
  return out;
}

/** `--shards "crimson:primaryStatus,violet:primaryElectricity:tau"`: Archon Shards, up to five. */
function parseShards(args: Args): ShardSpec[] | undefined {
  const entries = flagAll(args, 'shards').flatMap((entry) => entry.split(',')).map((entry) => entry.trim()).filter(Boolean);
  if (!entries.length) return undefined;
  return entries.map((entry) => {
    const [color, bonus = 'other', tau] = entry.split(':').map((part) => part.trim());
    const colour = color.toLowerCase() as ShardColor;
    const known = SHARD_BONUSES[colour];
    if (!known) throw new CliError(`unknown shard colour: ${color} (${Object.keys(SHARD_BONUSES).join(', ')})`, 'invalid_argument');
    if (!(bonus in known)) throw new CliError(`unknown ${colour} shard bonus: ${bonus} (${Object.keys(known).join(', ')})`, 'invalid_argument');
    return { color: colour, bonus, tauforged: /^(tau|tauforged)$/i.test(tau ?? '') };
  });
}

/** `--hit head|body`, or the `--headshot` / `--bodyshot` shorthands. */
function parseHitZone(args: Args): HitZone {
  const raw = flag(args, 'hit')?.toLowerCase();
  if (raw !== undefined && raw !== 'head' && raw !== 'body' && raw !== 'headshot' && raw !== 'bodyshot') {
    throw new CliError('--hit must be head or body', 'invalid_argument');
  }
  if (raw === 'head' || raw === 'headshot' || args.flags.has('headshot')) return 'head';
  return 'body';
}

function parseConditions(args: Args): Record<string, number> {
  const conditions: Record<string, number> = {};
  for (const entry of flagAll(args, 'stacks')) {
    if (STACK_MODES[entry.trim().toLowerCase()]) continue;
    for (const pair of entry.split(',')) {
      const [key, value] = pair.split('=');
      conditions[key.trim()] = value ? Number(value) : 1;
    }
  }
  // A number is the total on the target; without one (or with `auto`) each build counts its own.
  const statusTypes = flag(args, 'status-types');
  if (statusTypes && statusTypes !== 'auto') conditions.statusTypes = Number(statusTypes);
  // Harrow's Covenant scales with the damage prevented during invulnerability.
  const covenantDamage = flag(args, 'covenant-damage');
  if (covenantDamage) conditions.covenantDamage = Number(covenantDamage);
  return conditions;
}

/** Maps the CLI flags onto the shared armour-strip resolver. */
function armorStripDebuff(snapshot: Snapshot, args: Args): StripDebuff {
  const cp = flag(args, 'cp');
  const direct = flag(args, 'armor-strip');
  const shattering = flag(args, 'shattering-impact');
  return resolveStrip(snapshot, {
    corrosiveProjections: cp !== undefined ? Number(cp) : undefined,
    armorStripPercent: direct !== undefined ? Number(direct) : undefined,
    stripFrom: flag(args, 'strip-from'),
    shatteringImpactHits: shattering !== undefined ? Number(shattering) : undefined,
    strength: flag(args, 'strength') ? Number(flag(args, 'strength')) : undefined,
  });
}

function buildFromArgs(snapshot: Snapshot, args: Args, mods: string[]): Build {
  const weapon = requireWeapon(snapshot, args.positional[0]);
  // A bad strip value is input, not a crash: resolve it here so the error carries a code.
  let strip: StripDebuff;
  try {
    strip = armorStripDebuff(snapshot, args);
  } catch (error) {
    throw new CliError((error as Error).message, 'invalid_argument');
  }
  const buffs = flagAll(args, 'buff')
    .flatMap((entry) => entry.split(','))
    .map((entry) => entry.trim())
    .filter(Boolean);

  return {
    weapon: weapon.name,
    mods,
    arcanes: flagAll(args, 'arcane')
      .flatMap((entry) => entry.split(','))
      .map((name) => name.trim())
      .filter((name) => name && name.toLowerCase() !== 'auto')
      .map(parseModArg),
    buffs,
    abilityStrength: flag(args, 'strength') ? Number(flag(args, 'strength')) : undefined,
    frame: flag(args, 'frame'),
    warframeArcanes: flagAll(args, 'frame-arcane').flatMap((entry) => entry.split(',')).map((e) => parseModArg(e.trim())).filter((e) => e.name),
    frameMods: flagAll(args, 'frame-mods')
      .flatMap((entry) => entry.split(','))
      .map((entry) => parseModArg(entry.trim()))
      .filter((entry) => entry.name),
    riven: parseRiven(args),
    elementBonus: parseElementBonus(args),
    aoeDistance: flag(args, 'aoe-distance') ? Number(flag(args, 'aoe-distance')) : undefined,
    comboHits: flag(args, 'combo-hits') ? Number(flag(args, 'combo-hits')) : undefined,
    // Sniper zoom: a level number (1 = first step) or `max`; the Shot Combo Counter as hits.
    zoom: flag(args, 'zoom') === 'max' ? 99 : flag(args, 'zoom') ? Number(flag(args, 'zoom')) : undefined,
    sniperCombo: flag(args, 'sniper-combo') ? Number(flag(args, 'sniper-combo')) : undefined,
    heavyAttack: args.flags.has('heavy'),
    // "auto" is handled by the search command; a list is passed through as it stands.
    ...(flagAll(args, 'incarnon').length
      ? { incarnon: flagAll(args, 'incarnon').flatMap((entry) => entry.split(',')).map((e) => e.trim()).filter(Boolean) }
      : {}),
    debuffs: {
      viralStacks: flag(args, 'viral') ? Number(flag(args, 'viral')) : undefined,
      corrosiveStacks: flag(args, 'corrosive') ? Number(flag(args, 'corrosive')) : undefined,
      ...strip,
    },
    mode: flag(args, 'mode'),
    conditions: parseConditions(args),
    hit: parseHitZone(args),
    stackMode: parseStackMode(args),
    sourceStacks: parseSourceStacks(snapshot, args),
    shards: parseShards(args),
    extraStatusTypes: flag(args, 'extra-status-types') ? Number(flag(args, 'extra-status-types')) : undefined,
  };
}

function resolveEnemy(snapshot: Snapshot, args: Args) {
  const faction = flag(args, 'faction');
  const level = Number(flag(args, 'level') ?? 100);
  let enemyName = flag(args, 'enemy');
  if (!enemyName && faction) {
    const benchmarks: Record<string, string> = {
      grineer: 'Bombard',
      corpus: 'Corpus Tech',
      infested: 'Ancient Healer',
      orokin: 'Corrupted Bombard',
      murmur: 'The Hollow Vein',
      sentient: 'Battalyst',
    };
    enemyName = benchmarks[faction.toLowerCase()] ?? 'Bombard';
  }
  enemyName ??= 'Bombard';
  const { item, suggestions } = findEnemy(snapshot, enemyName);
  if (!item) throw new CliError(`enemy not found: ${enemyName}`, 'enemy_not_found', suggestions);
  return { enemy: item, level };
}

/** `--eximus` / `--overguard N`: the target's extra layer. `--steel-path`: health and shields x2.5. */
function targetScale(args: Args): { eximus?: boolean; overguard?: number; steelPath?: boolean } {
  const steelPath = args.flags.has('steel-path') ? { steelPath: true } : {};
  const raw = flag(args, 'overguard');
  if (raw === undefined) return { ...(args.flags.has('eximus') ? { eximus: true } : {}), ...steelPath };
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    throw new CliError('--overguard expects a non-negative number', 'invalid_argument');
  }
  return { overguard: value, ...steelPath };
}

/** Damage types with a non-zero share: the status types a build can put on a target. */
/** `--attenuation archon|eidolon|custom` plus the explicit caps. */
function attenuationFromArgs(args: Args): string | AttenuationProfile | null | undefined {
  const id = flag(args, 'attenuation');
  const mdpi = flag(args, 'mdpt');
  const mdps = flag(args, 'mdps');
  const flat = flag(args, 'flat-dr');
  const status = flag(args, 'status-dr');
  if (!id && mdpi === undefined && mdps === undefined && flat === undefined && status === undefined) return undefined;
  if (id && id.trim().toLowerCase() === 'none') return null;
  const number = (name: string, raw: string | undefined): number | undefined => {
    if (raw === undefined) return undefined;
    const value = Number(raw);
    if (!Number.isFinite(value) || value < 0) throw new CliError(`--${name} expects a non-negative number`, 'invalid_argument');
    return value;
  };
  const idLower = id?.trim().toLowerCase();
  if (idLower && !['custom', 'archon', 'eidolon', 'none'].includes(idLower)) {
    throw new CliError(`unknown attenuation profile: ${id} (use archon, eidolon, custom or none)`, 'invalid_argument');
  }
  const preset = idLower ? attenuationProfile(idLower) : null;
  const overrides = {
    mdpi: number('mdpt', mdpi),
    mdps: number('mdps', mdps),
    flatDr: flat === undefined ? undefined : number('flat-dr', flat)! / 100,
    statusDr: status === undefined ? undefined : number('status-dr', status)! / 100,
  };
  const hasOverrides = Object.values(overrides).some((value) => value !== undefined);
  if (preset && !hasOverrides) return preset.id;
  const profile: AttenuationProfile = {
    ...(preset ?? { id: 'custom' }),
    ...overrides,
    id: preset?.id ?? 'custom',
  };
  return profile;
}

/** The one-line calculation summary, shared by `calc`/`compare` and `batch`. */
function calcBriefLine(
  label: string,
  resolved: ReturnType<typeof resolveBuild>,
  hit: ReturnType<typeof hitEnemy>,
  enemyName: string,
  level: number,
  mode: 'full' | 'answer',
  fit?: ReturnType<typeof capacityOf>,
  arcanes?: Array<{ name: string; rank?: number }>,
): string {
  const head = `${label ? `${label}: ` : ''}${resolved.weapon.name} vs ${enemyName} ${level}`;
  const ttk = hit.timeToKill === null ? 'cannot kill' : `ttk ${num(hit.timeToKill, 2)}s (${num(hit.shotsToKill, 1)} shots)`;
  if (mode === 'answer') {
    return `${head} · ${num(hit.totalDps)} dps · ${ttk}${hit.overguard > 0 ? ` · overguard ${num(hit.overguard)}` : ''}`;
  }
  const parts = [
    head,
    `burst ${num(resolved.burstDps)}`,
    `sustained ${num(resolved.sustainedDps)}`,
    `shot ${num(hit.damagePerShotHealth)} to health`,
    `total ${num(hit.totalDps)} dps with status`,
    ttk,
    `armour ${num(hit.armor)}`,
    ...(hit.overguard > 0 ? [`overguard ${num(hit.overguard)}`] : []),
    ...(hit.attenuation ? [`attenuation ${hit.attenuation.id}`] : []),
    ...(hit.multiTargetDps !== null ? [`${hit.multiTargetTargets} targets = ${num(hit.multiTargetDps)} dps`] : []),
    ...(fit && fit.mods.length ? [`${fit.capacityUsed}/${fit.capacity} cap${fit.fits ? '' : ' OVER'}`, `${fit.formaNeeded}F`] : []),
    ...(arcanes?.length ? [`arcane ${arcanes.map((arcane) => arcane.name).join(' + ')}`] : []),
    ...(resolved.usesStatusTypes ? [`statusTypes ${resolved.statusTypes}`] : []),
  ];
  const warnings = resolved.warnings.length + hit.warnings.length + resolved.unsupportedMods.length;
  if (warnings) parts.push(`${warnings} warning(s)`);
  if (resolved.unsupportedMods.length) parts.push('lower bound');
  return parts.join(' · ');
}

/** The one-line ability summary, shared by `ability` and `batch`. */
function abilityBriefLine(result: ReturnType<typeof abilityCast>, mode: 'full' | 'answer'): string {
  const strip = result.armorStrip
    ? `strip ${result.armorStrip.fraction !== null ? `${(result.armorStrip.fraction * 100).toFixed(0)}%` : `${num(result.armorStrip.points ?? 0)} pts`}`
    : '';
  const target = result.target
    ? `vs ${result.target.enemy} ${result.target.level}: ${num(result.target.perCast)}/cast`
      + (result.target.statusPerCast > 0 ? ` (+${num(result.target.statusPerCast)} status)` : '')
      + ` · ${result.target.castsToKill === null ? 'cannot kill' : `${num(result.target.castsToKill)} casts`}`
      + (result.target.shield > 0 && !result.target.bypassesShield ? ` · shields ${num(result.target.shieldPerCast)}/cast` : '')
      + (result.target.viralStacks > 0 ? ` · ${result.target.viralStacks} viral` : '')
      + (result.target.corrosiveStacks > 0 ? ` · corrosive ${result.target.corrosiveStacks} (${((1 - result.target.corrosiveArmorMultiplier) * 100).toFixed(0)}% strip)` : '')
      + (result.distance > 0 ? ` · ${result.distance} m (x${result.distanceFactor.toFixed(2)})` : '')
      + (result.target.overguard > 0 ? ` · overguard ${num(result.target.overguard)}` : '')
      + (result.target.targets > 1 ? ` · ${result.target.targets} targets = ${num(result.target.totalPerCast)}` : '')
    : '';
  const damageTypes = [...new Set(result.damageComponents.map((component) => component.type))];
  return [
    `${result.frame} ${result.ability}${damageTypes.length ? ` (${damageTypes.join('+')})` : result.damageType ? ` (${result.damageType})` : ''}${result.mode ? ` · ${result.mode} mode` : ''}`,
    `${num(result.scaledDamage)}${result.perSecond ? '/s' : ''} at ${num(result.strength)}%`,
    ...(mode === 'full' ? [`total ${num(result.totalDamage)}`] : []),
    target,
    strip,
  ].filter(Boolean).join(' · ');
}

function report(snapshot: Snapshot, args: Args, mods: BuildMod[], label: string): void {
  let build = buildFromArgs(snapshot, args, mods.map((m) => (m.rank ? `${m.name}=R${m.rank}` : m.name)));
  // Re-apply ranks lost by the string round-trip above.
  build.mods = mods;
  const resolved = resolveBuild(snapshot, build);
  const { enemy, level } = resolveEnemy(snapshot, args);
  const scaled = scaleEnemy(snapshot, enemy, level, targetScale(args));
  const hit = hitEnemy(snapshot, resolved, scaled, {
    attenuation: attenuationFromArgs(args),
    targets: flag(args, 'targets') ? Number(flag(args, 'targets')) : undefined,
    simulate: !args.flags.has('no-sim'),
  });
  const allWarnings = [...resolved.warnings, ...hit.warnings];
  const capacityLimit = flag(args, 'capacity') ? Number(flag(args, 'capacity')) : 60;
  const fit = capacityOf(snapshot, resolved.weapon, build.mods, capacityLimit, build.riven);

  // One line, for an agent that runs dozens of these: the numbers that answer the question
  // without the per-type and per-status breakdown it did not ask for.
  const brief = briefMode(args);
  if (brief !== 'off') {
    console.log(calcBriefLine(
      label === 'build' ? '' : label, resolved, hit, enemy.name, level, brief, fit,
      (build.arcanes ?? []).map((entry) => (typeof entry === 'string' ? { name: entry } : { name: entry.name, rank: entry.rank })),
    ));
    return;
  }

  if (args.flags.has('json')) {
    console.log(
      JSON.stringify(
        {
          label,
          weapon: resolved.weapon.name,
          mode: resolved.mode?.name ?? 'arsenal',
          level,
          enemy: enemy.name,
          damage: resolved.damage.perProjectile,
          projectileTotal: resolved.damage.projectileTotal,
          shotDamage: resolved.shotDamage,
          averageShotDamage: resolved.averageShotDamage,
          // Damage per trigger pull actually landing on the target: armour, the faction
          // health class, crit average, multishot and viral included, status DoT excluded.
          damagePerShotHealth: hit.damagePerShotHealth,
          damagePerShotShield: hit.damagePerShotShield,
          damagePerShotOverguard: hit.damagePerShotOverguard,
          burstDps: resolved.burstDps,
          sustainedDps: resolved.sustainedDps,
          critChance: resolved.critChance,
          critMultiplier: resolved.critMultiplier,
          statusChance: resolved.statusChance,
          multishot: resolved.multishot,
          fireRate: resolved.fireRate,
          shotsToKill: hit.shotsToKill,
          timeToKill: hit.timeToKill,
          hitZone: resolved.hitZone,
          hitMultiplier: hit.hit.location,
          stackMode: build.stackMode ?? 'custom',
          simulation: hit.simulation
            ? { timeToKill: hit.simulation.timeToKill, statusAtKill: hit.simulation.atEnd, damageBySource: hit.simulation.damageBySource }
            : null,
          factionMultiplier: hit.factionMultiplier,
          // Armour actually applied, after every strip: the enemy's own value would make a
          // stripped target look untouched.
          armor: hit.armor,
          overguard: hit.overguard,
          overguardDps: hit.overguardDps,
          attenuation: hit.attenuation,
          multiTargetDps: hit.multiTargetDps,
          multiTargetFactor: hit.multiTargetFactor,
          dot: hit.dot,
          totalDps: hit.totalDps,
          arcanes: (build.arcanes ?? []).map((entry) => (typeof entry === 'string' ? { name: entry } : { name: entry.name, rank: entry.rank })),
          statusTypes: resolved.usesStatusTypes ? resolved.statusTypes : null,
          activeBuffs: resolved.activeBuffs,
          abilityStrength: resolved.abilityStrength,
          riven: resolved.rivenLines,
          incarnon: resolved.incarnonLines,
          comboMultiplier: resolved.comboMultiplier,
          critVariance: resolved.critVariance,
          capacityUsed: fit.capacityUsed,
          capacity: fit.capacity,
          formaNeeded: fit.formaNeeded,
          fits: fit.fits,
          warnings: allWarnings,
          unsupportedMods: resolved.unsupportedMods,
          inactiveConditions: resolved.inactiveConditions,
        },
        null,
        2,
      ),
    );
    return;
  }

  const w = resolved.weapon;
  console.log(`\n${label}  —  ${w.name} (${w.type}${resolved.mode ? `, ${resolved.mode.name}` : ''}) vs ${enemy.name} lv${level}${scaled.steelPath ? ' (Steel Path)' : ''}`);
  console.log('─'.repeat(78));
  console.log(
    `  damage/shot  ${num(resolved.damage.projectileTotal, 2).padStart(9)}  ` +
      `×${resolved.multishot.toFixed(2)} multishot  ×${(1 + resolved.critChance * (resolved.critMultiplier - 1)).toFixed(2)} crit avg`,
  );
  // The headline damage/shot is the arsenal number (raw, before the target). This is what one
  // pull actually removes from the thing in front of you.
  console.log(
    `  vs target    ${num(hit.damagePerShotHealth)} to health` +
      `  ·  ${num(hit.damagePerShotShield)} to shields` +
      (hit.overguard > 0 ? `  ·  ${num(hit.damagePerShotOverguard)} to overguard` : '') +
      `   (per pull, crit avg, after armour)`,
  );
  console.log(
    `  crit         ${pct(resolved.critChance).padStart(7)} ×${resolved.critMultiplier.toFixed(2)}` +
      `   status ${pct(resolved.statusChance)}   fire rate ${resolved.fireRate.toFixed(2)}/s`,
  );
  console.log(`  elements     ${resolved.elements.map((e) => `${e.type} ${pct(e.share)}`).join(', ')}`);
  console.log(
    `  dps          burst ${num(resolved.burstDps)}   sustained ${num(resolved.sustainedDps)}` +
      `   avg hit ${num(resolved.averageShotDamage)}`,
  );
  if (fit.mods.length) {
    console.log(`  capacity     ${fit.capacityUsed}/${fit.capacity}${fit.fits ? '' : ' over'}${fit.formaNeeded ? `   ${fit.formaNeeded} forma` : ''}`);
  }
  if (resolved.usesStatusTypes) {
    console.log(`  status types ${resolved.statusTypes}${build.conditions?.statusTypes === undefined ? ' (the build\'s own + extra)' : ''}`);
  }
  console.log(
    `  target       hp ${num(scaled.health)}  shields ${num(scaled.shield)}  armor ${num(hit.armor)}` +
      (hit.overguard > 0 ? `  overguard ${num(hit.overguard)}` : '') +
      (hit.armor !== scaled.armor ? ` (base ${num(scaled.armor)})` : '') +
      `   -> ${num(hit.shotsToKill)} shots${hit.timeToKill !== null ? `, ${num(hit.timeToKill, 2)}s` : ''}`,
  );
  console.log(`  hit          ${resolved.hitZone === 'head' ? 'headshots' : 'bodyshots'} x${num(hit.hit.location, 2)}`
    + `  crit ${pct(hit.hit.critChance)} avg x${num(hit.hit.averageCrit, 2)}`
    + `  stacks ${build.stackMode ?? 'custom'}${build.sourceStacks ? ` (${Object.entries(build.sourceStacks).map(([name, value]) => `${name} ${value}`).join(', ')})` : ''}`);
  if (hit.simulation) {
    const end = hit.simulation.atEnd;
    const dealt = Object.entries(hit.simulation.damageBySource).filter(([, value]) => value > 0);
    const totalDealt = dealt.reduce((sum, [, value]) => sum + value, 0) || 1;
    console.log(`  fight        statuses at the kill: viral ${num(end.viral, 1)}, corrosive ${num(end.corrosive, 1)}, heat strip ${pct(end.heatStrip)}`
      + `${end.magnetic ? `, magnetic ${num(end.magnetic, 1)}` : ''}${end.cold ? `, cold ${num(end.cold, 1)}` : ''}  armour ${num(end.armor)}`);
    console.log(`  damage from  ${dealt.sort((a, b) => b[1] - a[1]).map(([source, value]) => `${source} ${pct(value / totalDealt)}`).join(', ')}`);
  }
  if (hit.multiTargetDps !== null) {
    console.log(`  multi-target  ${num(hit.multiTargetFactor, 2)}x across the chain -> ${num(hit.multiTargetDps)} dps`);
  }
  if (hit.attenuation) {
    console.log(`  attenuation  ${hit.attenuation.id}  caps ${num(hit.attenuation.mdpi)}/hit · ${num(hit.attenuation.mdps)}/s`
      + `${hit.attenuation.flatDr ? ` · ${(hit.attenuation.flatDr * 100).toFixed(0)}% DR` : ''}`);
  }
  if (hit.factionMultiplier !== 1) console.log(`  faction      x${hit.factionMultiplier.toFixed(2)} vs ${enemy.faction ?? 'unknown'}`);
  if (build.arcanes?.length) {
    console.log(`  arcane       ${build.arcanes.map((entry) => (typeof entry === 'string' ? entry : `${entry.name}${entry.rank !== undefined ? ` R${entry.rank}` : ''}`)).join(', ')}`);
  }
  if (resolved.activeBuffs.length) console.log(`  buffs        ${resolved.activeBuffs.join(', ')} @ ${num(resolved.abilityStrength)}% strength`);
  if (resolved.rivenLines.length) console.log(`  riven        ${resolved.rivenLines.join(', ')}`);
  if (resolved.incarnonLines.length) console.log(`  incarnon     ${resolved.incarnonLines.join(' / ')}`);
  if (resolved.elementBonus) {
    const picked = build.elementBonus ? '' : ', the default: pick with --element-bonus';
    console.log(`  element      +${(resolved.elementBonus.value * 100).toFixed(0)}% ${resolved.elementBonus.type} (Kuva/Tenet/Coda bonus${picked})`);
  }
  if (resolved.comboMultiplier > 1) {
    console.log(`  combo        ${num(resolved.comboMultiplier, 1)}x at ${build.comboHits} hits${build.heavyAttack ? ' (heavy attack)' : ''}`);
  }
  if (hit.dot.length) {
    console.log('  ── status damage ──');
    for (const entry of hit.dot.sort((a, b) => b.dps - a.dps)) {
      console.log(
        `   ${entry.type.padEnd(12)} ${num(entry.procsPerSecond, 2).padStart(5)} proc/s  ` +
          `tick ${num(entry.tickDamage, 1).padStart(7)} × ${entry.ticks}  → ${num(entry.dps).padStart(8)} dps`,
      );
    }
    console.log(`   ${'total'.padEnd(12)} ${num(hit.totalDps).padStart(34)} dps including status`);
  }
  if (resolved.multishot >= 2 && resolved.critChance > 0) {
    const variance = resolved.critVariance;
    console.log(
      `  pellets      ${num(variance.expectedCrits, 2)} crits expected of ${num(variance.pellets, 1)}` +
        `   ${pct(variance.atLeastOneCrit)} of shots land at least one`,
    );
  }
  if (hit.bestType) {
    console.log(`  best type    ${hit.bestType.type} ×${hit.bestType.multiplier.toFixed(2)}`);
  }
  console.log('  ── per type ──');
  for (const entry of hit.breakdown.sort((a, b) => b.toHealth - a.toHealth)) {
    console.log(
      `   ${entry.type.padEnd(12)} ${num(entry.raw, 2).padStart(8)}  hp×${entry.healthMultiplier.toFixed(2).padStart(5)}` +
        `  → ${num(entry.toHealth, 2).padStart(8)}   proc ${pct(entry.procShare)}`,
    );
  }
  for (const warning of allWarnings) console.log(`  ! ${warning}`);
  if (resolved.unsupportedMods.length) console.log(`  ! mods with unknown effects (result is a lower bound): ${resolved.unsupportedMods.join(', ')}`);
  if (resolved.inactiveConditions.length) console.log(`  · inactive conditions: ${resolved.inactiveConditions.length} (use --stacks to enable)`);
}

/** Machine-readable output for the listing commands; the human table stays the default. */
function emitJson(payload: unknown): void {
  console.log(JSON.stringify(payload, null, 0));
}

const wantsJson = (args: Args): boolean => args.flags.has('json');
/**
 * `--brief` prints the full one-liner; `--brief=answer` drops the context an agent already
 * knows (burst/sustained/armour, search assumptions) and keeps the answer only.
 */
type BriefMode = 'off' | 'full' | 'answer';
const briefMode = (args: Args): BriefMode => {
  if (wantsJson(args) || !args.flags.has('brief')) return 'off';
  return flag(args, 'brief') === 'answer' ? 'answer' : 'full';
};

/**
 * An expected failure: bad input, unknown name, impossible option. These exit with code 2 and
 * are reported without a stack trace, because the caller is usually an agent that needs a
 * deterministic shape, not Node internals.
 */
class CliError extends Error {
  readonly code: string;
  readonly suggestions: string[];
  constructor(message: string, code: string, suggestions: string[] = []) {
    super(message);
    this.name = 'CliError';
    this.code = code;
    this.suggestions = suggestions;
  }
}

function requireWeapon(snapshot: Snapshot, query: string) {
  const { item, suggestions } = findWeapon(snapshot, query);
  if (!item) throw new CliError(`weapon not found: ${query}`, 'weapon_not_found', suggestions);
  return item;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const snapshot = loadSnapshot();

  switch (args.command) {
    case 'weapons': {
      const query = args.positional[0] ?? '';
      const list = Object.values(snapshot.weapons).filter((w) => w.name.toLowerCase().includes(query.toLowerCase()));
      if (wantsJson(args)) {
        emitJson(list.map((w) => ({
          name: w.name, category: w.category, type: w.type, masteryRank: w.masteryRank,
          disposition: w.disposition, hasRivenSlot: w.hasRivenSlot, modClasses: w.modClasses,
        })));
        break;
      }
      for (const weapon of list.slice(0, 60)) {
        console.log(`${weapon.name.padEnd(30)} ${weapon.category.padEnd(10)} ${weapon.type.padEnd(14)} MR${weapon.masteryRank}`);
      }
      console.log(`\n${list.length} weapon(s)`);
      break;
    }
    case 'mods': {
      const item = requireWeapon(snapshot, args.positional[0] ?? '');
      const query = (args.positional[1] ?? '').toLowerCase();
      // Search names and descriptions: players look for "multishot", not "Split Chamber".
      const list = modsForWeapon(snapshot, item).filter(
        (m) => !m.conclave && (m.name.toLowerCase().includes(query) || m.description.toLowerCase().includes(query) || m.effects.some((e) => e.target.toLowerCase().includes(query))),
      );
      const sorted = list.sort((a, b) => a.name.localeCompare(b.name));
      if (wantsJson(args)) {
        emitJson({
          weapon: item.name,
          modClasses: item.modClasses,
          count: sorted.length,
          mods: sorted.map((m) => ({
            name: m.name, maxRank: m.maxRank, polarity: m.polarity, rarity: m.rarity,
            baseDrain: m.baseDrain, classes: m.classes, isExilus: Boolean(m.isExilus),
            // partial marks a lower bound: at least one line of the mod is not modelled.
            partial: m.partial, outOfScopeLines: m.outOfScopeLines ?? [],
            description: m.description, levels: m.levels ?? [],
            effects: m.effects.map((e) => ({ target: e.target, op: e.op, value: e.value, condition: e.condition ?? null })),
          })),
        });
        break;
      }
      for (const mod of sorted) {
        console.log(`${mod.name.padEnd(28)} ${String(mod.maxRank).padStart(2)}  ${mod.polarity ?? '-'.padEnd(8)}  ${mod.description.split('\n')[0]}`);
      }
      console.log(`\n${list.length} mod(s) fit ${item.name}`);
      break;
    }
    case 'enemies': {
      const query = (args.positional[0] ?? '').toLowerCase();
      const list = Object.values(snapshot.enemies).filter((e) => e.name.toLowerCase().includes(query));
      if (wantsJson(args)) {
        emitJson(list.map((e) => ({
          name: e.name, faction: e.faction ?? null, healthClass: e.healthClass,
          health: e.health, shield: e.shield, armor: e.armor,
          healthTypes: e.pools.map((p) => ({ type: p.type, category: p.category, amount: p.amount })),
        })));
        break;
      }
      for (const enemy of list.slice(0, 60)) {
        console.log(`${enemy.name.padEnd(32)} ${(enemy.healthClass ?? '-').padEnd(16)} hp${enemy.health} sh${enemy.shield} ar${enemy.armor}  ${enemy.pools.map((p) => p.type).join('+')}`);
      }
      console.log(`\n${list.length} enemy(ies)`);
      break;
    }
    case 'incarnon': {
      const item = requireWeapon(snapshot, args.positional[0] ?? '');
      const options = snapshot.incarnons[item.name] ?? [];
      if (!options.length) {
        console.log(`no Incarnon evolution data for ${item.name}`);
        break;
      }
      if (wantsJson(args)) {
        emitJson({
          weapon: item.name,
          tiers: [...new Set(options.map((o) => o.tier))].map((tier) => ({
            tier,
            choices: options
              .filter((o) => o.tier === tier)
              .map((o, index) => ({
                index, name: o.name, text: o.text,
                effects: o.effects.map((e) => ({
                  target: e.target, element: e.element ?? null, value: e.value, flat: Boolean(e.flat), raw: e.raw,
                })),
              })),
          })),
        });
        break;
      }
      const byTier = new Map<string, typeof options>();
      for (const option of options) byTier.set(option.tier, [...(byTier.get(option.tier) ?? []), option]);
      for (const [tier, list] of byTier) {
        console.log(`${tier}`);
        list.forEach((option, index) => {
          const effects = option.effects
            .map((e) => `${e.target}${e.element ? `:${e.element}` : ''} ${e.flat ? `+${e.value}` : `+${(e.value * 100).toFixed(0)}%`}`)
            .join(', ');
          console.log(`  ${index}. ${option.name.padEnd(26)} ${effects || '(mechanic, no stats parsed)'}`);
        });
      }
      console.log(`\nPick with: --incarnon "${[...byTier.keys()].slice(0, 2).map((t) => `${t}:0`).join(',')}"`);
      break;
    }
    case 'rivens': {
      const query = (args.positional[0] ?? '').toLowerCase();
      const attributes = RIVEN_ATTRIBUTES.filter((a) => a.id.includes(query));
      if (wantsJson(args)) {
        emitJson({ count: RIVEN_ATTRIBUTES.length, attributes: attributes.map((a) => ({ id: a.id, label: a.label })) });
        break;
      }
      for (const attribute of attributes) {
        console.log(`${attribute.id.padEnd(18)} ${attribute.label}`);
      }
      console.log(`\n${RIVEN_ATTRIBUTES.length} attribute(s). Usage: --riven damage,multishot,-zoom`);
      break;
    }
    case 'buffs': {
      if (wantsJson(args)) {
        emitJson(availableBuffs(snapshot).map((buff) => {
          const definition = BUFFS.find((b) => b.id === buff.id)!;
          const ability = snapshot.abilities[definition.ability];
          return {
            id: buff.id, frame: buff.frame, ability: definition.ability,
            abilityBaseValue: ability?.value ?? null, kind: definition.kind,
            element: definition.element ?? null, unit: definition.unit ?? null,
            subsumable: Boolean(buff.subsumable), augments: buff.augments ?? [],
            note: definition.note ?? null, augmentOnly: Boolean(definition.augment),
          };
        }));
        break;
      }
      for (const buff of availableBuffs(snapshot)) {
        const definition = BUFFS.find((b) => b.id === buff.id)!;
        const ability = snapshot.abilities[definition.ability];
        console.log(
          `${buff.id.padEnd(18)} ${buff.frame.padEnd(10)} ${String(ability.value ?? '-').padStart(5)}  ` +
            `${definition.kind.padEnd(18)}${buff.augments ? '(augment)' : buff.subsumable ? '(subsumable)' : ''}  ${definition.note ?? ''}`,
        );
      }
      console.log(`\n${BUFFS.length} buff(s) modelled. Use --buff <id> --strength <percent>.`);
      break;
    }
    case 'arcanes': {
      const query = (args.positional[1] ?? args.positional[0] ?? '').toLowerCase();
      const list = Object.values(snapshot.arcanes).filter((a) => a.slot && a.slot !== 'warframe' && a.name.toLowerCase().includes(query));
      const sortedArcanes = list.sort((a, b) => a.name.localeCompare(b.name));
      if (wantsJson(args)) {
        emitJson(sortedArcanes.map((a) => ({
          name: a.name, slot: a.slot, maxRank: a.maxRank, rarity: a.rarity,
          description: a.description,
          effects: a.effects.map((e) => ({ target: e.target, op: e.op, value: e.value, condition: e.condition ?? null })),
        })));
        break;
      }
      for (const arcane of sortedArcanes) {
        console.log(`${arcane.name.padEnd(26)} ${String(arcane.slot).padEnd(10)} R${arcane.maxRank}  ${arcane.description.slice(0, 60)}`);
      }
      console.log(`\n${list.length} weapon arcane(s)`);
      break;
    }
    case 'search': {
      const item = requireWeapon(snapshot, args.positional[0] ?? '');
      const base = buildFromArgs(snapshot, args, []);
      const commaList = (name: string): string[] =>
        flagAll(args, name).flatMap((entry) => entry.split(',')).map((entry) => entry.trim()).filter(Boolean);
      const request = {
        weapon: item.name,
        objective: (flag(args, 'objective') as 'ttk' | 'dps' | undefined) ?? 'ttk',
        enemy: flag(args, 'enemy') ?? 'Bombard',
        level: flag(args, 'level') ? Number(flag(args, 'level')) : 150,
        capacity: flag(args, 'capacity') ? Number(flag(args, 'capacity')) : 60,
        maxForma: flag(args, 'forma') ? Number(flag(args, 'forma')) : null,
        exclude: commaList('exclude'),
        mustInclude: commaList('must'),
        limit: flag(args, 'top') ? Number(flag(args, 'top')) : 3,
        budget: flag(args, 'budget') ? Number(flag(args, 'budget')) : undefined,
        chooseIncarnon: commaList('incarnon').includes('auto'),
        chooseArcane: commaList('arcane').some((name) => name.toLowerCase() === 'auto'),
        simulate: !args.flags.has('no-sim'),
        ...targetScale(args),
        attenuation: attenuationFromArgs(args),
        base: commaList('incarnon').includes('auto') ? { ...base, incarnon: undefined } : base,
      };
      const result = search(snapshot, request);
      if (wantsJson(args)) {
        emitJson(result);
        break;
      }
      const brief = briefMode(args);
      if (brief !== 'off') {
        if (brief === 'full') {
          console.log(`${result.weapon} vs ${result.enemy} ${result.level}${result.overguard > 0 ? ` (overguard ${num(result.overguard)})` : ''} · ${result.builds.length} of ${result.evaluated} builds`);
        }
        result.builds.forEach((build, index) => {
          const ttk = build.timeToKill === null ? 'cannot kill' : `${num(build.timeToKill, 2)}s`;
          const facts = [
            `${num(build.totalDps)} dps`,
            ...(result.overguard > 0 ? [`overguard ${num(result.overguard)}`] : []),
            ...(result.attenuation ? [`attenuation ${result.attenuation.id}`] : []),
            ...(build.arcanes.length ? [`arcane ${build.arcanes.map((arcane) => arcane.name).join(' + ')}`] : []),
            ...(build.conditionalMods.length ? [`conditional ${build.conditionalMods.join(', ')}`] : []),
            ...(build.incarnonNames.length ? [`incarnon ${build.incarnonNames.join(' + ')}`] : []),
            ...(build.partialMods.length ? ['lower bound'] : []),
          ];
          console.log(`${index + 1}. ${ttk} · ${facts.join(' · ')} · ${build.formaNeeded}F · ${build.capacityUsed}/${build.capacity} cap`);
          console.log(`   ${build.mods.map((mod) => `${mod.name}${mod.rank < 99 ? ` R${mod.rank}` : ''}`).join(', ')}`);
        });
        if (brief === 'full' && result.assumptions.length) console.log(`assumptions: ${result.assumptions.join(' · ')}`);
        if (brief === 'full' && result.notes.length) console.log(`notes: ${result.notes.join(' · ')}`);
        break;
      }
      console.log(`${result.weapon} vs ${result.enemy} level ${result.level} — best ${result.builds.length} of ${result.evaluated} builds tried (${result.elapsedMs}ms)\n`);
      result.builds.forEach((build, index) => {
        const ttk = build.timeToKill === null ? 'cannot kill' : `${build.timeToKill.toFixed(2)}s (${Math.ceil(build.shotsToKill ?? 0)} shots)`;
        console.log(`${index + 1}. ${build.timeToKill === null ? '' : `${ttk}  `}${num(build.totalDps, 0)} dps on target (${num(build.sustainedDps, 0)} direct)  crit ${pct(build.critChance)}x${num(build.critMultiplier, 1)}  status ${pct(build.statusChance)}  multishot ${num(build.multishot, 2)}`);
        if (build.arcanes.length) console.log(`   Arcane: ${build.arcanes.map((arcane) => arcane.name).join(', ')}`);
        if (build.conditionalMods.length) console.log(`   Conditional: ${build.conditionalMods.join(', ')} (activate with --stacks/--aiming)`);
        if (build.incarnonNames.length) console.log(`   Incarnon: ${build.incarnonNames.join(' | ')}`);
        console.log(`   capacity ${build.capacityUsed}/${build.capacity}${build.formaNeeded ? ` — ${build.formaNeeded} forma` : ''}${build.partialMods.length ? ` — lower bound: ${build.partialMods.join(', ')}` : ''}`);
        console.log(`   ${build.mods.map((mod) => `${mod.name}${mod.rank < 99 ? ` R${mod.rank}` : ''}`).join(', ')}\n`);
      });
      for (const assumption of result.assumptions) console.log(`· ${assumption}`);
      for (const note of result.notes) console.log(`· ${note}`);
      break;
    }
    case 'bruteforce': {
      const item = requireWeapon(snapshot, args.positional[0] ?? '');
      const base = buildFromArgs(snapshot, args, []);
      const commaList = (name: string): string[] =>
        flagAll(args, name).flatMap((entry) => entry.split(',')).map((entry) => entry.trim()).filter(Boolean);
      const numeric = (name: string): number | undefined => {
        const raw = flag(args, name);
        if (raw === undefined) return undefined;
        const value = Number(raw);
        if (!Number.isFinite(value) || value < 0) throw new CliError(`--${name} expects a non-negative number`, 'invalid_argument');
        return value;
      };
      const objective = flag(args, 'objective') ?? 'ttk';
      if (objective !== 'ttk' && objective !== 'dps') throw new CliError('--objective must be ttk or dps', 'invalid_argument');
      if (commaList('incarnon').includes('auto')) {
        throw new CliError('bruteforce takes the Incarnon evolutions as input: --incarnon "EVO2:0,EVO4:1" (see `wfcalc incarnon`)', 'invalid_argument');
      }
      const showProgress = !wantsJson(args) && briefMode(args) === 'off' && process.stderr.isTTY;
      const result = await bruteForce(snapshot, {
        weapon: item.name,
        objective,
        enemy: resolveEnemy(snapshot, args).enemy.name,
        level: numeric('level') ?? 150,
        capacity: numeric('capacity') ?? 60,
        maxForma: numeric('forma') ?? null,
        fixed: commaList('fixed').map(parseModArg),
        exclude: commaList('exclude'),
        pool: numeric('pool'),
        maxEvaluations: numeric('max-evals'),
        limit: numeric('top') ?? 5,
        workers: numeric('workers'),
        simulate: !args.flags.has('no-sim'),
        ...targetScale(args),
        attenuation: attenuationFromArgs(args),
        base: { ...base, mods: [] },
        onProgress: showProgress
          ? (done, total) => process.stderr.write(`\r  ${num(done, 0)} / ~${num(total, 0)} combinations`)
          : undefined,
      });
      if (showProgress) process.stderr.write('\r\x1b[K');
      if (wantsJson(args)) {
        emitJson(result);
        break;
      }
      const modList = (build: (typeof result.builds)[number]): string =>
        [...build.mods.map((mod) => `${mod.fixed ? '*' : ''}${mod.name}${mod.name === 'Riven' ? ` (${build.riven.join(', ')})` : mod.rank < 99 ? ` R${mod.rank}` : ''}`),
          ...(build.exilus ? [`*${build.exilus.name} R${build.exilus.rank} (exilus)`] : [])].join(', ');
      const target = `${result.enemy} lv${result.level}${result.steelPath ? ' Steel Path' : ''}`;
      if (briefMode(args) !== 'off') {
        result.builds.forEach((build, index) => {
          const ttk = build.timeToKill === null ? 'cannot kill' : `${num(build.timeToKill, 2)}s`;
          console.log(`${index + 1}. ${ttk} · ${num(build.totalDps)} dps · ${build.formaNeeded}F · ${build.capacityUsed}/${build.capacity} cap · ${modList(build)}`);
        });
        if (briefMode(args) === 'full') console.log(`${result.weapon} vs ${target} · ${result.exhaustive ? 'exhaustive' : `shortlist ${result.candidates.length}`} · ${num(result.combinations, 0)} combinations`);
        break;
      }
      console.log(`${result.weapon} vs ${target}  —  hp ${num(result.health, 0)}  shields ${num(result.shield, 0)}  armor ${num(result.armor, 0)}${result.overguard > 0 ? `  overguard ${num(result.overguard, 0)}` : ''}`);
      console.log(`${num(result.combinations, 0)} combinations, ${num(result.evaluated, 0)} builds scored on ${result.workers} thread(s) in ${(result.elapsedMs / 1000).toFixed(1)}s`
        + ` — ${result.exhaustive ? `exhaustive over all ${result.candidates.length} candidate mods` : `exhaustive over a shortlist of ${result.candidates.length}`}\n`);
      result.builds.forEach((build, index) => {
        const ttk = build.timeToKill === null ? 'cannot kill' : `${build.timeToKill.toFixed(2)}s (${Math.ceil(build.shotsToKill ?? 0)} shots)`;
        console.log(`${index + 1}. ${ttk}  ${num(build.totalDps, 0)} dps on target (${num(build.sustainedDps, 0)} direct)  crit ${pct(build.critChance)}x${num(build.critMultiplier, 1)}  status ${pct(build.statusChance)}  multishot ${num(build.multishot, 2)}`);
        console.log(`   elements ${build.elements.slice(0, 4).map((entry) => `${entry.type} ${pct(entry.share)}`).join(', ')}`);
        console.log(`   capacity ${build.capacityUsed}/${build.capacity}${build.formaNeeded ? ` — ${build.formaNeeded} forma` : ''}`);
        console.log(`   ${modList(build)}\n`);
      });
      if (result.builds.some((build) => build.mods.some((mod) => mod.fixed) || build.exilus)) console.log('* fixed mod');
      for (const assumption of result.assumptions) console.log(`· ${assumption}`);
      for (const note of result.notes) console.log(`· ${note}`);
      if (!result.exhaustive && result.leftOut.length) console.log(`· Left out: ${result.leftOut.join(', ')}`);
      break;
    }
    case 'abilities': {
      const query = (args.positional[0] ?? '').toLowerCase();
      const list = Object.values(snapshot.damageAbilities ?? {}).filter(
        (ability) => !query || ability.ability.toLowerCase().includes(query) || ability.frame.toLowerCase().includes(query),
      );
      if (wantsJson(args)) {
        emitJson(list);
        break;
      }
      for (const ability of list.sort((a, b) => a.frame.localeCompare(b.frame) || a.ability.localeCompare(b.ability))) {
        const strip = ability.armorStrip
          ? `strip ${ability.armorStrip.value}${ability.armorStrip.mode === 'percent' ? '%' : 'pts'}`
          : '';
        console.log(`${ability.frame.padEnd(11)} ${ability.ability.padEnd(22)} ${String(ability.baseDamage ?? '-').padStart(6)} ${String(ability.damageType ?? '-').padEnd(12)} r=${String(ability.radius ?? '-').padEnd(5)} ${strip}`);
      }
      console.log(`\n${list.length} damage ability(ies)`);
      break;
    }
    case 'ability': {
      const name = args.positional[0] ?? '';
      let result;
      try {
        result = abilityCast(snapshot, name, {
          strength: flag(args, 'strength') ? Number(flag(args, 'strength')) : 100,
          enemy: flag(args, 'enemy'),
          level: flag(args, 'level') ? Number(flag(args, 'level')) : 30,
          viralStacks: flag(args, 'viral') ? Number(flag(args, 'viral')) : undefined,
          targets: flag(args, 'targets') ? Number(flag(args, 'targets')) : undefined,
          mode: flag(args, 'ability-mode'),
          distance: flag(args, 'ability-distance') ? Number(flag(args, 'ability-distance')) : undefined,
          ...targetScale(args),
        });
      } catch (error) {
        const message = (error as Error).message;
        throw new CliError(message, /not found/.test(message) ? 'ability_not_found' : 'error');
      }
      if (wantsJson(args)) {
        emitJson(result);
        break;
      }
      const brief = briefMode(args);
      if (brief !== 'off') {
        console.log(abilityBriefLine(result, brief));
        break;
      }
      const damageTypes = [...new Set(result.damageComponents.map((component) => component.type))];
      console.log(`${result.frame} — ${result.ability} (${damageTypes.length ? damageTypes.join('+') : result.damageType ?? 'no damage'})${result.mode ? ` · ${result.mode} mode` : ''}`);
      const per = result.perSecond ? '/s' : '';
      console.log(`  ${num(result.baseDamage, 0)}${per} at 100% strength -> ${num(result.scaledDamage, 0)}${per} at ${result.strength}%`);
      if (result.perSecond && result.durationSeconds) {
        console.log(`  ticks for ${result.durationSeconds}s: ${num(result.scaledDamage * result.durationSeconds, 0)} in total`);
      }
      if (result.ticks) {
        console.log(`  plus ${num(result.ticks.perSecond, 0)}/s ${result.ticks.damageType ?? ''} for ${result.ticks.seconds}s: ${num(result.ticks.perSecond * result.ticks.seconds, 0)}`);
        console.log(`  full cast: ${num(result.totalDamage, 0)}`);
      }
      if (result.target) {
        console.log(`  vs ${result.target.enemy} level ${result.target.level}: ${num(result.target.perCast, 0)} per cast`);
        console.log(`  health modifier x${result.target.healthMultiplier.toFixed(2)}, armour removes ${(result.target.armorReduction * 100).toFixed(1)}%`);
        if (result.target.statusPerCast > 0) {
          const procs = result.target.statusProcs
            .filter((proc) => proc.total > 0)
            .map((proc) => `${proc.stacks}x ${proc.type}`);
          console.log(`  status       +${num(result.target.statusPerCast)} per cast (${procs.join(', ')})`);
        }
        if (result.target.viralStacks > 0) {
          console.log(`  viral        ${result.target.viralStacks} stack(s) on the target`);
        }
        if (result.target.corrosiveStacks > 0) {
          console.log(`  corrosive    ${result.target.corrosiveStacks} stack(s), ${((1 - result.target.corrosiveArmorMultiplier) * 100).toFixed(0)}% armour strip at the end`);
        }
        if (result.distance > 0) {
          console.log(`  distance     ${result.distance} m, damage x${result.distanceFactor.toFixed(2)}`);
        }
        if (result.target.shield > 0 && !result.target.bypassesShield) {
          console.log(`  shields      ${num(result.target.shield)} (${num(result.target.shieldPerCast)}/cast)`);
        }
        if (result.target.targets > 1) {
          console.log(`  targets      ${result.target.targets} -> ${num(result.target.totalPerCast)} per cast`);
        }
        if (result.target.overguard > 0) {
          console.log(`  overguard    ${num(result.target.overguard)} (${num(result.target.overguardPerCast)}/cast)`);
        }
        if (result.target.castsToKill !== null) console.log(`  casts to kill: ${result.target.castsToKill}`);
      }
      for (const note of result.notes) console.log(`· ${note}`);
      break;
    }
    case 'calc': {
      report(snapshot, args, modsFromArgs(args), 'build');
      break;
    }
    case 'compare': {
      const setups = flagAll(args, 'vs');
      const base = modsFromArgs(args);
      if (setups.length === 0) {
        // Default comparison: no mods, then each single element mod.
        report(snapshot, args, base, 'current build');
        for (const mod of ['Hellfire', 'Cryo Rounds', 'Infected Clip', 'Stormbringer']) {
          if (findMod(snapshot, mod).item) report(snapshot, args, [...base, parseModArg(mod)], `+${mod}`);
        }
      } else {
        for (const setup of setups) {
          const extra = setup.split(',').map((s) => s.trim()).filter(Boolean).map(parseModArg);
          report(snapshot, args, [...base, ...extra], [...base, ...extra].map((m) => m.name).join(' + '));
        }
      }
      break;
    }
    case 'batch': {
      // One process, one line per calculation. Input is JSONL: a calc record (the same fields
      // as POST /api/calc) or an ability record with "ability". Output is always line-oriented;
      // --json gives compact JSONL, not the full single-build report.
      const file = args.positional[0] ?? '-';
      let text: string;
      try {
        text = readFileSync(file === '-' ? 0 : file, 'utf8');
      } catch (error) {
        throw new CliError(`cannot read batch file ${file}: ${(error as Error).message}`, 'invalid_argument');
      }
      const jsonOut = wantsJson(args);
      const mode = briefMode(args) === 'answer' ? 'answer' : 'full';
      let failed = 0;
      let row = 0;
      const emitError = (label: string, error: unknown): void => {
        failed++;
        const message = error instanceof Error ? error.message : String(error);
        const code = error instanceof CliError ? error.code : 'error';
        const suggestions = error instanceof CliError ? error.suggestions : [];
        if (jsonOut) {
          console.log(JSON.stringify({ label, error: { code, message, ...(suggestions.length ? { suggestions } : {}) } }));
        } else {
          console.log(`${label}: error: ${message}${suggestions.length ? ` (did you mean: ${suggestions.join(', ')}?)` : ''}`);
        }
      };
      for (const line of text.split(/\r?\n/)) {
        row++;
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        let record: any;
        try {
          record = JSON.parse(trimmed);
        } catch (error) {
          emitError(`#${row}`, new CliError(`invalid JSON: ${(error as Error).message}`, 'invalid_argument'));
          continue;
        }
        const label = typeof record.label === 'string' && record.label ? record.label : `#${row}`;
        try {
          if (record.ability) {
            let cast;
            try {
              cast = abilityCast(snapshot, String(record.ability), {
                strength: record.strength ?? record.abilityStrength ?? 100,
                enemy: record.enemy,
                level: record.level,
                viralStacks: record.viral !== undefined ? Number(record.viral) : undefined,
                targets: record.targets !== undefined ? Number(record.targets) : undefined,
                mode: record.abilityMode,
                distance: record.distance !== undefined ? Number(record.distance) : undefined,
                eximus: Boolean(record.eximus),
                overguard: record.overguard !== undefined ? Number(record.overguard) : undefined,
                steelPath: Boolean(record.steelPath),
              });
            } catch (error) {
              const message = (error as Error).message;
              throw new CliError(message, /not found/.test(message) ? 'ability_not_found' : 'error');
            }
            if (jsonOut) {
              console.log(JSON.stringify({
                label, frame: cast.frame, ability: cast.ability, damageType: cast.damageType,
                strength: cast.strength, scaledDamage: cast.scaledDamage, perSecond: cast.perSecond,
                totalDamage: cast.totalDamage, target: cast.target, armorStrip: cast.armorStrip,
                notes: cast.notes,
              }));
            } else {
              console.log(`${label}: ${abilityBriefLine(cast, mode)}`);
            }
            continue;
          }
          const weapon = requireWeapon(snapshot, String(record.weapon ?? ''));
          const build = buildFromJson(snapshot, record, weapon.name);
          const resolved = resolveBuild(snapshot, build);
          const enemyName = String(record.enemy ?? 'Bombard');
          const { item: enemy, suggestions } = findEnemy(snapshot, enemyName);
          if (!enemy) throw new CliError(`enemy not found: ${enemyName}`, 'enemy_not_found', suggestions);
          const level = record.level === undefined ? 100 : Number(record.level);
          const hit = hitEnemy(snapshot, resolved, scaleEnemy(snapshot, enemy, level, {
            eximus: Boolean(record.eximus),
            overguard: record.overguard !== undefined ? Number(record.overguard) : undefined,
            steelPath: Boolean(record.steelPath),
          }), {
            simulate: record.simulate !== false,
            targets: record.targets !== undefined ? Number(record.targets) : undefined,
            attenuation: record.attenuation ?? (record.mdpt !== undefined || record.mdps !== undefined
              ? {
                  id: 'custom',
                  mdpi: record.mdpt !== undefined ? Number(record.mdpt) : undefined,
                  mdps: record.mdps !== undefined ? Number(record.mdps) : undefined,
                  flatDr: record.flatDr !== undefined ? Number(record.flatDr) : undefined,
                  statusDr: record.statusDr !== undefined ? Number(record.statusDr) : undefined,
                }
              : undefined),
          });
          const fit = capacityOf(snapshot, resolved.weapon, build.mods, record.capacity === undefined ? 60 : Number(record.capacity), build.riven);
          if (jsonOut) {
            // Rounded on purpose: a batch line is for comparing, and full float noise costs
            // tokens without adding information.
            const round = (value: number | null, digits: number) => (value === null ? null : Number(value.toFixed(digits)));
            console.log(JSON.stringify({
              label, weapon: resolved.weapon.name, enemy: enemy.name, level,
              burstDps: round(resolved.burstDps, 1), sustainedDps: round(resolved.sustainedDps, 1),
              totalDps: round(hit.totalDps, 1), timeToKill: round(hit.timeToKill, 2),
              shotsToKill: round(hit.shotsToKill, 1),
              arcanes: (build.arcanes ?? []).map((entry) => (typeof entry === 'string' ? { name: entry } : { name: entry.name, rank: entry.rank })),
              armor: round(hit.armor, 1), overguard: round(hit.overguard, 1),
              attenuation: hit.attenuation ? { id: hit.attenuation.id, mdpi: round(hit.attenuation.mdpi, 0), mdps: round(hit.attenuation.mdps, 0) } : null,
              multiTargetDps: hit.multiTargetDps === null ? null : round(hit.multiTargetDps, 1),
              multiTargetFactor: round(hit.multiTargetFactor, 3),
              capacityUsed: fit.capacityUsed, capacity: fit.capacity,
              formaNeeded: fit.formaNeeded, fits: fit.fits,
              warnings: [...resolved.warnings, ...hit.warnings], unsupportedMods: resolved.unsupportedMods,
            }));
          } else {
            console.log(`${label}: ${calcBriefLine(
              '', resolved, hit, enemy.name, level, mode, fit,
              (build.arcanes ?? []).map((entry) => (typeof entry === 'string' ? { name: entry } : { name: entry.name, rank: entry.rank })),
            )}`);
          }
        } catch (error) {
          emitError(label, error);
        }
      }
      if (failed) process.exitCode = 1;
      break;
    }
    default:
      console.log(`wfcalc — offline Warframe damage calculator

  wfcalc weapons [query]                search weapons
  wfcalc mods <weapon> [query]          mods that fit a weapon
  wfcalc arcanes [query]                weapon arcanes
  wfcalc buffs                          warframe buffs modelled
  wfcalc incarnon <weapon>              list Incarnon evolution options
  wfcalc rivens [query]                 riven attribute ids
  wfcalc enemies [query]                search enemies
  wfcalc calc <weapon> [options]        damage report
  wfcalc search <weapon> [options]      find the best build for a target
  wfcalc bruteforce <weapon> [options]  try every mod combination for a target
  wfcalc abilities [query]              abilities that deal damage
  wfcalc ability <name> [options]       damage per cast of one ability
  wfcalc compare <weapon> --vs a,b      compare setups
  wfcalc batch <file|->                 JSONL of calculations, one line each (default stdin)
  wfcalc serve                          web UI + JSON API (see docs/api.md)

Options: --mod NAME[:R<rank>]  --arcane NAME[:R<rank>] (search: auto)  --buff roar,eclipse
         --frame Rhino  --frame-mods "Intensify,Blind Rage"  --frame-arcane "Molt Augmented"
         --strength 284  --riven damage,multishot
         --incarnon "EVO2:0,EVO4:1"  --riven-roll 1.05
         --incarnon form           use the transformed profile with no evolution perks
         --element-bonus toxin:60   (Kuva/Tenet/Coda bonus element; default heat:60, none = off)
         --covenant-damage 4000    (damage prevented for Harrow's Covenant)
         --viral 10  --corrosive 10  (status debuffs on the target)
         --armor-strip 60            (percent of the target's armour removed)
         --strip-from "Avalanche"    (take the strip from an ability, at --strength)
         --cp 2                      (Corrosive Projections in the squad, 18% each)
         --shattering-impact 30      (melee hits that chipped the target's base armour)
         --combo-hits 220  --heavy   (melee combo multiplier / heavy attack)
         --aoe-distance 4            (AoE falloff distance in metres)
         --capacity 30|60            (Orokin Catalyst: 60, default)
         --enemy NAME  --level N  --faction NAME  --mode "Name"
         --eximus                     target is an Eximus (raised base health/shields + Overguard)
         --steel-path                 Steel Path target: health and shields x2.5
                                      (--level is the actual enemy level, i.e. node level + 100)
         --overguard N                explicit Overguard amount
         --attenuation archon|eidolon|custom   boss damage caps (Eidolons are automatic)
         --mdpt N --mdps N            explicit caps per hit / per second (implies custom)
         --flat-dr 20 --status-dr 50  flat and status damage reduction, in percent
         --stacks onKill=5
         --extra-status-types N       status types other sources keep on the target; each build
                                      adds its own (Galvanized Aptitude, Condition Overload)
         --status-types N             fix the total instead
         --stacks none|max            every conditional effect off, or on at its cap (DE's
                                      "Stacks up to Nx"; weak-point ones only with --hit head)
         --source-stacks "Primary Merciless=6,Galvanized Chamber=max"   per mod/arcane/buff
         --hit head|body              where shots land (default body); --headshot, --bodyshot
         --shards "crimson:primaryStatus,violet:primaryElectricity:tau"   Archon Shards (up to 5)
         --zoom N|max  --sniper-combo N   sniper zoom level buff and Shot Combo Counter
         --riven "crit-chance=142.3,multishot=110.2,-zoom=40.1"   the card's own values
                                      (x1.24 for faction stats); a bare id estimates the value
         --riven-drain 18 --riven-polarity madurai   the riven's slot cost (counts in capacity; default 16)
         --no-sim                     steady-state statuses instead of the fight simulation
         --brief one line per result        --brief=answer answer only
         --json machine-readable output      --debug stack trace on failure

Ability options:
         --strength N          Ability Strength (100 = unmodded)
         --viral N             Viral stacks already on the target
         --targets N           enemies hit by one ability cast (default 1)
         --ability-mode heat   alternative ability mode (Thermal Sunder)
         --ability-distance N  distance from the cast point (Discharge falloff)
         --enemy NAME --level N  apply the target's modifiers and armour

Search options:
         --objective ttk|dps   (default ttk: kill the target fastest)
         --capacity 30|60      (default 60, i.e. with an Orokin Catalyst)
         --forma N             maximum Forma the search may spend
         --must "A,B"          mods that must be in the build
         --exclude "A,B"       mods the player does not own
         --top N               how many builds to return (default 3)
         --incarnon auto       also choose the Incarnon evolutions for the weapon
         --incarnon "EVO2:0"   use these evolutions instead
         --budget N            evaluation budget (default 12000)

Brute-force options (also: --objective --capacity --forma --exclude, and every build option;
buffs, --strength, --incarnon and --arcane are fixed inputs, not searched):
         --fixed "A,B:R3"      mods always equipped (an Exilus mod goes in the Exilus slot)
         --top N               how many builds to return (default 5)
         --max-evals N         combination budget; decides the shortlist (default 2000000)
         --pool N              force a shortlist of N candidate mods
         --workers N           threads (default: every core)`);
  }
}

async function run(): Promise<void> {
  try {
    await main();
  } catch (error) {
    const args = parseArgs(process.argv.slice(2));
    const message = error instanceof Error ? error.message : String(error);
    const code = error instanceof CliError || error instanceof InputError ? error.code : 'error';
    const suggestions = error instanceof CliError || error instanceof InputError ? error.suggestions : [];
    if (wantsJson(args)) {
      console.error(JSON.stringify({ error: { code, message, ...(suggestions.length ? { suggestions } : {}) } }));
    } else {
      console.error(`error: ${message}${suggestions.length ? ` (did you mean: ${suggestions.join(', ')}?)` : ''}`);
    }
    if (args.flags.has('debug') && error instanceof Error && error.stack) console.error(error.stack);
    process.exitCode = error instanceof CliError || error instanceof InputError ? 2 : 1;
  }
}

void run();
