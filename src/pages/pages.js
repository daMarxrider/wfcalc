/**
 * GitHub Pages build: there is no server, so the UI's /api/ requests go to the same API code in a
 * Web Worker (api-worker.ts), and artwork is linked from where the server would have fetched it.
 * Loaded before app.js (tools/build-pages.ts adds the script tag).
 */
const IMG_UPSTREAM = 'https://raw.githubusercontent.com/WFCD/warframe-items/master/data/img';
const CARD_UPSTREAM = 'https://wiki.warframe.com/w/Special:FilePath';
globalThis.wfcalcArt = {
  img: (file) => `${IMG_UPSTREAM}/${file}`,
  card: (file) => `${CARD_UPSTREAM}/${encodeURIComponent(file)}?width=220`,
};

const api = new Worker(new URL('./api-worker.js', import.meta.url), { type: 'module', name: 'wfcalc-api' });
const pending = new Map();
let nextId = 0;
api.addEventListener('message', ({ data }) => {
  const request = pending.get(data.id);
  if (!request) return;
  if ('line' in data) return request.line(data.line);
  pending.delete(data.id);
  request.done(data.reply);
});

const encoder = new TextEncoder();
const nativeFetch = globalThis.fetch.bind(globalThis);
globalThis.fetch = (input, init = {}) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url, location.href);
  const at = url.pathname.indexOf('/api/');
  if (at < 0) return nativeFetch(input, init);
  return new Promise((resolve, reject) => {
    const id = ++nextId;
    const signal = init.signal;
    if (signal?.aborted) return reject(signal.reason);
    // Streamed replies (the brute force's progress lines) become an NDJSON body, as from the server.
    let stream = null;
    const ndjson = () => resolve(new Response(new ReadableStream({ start: (controller) => { stream = controller; } }),
      { headers: { 'content-type': 'application/x-ndjson' } }));
    const write = (line) => stream.enqueue(encoder.encode(`${JSON.stringify(line)}\n`));
    signal?.addEventListener('abort', () => {
      pending.delete(id);
      api.postMessage({ id, abort: true });
      if (stream) stream.error(signal.reason);
      else reject(signal.reason);
    }, { once: true });
    pending.set(id, {
      line(line) { if (!stream) ndjson(); write(line); },
      done(reply) {
        if (!reply.stream) {
          return resolve(new Response(JSON.stringify(reply.body), { status: reply.status, headers: { 'content-type': 'application/json' } }));
        }
        if (!stream) ndjson();
        write(reply.body);
        stream.close();
      },
    });
    api.postMessage({ id, method: (init.method ?? 'GET').toUpperCase(), url: `http://wfcalc${url.pathname.slice(at)}${url.search}`, body: typeof init.body === 'string' ? init.body : '' });
  });
};
