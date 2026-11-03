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
import { art, handleApi, snapshot } from './api.ts';
import { InputError } from './errors.ts';

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

/** Mod artwork the snapshot lacks, from WFCD's export when we have it (data/raw is not in git). */
try {
  const raw = JSON.parse(readFileSync(new URL('../data/raw/wfcd-Mods.json', import.meta.url).pathname, 'utf8')) as any[];
  for (const mod of raw) {
    if (typeof mod?.name === 'string' && typeof mod?.imageName === 'string' && !art.mod.has(mod.name)) art.mod.set(mod.name, mod.imageName);
  }
} catch {
  /* the export may be absent; the UI just shows no art */
}

/** Weapon artwork and melee stance polarity, from the same export. */
for (const file of ['Primary', 'Secondary', 'Melee', 'Arch-Gun', 'Arch-Melee', 'SentinelWeapons']) {
  try {
    const raw = JSON.parse(readFileSync(new URL(`../data/raw/wfcd-${file}.json`, import.meta.url).pathname, 'utf8')) as any[];
    for (const weapon of raw) {
      if (typeof weapon?.name !== 'string') continue;
      if (typeof weapon.imageName === 'string') art.weapon.set(weapon.name, weapon.imageName);
      if (typeof weapon.stancePolarity === 'string') art.stance.set(weapon.name, weapon.stancePolarity);
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
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new InputError('request body is not valid JSON', 'invalid_json');
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  try {
    if (url.pathname.startsWith('/api/')) {
      // A dropped connection (the Find tab's stop button) stops the search behind it.
      const stopped = new AbortController();
      res.on('close', () => { if (!res.writableFinished) stopped.abort(new Error('stopped by the client')); });
      const ndjson = (): void => { if (!res.headersSent) res.writeHead(200, { 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-store' }); };
      const answer = await handleApi(req.method ?? 'GET', url, await readBody(req), {
        signal: stopped.signal,
        progress: (line) => { ndjson(); res.write(`${JSON.stringify(line)}\n`); },
      });
      if (answer) {
        if (!answer.status) return;
        if (!answer.stream) return json(res, answer.status, answer.body);
        ndjson();
        res.write(`${JSON.stringify(answer.body)}\n`);
        return res.end();
      }
    }

    // Full mod cards from the wiki: frame, name and stat baked in. Cached on first use,
    // which keeps the tool offline after the first look at a mod.
    if (url.pathname.startsWith('/card/')) {
      // Wiki file names can hold parentheses and apostrophes ("IncarnonReloadSpeed(xWhite).png");
      // still no slashes, so the name cannot leave the cache folder.
      let file = '';
      try { file = decodeURIComponent(url.pathname.slice(6)); } catch { /* malformed escape: rejected below */ }
      if (!/^[A-Za-z0-9._'()-]+\.(png|jpe?g|webp)$/i.test(file) || file.startsWith('.')) {
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
    // Bad input from any route (a level of "abc") is the caller's mistake, not a server fault.
    if (error instanceof InputError) return json(res, 400, { error: error.message, code: error.code });
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
