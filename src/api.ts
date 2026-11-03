/**
 * The JSON API as a plain function, (method, url, body) -> reply: the Node server (server.ts) and
 * the GitHub Pages build (a Web Worker, src/pages/api-worker.ts) both answer through it, so the
 * two cannot drift apart. See docs/api.md for the endpoints.
 */
import { findEnemy, findWeapon, loadSnapshot, modsForWeapon } from './data.ts';
import { arcaneSlotsOf, hasBonusElement, resolveBuild, type Build } from './engine/build.ts';
import { scaleEnemy } from './engine/enemy.ts';
import { hitEnemy, statusProcs } from './engine/damage.ts';
import { availableBuffs } from './engine/buffs.ts';
import { search, type SearchRequest } from './engine/search.ts';
import { modularParts } from './engine/modular.ts';
import { partSearch } from './engine/part-search.ts';
import type { ModularKind, WeaponData } from './types.ts';
import { bruteForce, bruteForceFromCombinations, warmExactPool, type BruteForceRequest } from './engine/bruteforce.ts';
import { gpuModel } from './engine/gpu-model.ts';
import { rivenGpuModel, rivenPicker, type RivenPickerRequest } from './engine/riven-picker.ts';
import { SHARD_BONUSES } from './engine/shards.ts';
import { RIVEN_ATTRIBUTES } from './engine/riven.ts';
import { abilityCast } from './engine/ability.ts';
import { buildFromJson } from './request.ts';
import { InputError } from './errors.ts';
import { capacityOf } from './engine/capacity.ts';

export const snapshot = loadSnapshot();

/** Artwork the snapshot lacks, filled in by server.ts from the raw exports when they are present. */
export const art = { mod: new Map<string, string>(), weapon: new Map<string, string>(), stance: new Map<string, string>() };
const imageNameOf = (modName: string): string | null => snapshot.mods[modName]?.image ?? art.mod.get(modName) ?? null;

export interface ApiReply {
  status: number;
  body: unknown;
  /** The last line of an NDJSON stream whose progress lines went through ApiIo.progress. */
  stream?: boolean;
}
export interface ApiIo {
  /** Aborted when the caller goes away (closed connection, stop button). */
  signal?: AbortSignal;
  progress?: (line: unknown) => void;
}
const reply = (status: number, body: unknown): ApiReply => ({ status, body });
/** The caller stopped the request: nothing to send. */
const GONE: ApiReply = { status: 0, body: null };

const objectiveOf = (value: unknown): 'ttk' | 'dps' | 'kpm' => (value === 'dps' || value === 'kpm' ? value : 'ttk');

/** A brute-force request from a JSON body (the Find tab's shape), or the weapon-not-found reply. */
function bruteForceRequestFrom(body: any): BruteForceRequest | { error: string; suggestions: string[] } {
  const { item: weapon, suggestions } = findWeapon(snapshot, body.weapon ?? '');
  if (!weapon) return { error: `weapon not found: ${body.weapon ?? ''}`, suggestions };
  const asList = (value: unknown): string[] =>
    Array.isArray(value) ? value.map(String) : typeof value === 'string' ? value.split(',').map((v) => v.trim()).filter(Boolean) : [];
  // Mods are searched; everything else (buffs, Incarnon, arcanes, riven) is the player's input.
  const baseSource = body.base && typeof body.base === 'object' ? body.base : body;
  const base = { ...buildFromJson(snapshot, baseSource, weapon.name), mods: [] };
  const fixed = Array.isArray(body.fixed)
    ? body.fixed.map((entry: unknown) => (typeof entry === 'string' ? { name: entry } : entry))
    : asList(body.fixed).map((name) => ({ name }));
  // The Incarnon form is never chosen for the player: a weapon that has one needs form "normal"
  // or "incarnon" in the request.
  if (weapon.incarnonForm) {
    if (body.form !== 'normal' && body.form !== 'incarnon') {
      throw new InputError(`${weapon.name} has an Incarnon form: send form "normal" or "incarnon"`, 'choose_form');
    }
    const picks = (base.incarnon ?? []).filter((choice: string) => choice.toLowerCase() !== 'form');
    base.incarnon = body.form === 'incarnon' ? [...picks, 'form'] : picks;
  }
  return {
    weapon: weapon.name,
    objective: objectiveOf(body.objective),
    enemy: body.enemy ?? 'Bombard',
    level: body.level !== undefined ? Number(body.level) : 150,
    steelPath: Boolean(body.steelPath),
    eximus: Boolean(body.eximus),
    overguard: body.overguard !== undefined ? Number(body.overguard) : undefined,
    attenuation: body.attenuation,
    capacity: body.capacity !== undefined ? Number(body.capacity) : 60,
    maxForma: body.maxForma === null || body.maxForma === undefined ? null : Number(body.maxForma),
    fixed,
    exclude: asList(body.exclude),
    requireStatus: asList(body.requireStatus),
    pool: body.pool !== undefined ? Number(body.pool) : undefined,
    maxEvaluations: body.maxEvaluations !== undefined ? Number(body.maxEvaluations) : undefined,
    allCombinations: body.allCombinations === true,
    simulate: body.simulate !== false,
    limit: body.limit !== undefined ? Number(body.limit) : 5,
    base,
  };
}

/** A riven-picker request from the Riven tab's body (the Build tab's state), or the weapon-not-found reply. */
function rivenRequestFrom(body: any): RivenPickerRequest | { error: string; suggestions: string[] } {
  const { item: weapon, suggestions } = findWeapon(snapshot, body.weapon ?? '');
  if (!weapon) return { error: `weapon not found: ${body.weapon ?? ''}`, suggestions };
  const build = buildFromJson(snapshot, body, weapon.name);
  const incarnon = (build.incarnon ?? []).filter((choice) => choice.toLowerCase() !== 'form');
  // The Incarnon form is never chosen for the player.
  if (weapon.incarnonForm) {
    if (body.form !== 'normal' && body.form !== 'incarnon') {
      throw new InputError(`${weapon.name} has an Incarnon form: send form "normal" or "incarnon"`, 'choose_form');
    }
    if (body.form === 'incarnon') incarnon.push('form');
  }
  return {
    weapon: weapon.name,
    mods: (build.mods ?? []).map((mod) => (typeof mod === 'string' ? { name: mod } : mod)).filter((mod) => mod.name && mod.name !== 'Riven'),
    fixed: Array.isArray(body.fixed) ? body.fixed.filter((mod: any) => typeof mod?.name === 'string').map((mod: any) => ({ name: mod.name, rank: mod.rank })) : [],
    base: { ...build, incarnon, mods: [] },
    enemy: body.enemy ?? 'Bombard',
    level: body.level !== undefined ? Number(body.level) : 150,
    steelPath: Boolean(body.steelPath),
    eximus: Boolean(body.eximus),
    objective: objectiveOf(body.objective),
    limit: body.limit !== undefined ? Math.max(1, Math.min(1000, Number(body.limit))) : 200,
    stats: Array.isArray(body.stats) ? body.stats.map(String).slice(0, 3) : undefined,
    malus: typeof body.malus === 'string' && body.malus ? body.malus : undefined,
  };
}

/** Runs a build and returns everything the UI needs to render a report. */
function calculate(body: any) {
  const weaponQuery: string = body.weapon ?? '';
  const { item: weapon, suggestions } = findWeapon(snapshot, weaponQuery);
  if (!weapon) return { error: `weapon not found: ${weaponQuery}`, suggestions };

  let build: Build;
  try {
    build = buildFromJson(snapshot, body, weapon.name);
  } catch (error) {
    return { error: String((error as Error).message) };
  }
  let resolved: ReturnType<typeof resolveBuild>;
  try {
    resolved = resolveBuild(snapshot, build);
  } catch (error) {
    const code = error instanceof InputError ? error.code : undefined;
    return { error: String((error as Error).message), ...(code ? { code } : {}) };
  }
  const capacity = capacityOf(snapshot, weapon, build.mods, body.capacity !== undefined ? Number(body.capacity) : 60, build.riven);

  let target = null;
  let hitWarnings: string[] = [];
  if (body.enemy) {
    const { item: enemy, suggestions: enemySuggestions } = findEnemy(snapshot, body.enemy);
    if (!enemy) return { error: `enemy not found: ${body.enemy}`, suggestions: enemySuggestions };
    const scaled = scaleEnemy(snapshot, enemy, Number(body.level ?? 100), {
      eximus: Boolean(body.eximus),
      overguard: body.overguard !== undefined ? Number(body.overguard) : undefined,
      steelPath: Boolean(body.steelPath),
    });
    const attenuation = body.attenuation !== undefined
      ? body.attenuation
      : (body.mdpt !== undefined || body.mdps !== undefined
        ? {
            id: 'custom',
            mdpi: body.mdpt !== undefined ? Number(body.mdpt) : undefined,
            mdps: body.mdps !== undefined ? Number(body.mdps) : undefined,
            flatDr: body.flatDr !== undefined ? Number(body.flatDr) / 100 : undefined,
            statusDr: body.statusDr !== undefined ? Number(body.statusDr) / 100 : undefined,
          }
        : undefined);
    const hit = hitEnemy(snapshot, resolved, scaled, {
      attenuation,
      targets: body.targets !== undefined ? Number(body.targets) : undefined,
      simulate: body.simulate !== false,
      input: build,
    });
    hitWarnings = hit.warnings;
    target = { name: enemy.name, faction: enemy.faction, pools: scaled.pools, ...hit };
  }

  // What each mod actually contributes: resolve without it and measure the drop.
  let contributions: Array<{ name: string; deltaDps: number; deltaPct: number }> | null = null;
  if (body.contributions) {
    const mods = Array.isArray(build.mods) ? build.mods : [];
    contributions = mods.map((entry, index) => {
      const name = typeof entry === 'string' ? entry : entry?.name;
      const without = resolveBuild(snapshot, {
        ...build,
        mods: mods.filter((_, position) => position !== index),
      });
      const delta = resolved.burstDps - without.burstDps;
      // A mod whose only effects are conditional is worth 0 until its condition is active;
      // flagging it avoids it looking like a bug.
      const conditional =
        snapshot.mods[name ?? '']?.effects.every((effect) => effect.condition) ?? false;
      return {
        name: name ?? '?',
        deltaDps: delta,
        deltaPct: resolved.burstDps > 0 ? delta / resolved.burstDps : 0,
        conditional,
      };
    });
  }

  return {
    weapon: {
      name: weapon.name,
      type: weapon.type,
      category: weapon.category,
      masteryRank: weapon.masteryRank,
      disposition: weapon.disposition,
      modClasses: weapon.modClasses,
      mode: resolved.mode?.name ?? null,
      modes: weapon.modes.map((m) => m.name),
      hasBonusElement: hasBonusElement(weapon),
    },
    elementBonus: resolved.elementBonus,
    build,
    damage: resolved.damage.perProjectile,
    projectileTotal: resolved.damage.projectileTotal,
    shotDamage: resolved.shotDamage,
    averageShotDamage: resolved.averageShotDamage,
    critChance: resolved.critChance,
    critMultiplier: resolved.critMultiplier,
    statusChance: resolved.statusChance,
    multishot: resolved.multishot,
    fireRate: resolved.fireRate,
    reloadTime: resolved.reloadTime,
    magazineSize: resolved.magazineSize,
    burstDps: resolved.burstDps,
    factionBonus: resolved.factionBonus,
    activeBuffs: resolved.activeBuffs,
    abilityStrength: resolved.abilityStrength,
    riven: resolved.rivenLines,
    traits: resolved.traitLines,
    incarnon: resolved.incarnonLines,
    comboMultiplier: resolved.comboMultiplier,
    critVariance: resolved.critVariance,
    sustainedDps: resolved.sustainedDps,
    arcanes: (build.arcanes ?? []).map((entry) => (typeof entry === 'string' ? { name: entry } : { name: entry.name, rank: entry.rank })),
    capacityUsed: capacity.capacityUsed,
    capacity: capacity.capacity,
    formaNeeded: capacity.formaNeeded,
    fits: capacity.fits,
    elements: resolved.elements,
    procs: statusProcs(resolved),
    contributions,
    warnings: [...resolved.warnings, ...hitWarnings],
    unsupportedMods: resolved.unsupportedMods,
    inactiveConditions: resolved.inactiveConditions,
    conditionalSources: resolved.conditionalSources,
    hitZone: resolved.hitZone,
    target,
  };
}

/** What the client keeps per weapon (/api/weapons, /api/weapon). */
const weaponSummary = (w: WeaponData) => ({
  name: w.name, category: w.category, type: w.type, masteryRank: w.masteryRank,
  // Needed by the client to work out mod capacity and polarity matches.
  polarities: w.polarities, exilusPolarity: w.exilusPolarity, modClasses: w.modClasses,
  trigger: w.trigger ?? null,
  // The Find tab asks for normal or Incarnon form before a search on these.
  incarnonForm: Boolean(w.incarnonForm),
  stancePolarity: w.stancePolarity ?? art.stance.get(w.name) ?? null,
  image: w.image ?? art.weapon.get(w.name) ?? null,
  description: w.description ?? '',
  modular: w.modular ?? null,
});

/** Everything of a /api/search body except the weapon; /api/part-search takes the same. */
function searchOptions(body: any, base: Build): Omit<SearchRequest, 'weapon'> {
  const asList = (value: unknown): string[] =>
    Array.isArray(value) ? value.map(String) : typeof value === 'string' ? value.split(',').map((v) => v.trim()).filter(Boolean) : [];
  const chooseIncarnon = Boolean(body.chooseIncarnon) || body.incarnon === 'auto';
  return {
    objective: objectiveOf(body.objective),
    enemy: body.enemy ?? 'Bombard',
    level: body.level !== undefined ? Number(body.level) : 150,
    capacity: body.capacity !== undefined ? Number(body.capacity) : 60,
    maxForma: body.maxForma === null ? null : body.maxForma !== undefined ? Number(body.maxForma) : undefined,
    exclude: asList(body.exclude),
    mustInclude: asList(body.mustInclude ?? body.must),
    limit: body.limit !== undefined ? Number(body.limit) : 3,
    budget: body.budget !== undefined ? Number(body.budget) : undefined,
    chooseIncarnon,
    chooseArcane: Boolean(body.chooseArcane) || body.arcane === 'auto',
    eximus: Boolean(body.eximus),
    overguard: body.overguard !== undefined ? Number(body.overguard) : undefined,
    steelPath: Boolean(body.steelPath),
    simulate: body.simulate !== false,
    attenuation: body.attenuation !== undefined
      ? body.attenuation
      : (body.mdpt !== undefined || body.mdps !== undefined
        ? { id: 'custom', mdpi: Number(body.mdpt ?? 0), mdps: Number(body.mdps ?? 0) }
        : undefined),
    // Choosing perks keeps the player's form switch.
    base: chooseIncarnon ? { ...base, incarnon: (base.incarnon ?? []).filter((choice) => choice.toLowerCase() === 'form') } : base,
  };
}

/** Answers one API request; null when `url` is not an API endpoint (or not for this method). */
export async function handleApi(method: string, url: URL, body: any, io: ApiIo = {}): Promise<ApiReply | null> {
  try {
    if (url.pathname === '/api/weapons') {
      const list = Object.values(snapshot.weapons).map(weaponSummary).sort((a, b) => a.name.localeCompare(b.name));
      return reply(200, list);
    }
    // One weapon, modular ones included (they are not in /api/weapons: ~3,300 combinations).
    if (url.pathname === '/api/weapon') {
      const query = url.searchParams.get('name') ?? '';
      const { item, suggestions } = findWeapon(snapshot, query);
      return item ? reply(200, weaponSummary(item)) : reply(404, { error: `weapon not found: ${query}`, suggestions });
    }
    if (url.pathname === '/api/enemies') {
      const list = Object.values(snapshot.enemies)
        .map((e) => ({ name: e.name, faction: e.faction, health: e.health, shield: e.shield, armor: e.armor }))
        .sort((a, b) => a.name.localeCompare(b.name));
      return reply(200, list);
    }
    if (url.pathname === '/api/mods') {
      const weaponName = url.searchParams.get('weapon') ?? '';
      const { item } = findWeapon(snapshot, weaponName);
      if (!item) return reply(404, { error: `weapon not found: ${weaponName}` });
      const list = modsForWeapon(snapshot, item)
        .filter((m) => !m.conclave)
        .map((m) => ({
          name: m.name,
          maxRank: m.maxRank,
          polarity: m.polarity,
          description: m.description,
          levels: m.levels,
          partial: m.partial,
          baseDrain: m.baseDrain,
          isExilus: Boolean(m.isExilus),
          rarity: m.rarity,
          set: m.set,
          classes: m.classes,
          conclave: m.conclave,
          image: imageNameOf(m.name),
          card: m.cardImage,
        }))
        .sort((a, b) => a.name.localeCompare(b.name));
      return reply(200, list);
    }
    if (url.pathname === '/api/incarnons') {
      const weaponName = url.searchParams.get('weapon') ?? '';
      const { item } = findWeapon(snapshot, weaponName);
      if (!item) return reply(404, { error: `weapon not found: ${weaponName}` });
      return reply(200, snapshot.incarnons[item.name] ?? []);
    }
    if (url.pathname === '/api/warframes') {
      const list = Object.values(snapshot.warframes)
        .map((frame) => ({ name: frame.name }))
        .sort((a, b) => a.name.localeCompare(b.name));
      return reply(200, list);
    }
    if (url.pathname === '/api/buffs') {
      return reply(200, availableBuffs(snapshot));
    }
    if (url.pathname === '/api/arcanes') {
      const weaponName = url.searchParams.get('weapon') ?? '';
      const { item } = findWeapon(snapshot, weaponName);
      const allowed = item ? arcaneSlotsOf(item) : ['primary', 'secondary', 'melee', 'bow', 'shotgun'];
      const list = Object.values(snapshot.arcanes)
        .filter((arcane) => arcane.slot && allowed.includes(arcane.slot))
        .map((arcane) => ({ name: arcane.name, slot: arcane.slot, maxRank: arcane.maxRank, description: arcane.description }))
        .sort((a, b) => a.name.localeCompare(b.name));
      return reply(200, list);
    }
    if (url.pathname === '/api/search' && method === 'POST') {
      const query: string = body.weapon ?? '';
      const { item: weapon, suggestions } = findWeapon(snapshot, query);
      if (!weapon) return reply(404, { error: `weapon not found: ${query}`, suggestions });
      // The search picks the mods; everything else about the build can still be fixed, either
      // under `base` or at the top level (the shape /api/calc accepts).
      const baseSource = body.base && typeof body.base === 'object' ? body.base : body;
      let base: Build;
      try {
        base = { ...buildFromJson(snapshot, baseSource, weapon.name), mods: [] };
      } catch (error) {
        return reply(400, { error: String((error as Error).message) });
      }
      const result = search(snapshot, { weapon: weapon.name, ...searchOptions(body, base) });
      return reply(200, result);
    }
    if (url.pathname === '/api/modular') {
      return reply(200, snapshot.modular ? modularParts(snapshot.modular) : {});
    }
    if (url.pathname === '/api/part-search' && method === 'POST') {
      const lists = snapshot.modular ? modularParts(snapshot.modular)[body.kind as ModularKind] : undefined;
      if (!lists) return reply(400, { error: `kind must be one of zaw, kitgun-primary, kitgun-secondary, amp` });
      const parts = Array.isArray(body.parts) ? body.parts.slice(0, 3).map((list: unknown) => (Array.isArray(list) ? list.map(String) : null)) : undefined;
      const baseSource = body.base && typeof body.base === 'object' ? body.base : body;
      // Any combination of the kind stands in for buildFromJson's weapon checks (arcane slots...).
      const base = { ...buildFromJson(snapshot, baseSource, lists.map((list) => list[0]).join(' / ')), mods: [] };
      const top = body.top !== undefined ? Math.max(1, Math.min(20, Number(body.top) || 5)) : undefined;
      return reply(200, partSearch(snapshot, { ...searchOptions(body, base), kind: body.kind, parts, top }));
    }
    if (url.pathname === '/api/shards') return reply(200, SHARD_BONUSES);
    if (url.pathname === '/api/frame-mods') {
      // The frame-mods field only counts Ability Strength, so only those mods are worth suggesting.
      return reply(200, Object.values(snapshot.mods)
        .filter((mod) => mod.effects.some((effect) => effect.target === 'abilityStrength'))
        .map((mod) => mod.name).sort());
    }
    if (url.pathname === '/api/riven-stats') return reply(200, RIVEN_ATTRIBUTES.map(({ id, label }) => ({ id, label })));
    if (url.pathname === '/api/snipers') {
      return reply(200, Object.fromEntries(Object.entries(snapshot.snipers ?? {}).map(([name, data]) => [name, {
        minimumCombo: data.minimumCombo,
        zooms: data.zooms.map((zoom) => ({ zoom: zoom.zoom, text: zoom.text })),
      }])));
    }
    // GPU brute force: the model for the browser's pre-filter, then the exact pass on its shortlist.
    if (url.pathname === '/api/bruteforce/gpu-model' && method === 'POST') {
      try {
        const request = bruteForceRequestFrom(body);
        if ('error' in request) return reply(404, request);
        // The exact pass follows in a few seconds: load its threads while the GPU works.
        warmExactPool();
        return reply(200, gpuModel(snapshot, request, body.keep !== undefined ? Math.max(1, Math.min(100_000, Number(body.keep))) : undefined));
      } catch (error) {
        if (error instanceof InputError) return reply(400, { error: error.message, code: error.code });
        throw error;
      }
    }
    if (url.pathname === '/api/bruteforce/gpu-finish' && method === 'POST') {
      if (!Array.isArray(body.combinations) || body.combinations.length > 100_000
        || !body.combinations.every((combo: unknown) => Array.isArray(combo) && combo.every((name) => typeof name === 'string'))) {
        return reply(400, { error: 'combinations: a list of up to 100,000 lists of mod names', code: 'invalid_argument' });
      }
      try {
        const request = bruteForceRequestFrom(body);
        if ('error' in request) return reply(404, request);
        const gpu = body.gpu ?? {};
        return reply(200, await bruteForceFromCombinations(snapshot, request, body.combinations, {
          combinations: Number(gpu.combinations) || 0,
          elapsedMs: Number(gpu.elapsedMs) || 0,
          adapter: typeof gpu.adapter === 'string' ? gpu.adapter.slice(0, 80) : undefined,
          drift: gpu.drift !== undefined ? Number(gpu.drift) : undefined,
        }));
      } catch (error) {
        if (error instanceof InputError) return reply(400, { error: error.message, code: error.code });
        throw error;
      }
    }
    // Riven tab: which build mod each possible riven should replace. The GPU variant fetches a model,
    // scores every riven in the browser, and sends the best back for the exact pass.
    if (url.pathname.startsWith('/api/riven-picker') && method === 'POST') {
      try {
        const request = rivenRequestFrom(body);
        if ('error' in request) return reply(404, request);
        if (url.pathname === '/api/riven-picker/gpu-model') {
          warmExactPool();
          // The browser rebuilds a riven from its four indices and the vector names ("+viral", "-zoom").
          const { rivenSpecs: _specs, ...model } = rivenGpuModel(snapshot, request);
          return reply(200, model);
        }
        if (url.pathname === '/api/riven-picker/gpu-finish') {
          if (!Array.isArray(body.rivens) || body.rivens.length > 20_000) {
            return reply(400, { error: 'rivens: a list of up to 20,000 { stats, malus }', code: 'invalid_argument' });
          }
          const gpu = body.gpu ?? {};
          return reply(200, await rivenPicker(snapshot, {
            ...request,
            rivens: body.rivens.map((riven: any) => ({ stats: Array.isArray(riven?.stats) ? riven.stats.map(String) : [], malus: String(riven?.malus ?? '') })),
            gpu: {
              rivens: Number(gpu.rivens) || 0,
              elapsedMs: Number(gpu.elapsedMs) || 0,
              adapter: typeof gpu.adapter === 'string' ? gpu.adapter.slice(0, 80) : undefined,
              replacedCounts: Object.fromEntries(Object.entries(gpu.replacedCounts ?? {}).map(([name, count]) => [name, Number(count) || 0])),
            },
          }));
        }
        if (url.pathname !== '/api/riven-picker') return reply(404, { error: 'not found' });
        return reply(200, await rivenPicker(snapshot, request));
      } catch (error) {
        if (error instanceof InputError) return reply(400, { error: error.message, code: error.code });
        throw error;
      }
    }
    if (url.pathname === '/api/bruteforce' && method === 'POST') {
      const request = bruteForceRequestFrom(body);
      if ('error' in request) return reply(404, request);
      // `stream: true`: {"progress","total"} lines through io.progress while the leaves are walked
      // (at most every 200 ms), then {"result"} or {"error"} as the last line.
      const stream = body.stream === true;
      let lastSent = 0;
      try {
        const result = await bruteForce(snapshot, {
          ...request,
          // The Find tab's stop button drops the request: stop the worker threads with it.
          signal: io.signal,
          onProgress: stream
            ? (done, total) => {
                const now = Date.now();
                const finished = done >= total;
                if (finished ? lastSent === Infinity : now - lastSent < 200) return;
                lastSent = finished ? Infinity : now;
                io.progress?.({ progress: done, total });
              }
            : undefined,
        });
        return stream ? { status: 200, body: { result }, stream } : reply(200, result);
      } catch (error) {
        if (io.signal?.aborted) return GONE;
        if (!stream) throw error;
        return { status: 200, body: { error: String((error as Error).message), ...(error instanceof InputError ? { code: error.code } : {}) }, stream };
      }
    }
    if (url.pathname === '/api/abilities') {
      // Everything the ability tab and the strip picker need in one list.
      const list = Object.values(snapshot.damageAbilities ?? {})
        .map((ability) => ({
          ability: ability.ability,
          frame: ability.frame,
          damageType: ability.damageType,
          baseDamage: ability.baseDamage,
          perSecond: Boolean(ability.perSecond),
          durationSeconds: ability.durationSeconds ?? null,
          radius: ability.radius,
          armorStrip: ability.armorStrip ?? null,
        }))
        .sort((a, b) => a.frame.localeCompare(b.frame) || a.ability.localeCompare(b.ability));
      return reply(200, list);
    }
    if (url.pathname === '/api/ability') {
      const name = url.searchParams.get('name') ?? '';
      if (!name) return reply(400, { error: 'name is required, e.g. /api/ability?name=Miasma' });
      const strength = url.searchParams.get('strength');
      const level = url.searchParams.get('level');
      try {
        const overguard = url.searchParams.get('overguard');
        const eximus = url.searchParams.get('eximus');
        const result = abilityCast(snapshot, name, {
          strength: strength ? Number(strength) : undefined,
          enemy: url.searchParams.get('enemy') ?? undefined,
          level: level ? Number(level) : undefined,
          eximus: eximus === '1' || eximus === 'true',
          overguard: overguard ? Number(overguard) : undefined,
          steelPath: ['1', 'true'].includes(url.searchParams.get('steelPath') ?? ''),
          viralStacks: url.searchParams.get('viral') ? Number(url.searchParams.get('viral')) : undefined,
          targets: url.searchParams.get('targets') ? Number(url.searchParams.get('targets')) : undefined,
          mode: url.searchParams.get('mode') ?? undefined,
          distance: url.searchParams.get('distance') ? Number(url.searchParams.get('distance')) : undefined,
        });
        return reply(200, result);
      } catch (error) {
        return reply(404, { error: String((error as Error).message) });
      }
    }
    if (url.pathname === '/api/calc' && method === 'POST') {
      const result = calculate(body);
      return reply(result.error ? ('code' in result && result.code ? 400 : 404) : 200, result);
    }
    return null;
  } catch (error) {
    // Bad input from any route (a level of "abc") is the caller's mistake, not a server fault.
    if (error instanceof InputError) return reply(400, { error: error.message, code: error.code });
    throw error;
  }
}
