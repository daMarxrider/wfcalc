#!/usr/bin/env node
/**
 * Local web UI + JSON API.
 *
 *   node src/server.ts [--port 7777] [--host 127.0.0.1]
 *
 * No dependencies: a small http server that serves src/web/ and a handful of
 * JSON endpoints. The API is deliberately plain so that scripts and AI agents can
 * drive it the same way the browser does (see docs/api.md).
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { networkInterfaces } from 'node:os';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { loadSnapshot, findEnemy, findWeapon, modsForWeapon } from './data.ts';
import { ARCANE_SLOTS, hasBonusElement, resolveBuild, type Build } from './engine/build.ts';
import { scaleEnemy } from './engine/enemy.ts';
import { hitEnemy, statusProcs } from './engine/damage.ts';
import { availableBuffs } from './engine/buffs.ts';
import { search } from './engine/search.ts';
import { bruteForce } from './engine/bruteforce.ts';
import { SHARD_BONUSES } from './engine/shards.ts';
import { abilityCast } from './engine/ability.ts';
import { buildFromJson } from './request.ts';
import { InputError } from './errors.ts';
import { capacityOf } from './engine/capacity.ts';

const WEB_ROOT = new URL('./web/', import.meta.url).pathname;
/** Mod artwork cache: fetched once from the WFCD export repo, then served locally. */
const IMG_ROOT = new URL('../data/img/', import.meta.url).pathname;
/** Full in-game card art served by the wiki (frame included), cached the same way. */
const CARD_ROOT = new URL('../data/cards/', import.meta.url).pathname;
const CARD_UPSTREAM = 'https://wiki.warframe.com/w/Special:FilePath';
const IMG_UPSTREAM = 'https://raw.githubusercontent.com/WFCD/warframe-items/master/data/img';
const args = process.argv.slice(2);
const portArg = args.indexOf('--port');
const hostArg = args.indexOf('--host');
const PORT = portArg >= 0 ? Number(args[portArg + 1]) : 7777;
const HOST = hostArg >= 0 ? args[hostArg + 1] : '127.0.0.1';

const snapshot = loadSnapshot();

/** Mod artwork file for WFCD's data/img, read from the export we already have. */
const IMAGE_BY_MOD = (() => {
  const map = new Map<string, string>();
  try {
    const raw = JSON.parse(readFileSync(new URL('../data/raw/wfcd-Mods.json', import.meta.url).pathname, 'utf8')) as any[];
    for (const mod of raw) {
      if (typeof mod?.name === 'string' && typeof mod?.imageName === 'string' && !map.has(mod.name)) {
        map.set(mod.name, mod.imageName);
      }
    }
  } catch {
    /* the export may be absent; the UI just shows no art */
  }
  return map;
})();
const imageNameOf = (modName: string): string | null => snapshot.mods[modName]?.image ?? IMAGE_BY_MOD.get(modName) ?? null;

/** Weapon artwork and melee stance polarity, from the same export. */
const WEAPON_IMAGE = new Map<string, string>();
const WEAPON_STANCE = new Map<string, string>();
for (const file of ['Primary', 'Secondary', 'Melee', 'Arch-Gun', 'Arch-Melee', 'SentinelWeapons']) {
  try {
    const raw = JSON.parse(readFileSync(new URL(`../data/raw/wfcd-${file}.json`, import.meta.url).pathname, 'utf8')) as any[];
    for (const weapon of raw) {
      if (typeof weapon?.name !== 'string') continue;
      if (typeof weapon.imageName === 'string') WEAPON_IMAGE.set(weapon.name, weapon.imageName);
      if (typeof weapon.stancePolarity === 'string') WEAPON_STANCE.set(weapon.name, weapon.stancePolarity);
    }
  } catch {
    /* export missing; the UI degrades to no art */
  }
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(payload);
}

async function readBody(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
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

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  try {
    if (url.pathname === '/api/weapons') {
      const list = Object.values(snapshot.weapons)
        .map((w) => ({
          name: w.name, category: w.category, type: w.type, masteryRank: w.masteryRank,
          // Needed by the client to work out mod capacity and polarity matches.
          polarities: w.polarities, exilusPolarity: w.exilusPolarity, modClasses: w.modClasses,
          trigger: w.trigger ?? null,
          stancePolarity: w.stancePolarity ?? WEAPON_STANCE.get(w.name) ?? null,
          image: w.image ?? WEAPON_IMAGE.get(w.name) ?? null,
          description: w.description ?? '',
        }))
        .sort((a, b) => a.name.localeCompare(b.name));
      return json(res, 200, list);
    }
    if (url.pathname === '/api/enemies') {
      const list = Object.values(snapshot.enemies)
        .map((e) => ({ name: e.name, faction: e.faction, health: e.health, shield: e.shield, armor: e.armor }))
        .sort((a, b) => a.name.localeCompare(b.name));
      return json(res, 200, list);
    }
    if (url.pathname === '/api/mods') {
      const weaponName = url.searchParams.get('weapon') ?? '';
      const { item } = findWeapon(snapshot, weaponName);
      if (!item) return json(res, 404, { error: `weapon not found: ${weaponName}` });
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
      return json(res, 200, list);
    }
    if (url.pathname === '/api/incarnons') {
      const weaponName = url.searchParams.get('weapon') ?? '';
      const { item } = findWeapon(snapshot, weaponName);
      if (!item) return json(res, 404, { error: `weapon not found: ${weaponName}` });
      return json(res, 200, snapshot.incarnons[item.name] ?? []);
    }
    if (url.pathname === '/api/warframes') {
      const list = Object.values(snapshot.warframes)
        .map((frame) => ({ name: frame.name }))
        .sort((a, b) => a.name.localeCompare(b.name));
      return json(res, 200, list);
    }
    if (url.pathname === '/api/buffs') {
      return json(res, 200, availableBuffs(snapshot));
    }
    if (url.pathname === '/api/arcanes') {
      const weaponName = url.searchParams.get('weapon') ?? '';
      const { item } = findWeapon(snapshot, weaponName);
      const allowed = item ? (ARCANE_SLOTS[item.category] ?? []) : ['primary', 'secondary', 'melee', 'bow', 'shotgun'];
      const list = Object.values(snapshot.arcanes)
        .filter((arcane) => arcane.slot && allowed.includes(arcane.slot))
        .map((arcane) => ({ name: arcane.name, slot: arcane.slot, maxRank: arcane.maxRank, description: arcane.description }))
        .sort((a, b) => a.name.localeCompare(b.name));
      return json(res, 200, list);
    }
    if (url.pathname === '/api/search' && req.method === 'POST') {
      const body = await readBody(req);
      const query: string = body.weapon ?? '';
      const { item: weapon, suggestions } = findWeapon(snapshot, query);
      if (!weapon) return json(res, 404, { error: `weapon not found: ${query}`, suggestions });
      const asList = (value: unknown): string[] =>
        Array.isArray(value) ? value.map(String) : typeof value === 'string' ? value.split(',').map((v) => v.trim()).filter(Boolean) : [];
      // The search picks the mods; everything else about the build can still be fixed, either
      // under `base` or at the top level (the shape /api/calc accepts).
      const baseSource = body.base && typeof body.base === 'object' ? body.base : body;
      let base: Build;
      try {
        base = { ...buildFromJson(snapshot, baseSource, weapon.name), mods: [] };
      } catch (error) {
        return json(res, 400, { error: String((error as Error).message) });
      }
      const chooseIncarnon = Boolean(body.chooseIncarnon) || body.incarnon === 'auto';
      const chooseArcane = Boolean(body.chooseArcane) || body.arcane === 'auto';
      const result = search(snapshot, {
        weapon: weapon.name,
        objective: body.objective === 'dps' ? 'dps' : 'ttk',
        enemy: body.enemy ?? 'Bombard',
        level: body.level !== undefined ? Number(body.level) : 150,
        capacity: body.capacity !== undefined ? Number(body.capacity) : 60,
        maxForma: body.maxForma === null ? null : body.maxForma !== undefined ? Number(body.maxForma) : undefined,
        exclude: asList(body.exclude),
        mustInclude: asList(body.mustInclude ?? body.must),
        limit: body.limit !== undefined ? Number(body.limit) : 3,
        budget: body.budget !== undefined ? Number(body.budget) : undefined,
        chooseIncarnon,
        chooseArcane,
        eximus: Boolean(body.eximus),
        overguard: body.overguard !== undefined ? Number(body.overguard) : undefined,
        steelPath: Boolean(body.steelPath),
        simulate: body.simulate !== false,
        attenuation: body.attenuation !== undefined
          ? body.attenuation
          : (body.mdpt !== undefined || body.mdps !== undefined
            ? { id: 'custom', mdpi: Number(body.mdpt ?? 0), mdps: Number(body.mdps ?? 0) }
            : undefined),
        base: chooseIncarnon ? { ...base, incarnon: undefined } : base,
      });
      return json(res, 200, result);
    }
    if (url.pathname === '/api/shards') return json(res, 200, SHARD_BONUSES);
    if (url.pathname === '/api/snipers') {
      return json(res, 200, Object.fromEntries(Object.entries(snapshot.snipers ?? {}).map(([name, data]) => [name, {
        minimumCombo: data.minimumCombo,
        zooms: data.zooms.map((zoom) => ({ zoom: zoom.zoom, text: zoom.text })),
      }])));
    }
    if (url.pathname === '/api/bruteforce' && req.method === 'POST') {
      const body = await readBody(req);
      const { item: weapon, suggestions } = findWeapon(snapshot, body.weapon ?? '');
      if (!weapon) return json(res, 404, { error: `weapon not found: ${body.weapon ?? ''}`, suggestions });
      const asList = (value: unknown): string[] =>
        Array.isArray(value) ? value.map(String) : typeof value === 'string' ? value.split(',').map((v) => v.trim()).filter(Boolean) : [];
      // Mods are searched; everything else (buffs, Incarnon, arcanes, riven) is the player's input.
      const baseSource = body.base && typeof body.base === 'object' ? body.base : body;
      try {
        const base = { ...buildFromJson(snapshot, baseSource, weapon.name), mods: [] };
        const fixed = Array.isArray(body.fixed)
          ? body.fixed.map((entry: unknown) => (typeof entry === 'string' ? { name: entry } : entry))
          : asList(body.fixed).map((name) => ({ name }));
        const result = await bruteForce(snapshot, {
          weapon: weapon.name,
          objective: body.objective === 'dps' ? 'dps' : 'ttk',
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
          pool: body.pool !== undefined ? Number(body.pool) : undefined,
          maxEvaluations: body.maxEvaluations !== undefined ? Number(body.maxEvaluations) : undefined,
          simulate: body.simulate !== false,
          limit: body.limit !== undefined ? Number(body.limit) : 5,
          base,
        });
        return json(res, 200, result);
      } catch (error) {
        if (error instanceof InputError) return json(res, 400, { error: error.message, code: error.code });
        throw error;
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
      return json(res, 200, list);
    }
    if (url.pathname === '/api/ability') {
      const name = url.searchParams.get('name') ?? '';
      if (!name) return json(res, 400, { error: 'name is required, e.g. /api/ability?name=Miasma' });
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
        return json(res, 200, result);
      } catch (error) {
        return json(res, 404, { error: String((error as Error).message) });
      }
    }
    if (url.pathname === '/api/calc' && req.method === 'POST') {
      const body = await readBody(req);
      const result = calculate(body);
      return json(res, result.error ? ('code' in result && result.code ? 400 : 404) : 200, result);
    }

    // Full mod cards from the wiki: frame, name and stat baked in. Cached on first use,
    // which keeps the tool offline after the first look at a mod.
    if (url.pathname.startsWith('/card/')) {
      const file = url.pathname.slice(6);
      if (!/^[A-Za-z0-9._-]+\.(png|jpe?g|webp)$/i.test(file)) {
        return json(res, 400, { error: 'bad card name' });
      }
      await mkdir(CARD_ROOT, { recursive: true });
      const cached = join(CARD_ROOT, file);
      let bytes: Buffer;
      try {
        bytes = await readFile(cached);
      } catch {
        const upstream = await fetch(`${CARD_UPSTREAM}/${encodeURIComponent(file)}?width=220`, {
          headers: { 'user-agent': 'wfcalc/0.1 (personal damage calculator)' },
        });
        if (!upstream.ok) {
          res.writeHead(404, { 'content-type': 'text/plain' });
          return res.end('no card');
        }
        bytes = Buffer.from(await upstream.arrayBuffer());
        await writeFile(cached, bytes);
      }
      res.writeHead(200, {
        'content-type': file.toLowerCase().endsWith('.png') ? 'image/png' : 'image/jpeg',
        'cache-control': 'public, max-age=2592000',
      });
      return res.end(bytes);
    }

    // Mod artwork: cached on first request, then served from disk.
    if (url.pathname.startsWith('/img/')) {
      const file = url.pathname.slice(5);
      if (!/^[A-Za-z0-9._-]+\.(png|jpe?g|webp)$/i.test(file)) {
        return json(res, 400, { error: 'bad image name' });
      }
      await mkdir(IMG_ROOT, { recursive: true });
      const cached = join(IMG_ROOT, file);
      let bytes: Buffer;
      try {
        bytes = await readFile(cached);
      } catch {
        const upstream = await fetch(`${IMG_UPSTREAM}/${file}`, { headers: { 'user-agent': 'wfcalc/0.1' } });
        if (!upstream.ok) {
          res.writeHead(404, { 'content-type': 'text/plain' });
          return res.end('no image');
        }
        bytes = Buffer.from(await upstream.arrayBuffer());
        await writeFile(cached, bytes);
      }
      res.writeHead(200, {
        'content-type': file.toLowerCase().endsWith('.png') ? 'image/png' : 'image/jpeg',
        'cache-control': 'public, max-age=2592000',
      });
      return res.end(bytes);
    }

    // Static files.
    const relative = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    const path = join(WEB_ROOT, normalize(relative).replace(/^(\.\.[/\\])+/, ''));
    const file = await readFile(path);
    res.writeHead(200, { 'content-type': MIME[extname(path)] ?? 'application/octet-stream' });
    return res.end(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      res.writeHead(404, { 'content-type': 'text/plain' });
      return res.end('not found');
    }
    console.error(error);
    return json(res, 500, { error: String(error) });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`wfcalc web UI: http://${HOST === '0.0.0.0' ? '127.0.0.1' : HOST}:${PORT}`);
  if (HOST === '0.0.0.0') {
    // Print every reachable address, so opening the UI from the phone is copy-paste.
    for (const [name, addrs] of Object.entries(networkInterfaces())) {
      for (const address of addrs ?? []) {
        if (address.family === 'IPv4' && !address.internal) console.log(`  also on http://${address.address}:${PORT}  (${name})`);
      }
    }
  }
  console.log(`data: ${Object.keys(snapshot.weapons).length} weapons, ${Object.keys(snapshot.mods).length} mods, ${Object.keys(snapshot.enemies).length} enemies`);
});
