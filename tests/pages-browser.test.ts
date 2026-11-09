/**
 * The GitHub Pages build end to end: tools/build-pages.ts output served as static files under
 * /wfcalc/ (where a project site lives), in a headless Chromium-family browser. Every API kind the
 * UI uses must answer from the Web Worker exactly as the Node API does: plain JSON, the streamed
 * brute force and its stop button, the GPU search with its exact pass on worker threads, the riven
 * picker. Skipped when no such browser is installed.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { extname, join, normalize } from 'node:path';
import { handleApi } from '../src/api.ts';

// Chrome before Chromium: on GitHub's Ubuntu runners `chromium` never opened its debug port (likely the snap).
const browser = [process.env.WFCALC_BROWSER, 'brave', 'google-chrome-stable', 'google-chrome', 'chromium']
  .filter((name): name is string => Boolean(name))
  .find((name) => spawnSync('which', [name]).status === 0);

const MIME: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };

/** Evaluates an async expression in the page at `url` over the DevTools protocol. */
async function evaluate(port: number, url: string, expression: string): Promise<any> {
  let targets: Array<{ type: string; webSocketDebuggerUrl: string }> = [];
  // The port can answer before the first page is listed (busy runner): wait on a time budget, not on errors only.
  for (const until = Date.now() + 15000; !targets.length && Date.now() < until;) {
    try { targets = ((await (await fetch(`http://127.0.0.1:${port}/json`)).json()) as any[]).filter((t: any) => t.type === 'page'); }
    catch { /* port not open yet */ }
    if (!targets.length) await new Promise((r) => setTimeout(r, 100));
  }
  if (!targets.length) throw new Error(`${browser} exposed no page (did it start?)`);
  const socket = new WebSocket(targets[0].webSocketDebuggerUrl);
  await new Promise((resolve) => socket.addEventListener('open', resolve));
  let id = 0;
  const pending = new Map<number, (message: any) => void>();
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(String(event.data));
    pending.get(message.id)?.(message);
    pending.delete(message.id);
  });
  const send = (method: string, params = {}): Promise<any> => new Promise((resolve) => {
    pending.set(++id, resolve);
    socket.send(JSON.stringify({ id, method, params }));
  });
  try {
    await send('Page.enable');
    await send('Page.navigate', { url });
    await new Promise((r) => setTimeout(r, 1500));
    const reply = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (reply.result?.exceptionDetails) throw new Error(JSON.stringify(reply.result.exceptionDetails));
    return reply.result.result.value;
  } finally {
    socket.close();
  }
}

/** What the Node API answers, through the same handleApi the worker runs. */
async function nodeApi(path: string, body: object = {}): Promise<any> {
  const answer = await handleApi(Object.keys(body).length ? 'POST' : 'GET', new URL(`http://wfcalc${path}`), body);
  return answer?.body;
}

const CALC = { weapon: 'Soma Prime', mods: ['Serration', 'Split Chamber', 'Point Strike'], enemy: 'Bombard', level: 100 };
const SEARCH = { weapon: 'Hek', enemy: 'Corpus Tech', level: 150, limit: 1 };
const BRUTE = { weapon: 'Soma Prime', enemy: 'Bombard', level: 150, pool: 14, simulate: false, limit: 1, form: 'normal' };
const RIVEN = { weapon: 'Soma Prime', form: 'normal', mods: [{ name: 'Serration' }, { name: 'Split Chamber' }, { name: 'Point Strike' }], enemy: 'Bombard', level: 150, stats: [], limit: 1 };
const names = (build: { mods: Array<{ name: string }> }) => build.mods.map((mod) => mod.name).sort();

test('GitHub Pages build answers every API kind from the Web Worker like the Node API', { skip: (!browser && 'no Chromium-family browser installed'), timeout: 300_000 }, async () => {
  const out = mkdtempSync(join(tmpdir(), 'wfcalc-pages-'));
  const profile = mkdtempSync(join(tmpdir(), 'wfcalc-pages-profile-'));
  const built = spawnSync(process.execPath, ['tools/build-pages.ts', '--out', out], { encoding: 'utf8' });
  assert.equal(built.status, 0, built.stderr);
  // Static files only, under the project-site prefix: an absolute /api/ or /img/ path would miss.
  const site = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://x').pathname;
    if (!path.startsWith('/wfcalc/')) { res.writeHead(404); return res.end(); }
    const file = join(out, normalize(path.slice('/wfcalc/'.length) || 'index.html').replace(/^(\.\.[/\\])+/, ''));
    try {
      const bytes = readFileSync(file.endsWith('/') ? join(file, 'index.html') : file);
      res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' });
      res.end(bytes);
    } catch {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise<void>((resolve) => site.listen(0, '127.0.0.1', resolve));
  const sitePort = (site.address() as { port: number }).port;
  const debugPort = 40_000 + Math.floor(Math.random() * 20_000);
  const chrome = spawn(browser!, ['--headless=new', `--remote-debugging-port=${debugPort}`, `--user-data-dir=${profile}`,
    '--enable-unsafe-webgpu', '--no-first-run', 'about:blank'], { stdio: 'ignore' });
  try {
    const page = await evaluate(debugPort, `http://127.0.0.1:${sitePort}/wfcalc/`, `(async () => {
      const post = (path, body, signal) => fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal });
      const json = (path, body) => (body ? post(path, body) : fetch(path)).then((r) => r.json());
      const lines = async (response) => (await response.text()).split('\\n').filter(Boolean).map((line) => JSON.parse(line));
      const out = {};
      out.weapons = (await json('/api/weapons')).length;
      out.calc = await json('/api/calc', ${JSON.stringify(CALC)});
      out.search = await json('/api/search', ${JSON.stringify(SEARCH)});
      out.badJson = await fetch('/api/calc', { method: 'POST', body: '{' }).then((r) => r.status);

      // Streamed CPU brute force: progress lines, then the result.
      const streamed = await post('/api/bruteforce', { ...${JSON.stringify(BRUTE)}, stream: true });
      out.streamType = streamed.headers.get('content-type');
      const got = await lines(streamed);
      out.progressLines = got.filter((line) => line.progress !== undefined).length;
      out.brute = got.at(-1).result;

      // The stop button: the request rejects, and the next search still runs.
      const stop = new AbortController();
      const stopped = post('/api/bruteforce', { ...${JSON.stringify(BRUTE)}, pool: 18, stream: true }, stop.signal).then((r) => r.text());
      setTimeout(() => stop.abort(), 300);
      out.aborted = await stopped.then(() => 'finished', (error) => error.name);

      // GPU search: the shader on the page, the exact pass on worker threads (over 1,500 builds).
      const { gpuSearch } = await import('./gpu-search.js');
      const model = await json('/api/bruteforce/gpu-model', { ...${JSON.stringify(BRUTE)}, keep: 3000 });
      const found = await gpuSearch(model, { allowFallback: true });
      out.gpu = await json('/api/bruteforce/gpu-finish', { ...${JSON.stringify(BRUTE)}, combinations: found.winners.map(({ combo }) => combo.map((i) => model.candidates[i])),
        gpu: { combinations: model.combinations, elapsedMs: 0, adapter: found.adapter, drift: found.drift } });
      out.drift = found.drift;

      out.riven = await json('/api/riven-picker', ${JSON.stringify(RIVEN)});
      out.art = globalThis.wfcalcArt.img('x.png');
      return out;
    })()`);

    assert.equal(page.weapons, (await nodeApi('/api/weapons')).length);
    assert.deepEqual(page.calc, JSON.parse(JSON.stringify(await nodeApi('/api/calc', CALC))));
    const search = await nodeApi('/api/search', SEARCH);
    assert.deepEqual(names(page.search.builds[0]), names(search.builds[0]));
    assert.equal(page.badJson, 400);

    assert.match(page.streamType, /ndjson/);
    assert.ok(page.progressLines > 0, 'progress lines before the result');
    const brute = await nodeApi('/api/bruteforce', { ...BRUTE, workers: 1 });
    assert.deepEqual(names(page.brute.builds[0]), names(brute.builds[0]));
    assert.equal(page.brute.builds[0].timeToKill, brute.builds[0].timeToKill);
    assert.ok(page.brute.workers > 1, `CPU brute force on ${page.brute.workers} worker threads`);
    // Before the first progress line the fetch rejects with the AbortError; after it, Chrome turns the
    // errored body stream into "TypeError: Failed to fetch". The UI checks its own signal, not the name.
    assert.ok(['AbortError', 'TypeError'].includes(page.aborted), `stopped request: ${page.aborted}`);

    assert.ok(page.drift < 1e-4, `shader drift ${page.drift}`);
    assert.ok(page.gpu.workers > 1, `exact pass on ${page.gpu.workers} worker threads`);
    assert.deepEqual(names(page.gpu.builds[0]), names(brute.builds[0]));

    const riven = await nodeApi('/api/riven-picker', { ...RIVEN, workers: 1 });
    assert.ok(Math.abs(page.riven.picks[0].score - riven.picks[0].score) < 1e-9 * riven.picks[0].score, 'riven pick matches');
    assert.match(page.art, /^https:\/\/raw\.githubusercontent\.com\//);
  } finally {
    // A browser that already died never sends 'exit' again: waiting for it hung CI for 300 s.
    const closed = chrome.exitCode === null && chrome.signalCode === null ? new Promise((resolve) => chrome.once('exit', resolve)) : null;
    chrome.kill();
    site.close();
    await closed;
    rmSync(profile, { recursive: true, force: true, maxRetries: 5 });
    rmSync(out, { recursive: true, force: true });
  }
});
