/**
 * GPU mode against CPU mode, end to end: the real WGSL shader runs in a headless Chromium-family
 * browser (Brave, Chromium or Chrome; WFCALC_BROWSER picks one), the server does its exact pass, and
 * the winner must be the CPU brute force's. Headless browsers usually offer only the software
 * WebGPU adapter (SwiftShader), which runs the same shader, so the fallback is allowed here.
 * Skipped when no such browser is installed.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadSnapshot } from '../src/data.ts';
import { bruteForce } from '../src/engine/bruteforce.ts';
import { rivenPicker } from '../src/engine/riven-picker.ts';

const browser = [process.env.WFCALC_BROWSER, 'brave', 'chromium', 'google-chrome-stable', 'google-chrome']
  .filter((name): name is string => Boolean(name))
  .find((name) => spawnSync('which', [name]).status === 0);

const REQUESTS = [
  { weapon: 'Soma Prime', enemy: 'Bombard', level: 150, pool: 14, simulate: false, limit: 1, form: 'normal' },
  { weapon: 'Hek', enemy: 'Corpus Tech', level: 150, pool: 14, simulate: true, limit: 1 },
];

/** Starts a process and resolves once a stdout line matches. */
function started(child: ChildProcess, ready: RegExp): Promise<void> {
  return new Promise((resolve, reject) => {
    let seen = '';
    child.stdout?.on('data', (chunk) => { seen += chunk; if (ready.test(seen)) resolve(); });
    child.on('exit', (code) => reject(new Error(`exited with code ${code} before it was ready: ${seen}`)));
  });
}

/** Evaluates an async expression in the page at `url` over the DevTools protocol. */
async function evaluate(port: number, url: string, expression: string): Promise<any> {
  let targets: Array<{ type: string; webSocketDebuggerUrl: string }> = [];
  for (let i = 0; i < 100 && !targets.length; i++) {
    try { targets = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).filter((t: any) => t.type === 'page'); }
    catch { await new Promise((r) => setTimeout(r, 100)); }
  }
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

test('GPU mode (WGSL in a browser + exact pass) finds the CPU brute force\'s winner', { skip: !browser && 'no Chromium-family browser installed', timeout: 300_000 }, async () => {
  const appPort = 20_000 + Math.floor(Math.random() * 20_000);
  const debugPort = appPort + 1;
  const profile = mkdtempSync(join(tmpdir(), 'wfcalc-gpu-test-'));
  const server = spawn(process.execPath, ['src/server.ts', '--port', String(appPort)], { stdio: ['ignore', 'pipe', 'inherit'] });
  const chrome = spawn(browser!, ['--headless=new', `--remote-debugging-port=${debugPort}`, `--user-data-dir=${profile}`,
    '--enable-unsafe-webgpu', '--no-first-run', 'about:blank'], { stdio: 'ignore' });
  try {
    await started(server, /wfcalc web UI/);
    const snapshot = loadSnapshot();
    for (const request of REQUESTS) {
      const gpu = await evaluate(debugPort, `http://127.0.0.1:${appPort}/`, `(async () => {
        const { gpuSearch } = await import('/gpu-search.js');
        const post = (path, body) => fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());
        const body = ${JSON.stringify(request)};
        const model = await post('/api/bruteforce/gpu-model', { ...body, keep: 400 });
        const found = await gpuSearch(model, { allowFallback: true });
        const result = await post('/api/bruteforce/gpu-finish', { ...body, combinations: found.winners.map(({ combo }) => combo.map((i) => model.candidates[i])),
          gpu: { combinations: model.combinations, elapsedMs: 0, adapter: found.adapter, drift: found.drift } });
        return { drift: found.drift, build: result.builds[0], error: result.error };
      })()`);
      const cpu = await bruteForce(snapshot, { ...request, workers: 1 });
      assert.equal(gpu.error, undefined);
      // The shader and the JS model agree to float32 precision.
      assert.ok(gpu.drift < 1e-4, `shader drift ${gpu.drift}`);
      assert.deepEqual(gpu.build.mods.map((mod: { name: string }) => mod.name).sort(), cpu.builds[0].mods.map((mod) => mod.name).sort(), request.weapon);
      assert.ok(Math.abs(gpu.build.timeToKill - cpu.builds[0].timeToKill!) < 1e-9, request.weapon);
    }
    // Riven picker: the riven shader on every riven x slot, then the exact pass, against the CPU picker.
    const riven = { weapon: 'Soma Prime', form: 'normal', mods: [{ name: 'Serration' }, { name: 'Split Chamber' }, { name: 'Point Strike' }], enemy: 'Bombard', level: 150, stats: [], limit: 1 };
    const gpuRiven = await evaluate(debugPort, `http://127.0.0.1:${appPort}/`, `(async () => {
      const { gpuRivenSearch } = await import('/gpu-search.js');
      const post = (path, body) => fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());
      const body = ${JSON.stringify(riven)};
      const model = await post('/api/riven-picker/gpu-model', body);
      const found = await gpuRivenSearch(model, { allowFallback: true });
      const count = model.rivenIndex.length / 4;
      const order = Array.from({ length: count }, (_, r) => r).sort((a, b) => found.bestScore[b] - found.bestScore[a]).slice(0, 500);
      const rivens = order.map((r) => { const names = model.rivenIndex.slice(r * 4, r * 4 + 4).map((i) => model.candidates[i].slice(1)); return { stats: names.slice(0, 3), malus: names[3] }; });
      const result = await post('/api/riven-picker/gpu-finish', { ...body, rivens, gpu: { rivens: count, replacedCounts: {}, elapsedMs: 0 } });
      return { drift: found.drift, pick: result.picks?.[0], error: result.error };
    })()`);
    const cpuRiven = await rivenPicker(snapshot, { ...riven, limit: 1, workers: 1, base: { mods: [] } });
    assert.equal(gpuRiven.error, undefined);
    assert.ok(gpuRiven.drift < 1e-4, `riven shader drift ${gpuRiven.drift}`);
    assert.ok(Math.abs(gpuRiven.pick.score - cpuRiven.picks[0].score) < 1e-9 * cpuRiven.picks[0].score, 'GPU riven pick matches the CPU one');
  } finally {
    // The browser writes to its profile until it has exited.
    const closed = new Promise((resolve) => chrome.once('exit', resolve));
    chrome.kill();
    server.kill();
    await closed;
    rmSync(profile, { recursive: true, force: true, maxRetries: 5 });
  }
});
