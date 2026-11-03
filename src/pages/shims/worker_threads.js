/**
 * node:worker_threads on Web Workers, for the GitHub Pages build (tools/build-pages.ts points the
 * import here). A thread starts as this file; its first message names the real entry and carries
 * workerData, which must be set before that module runs. Messages that arrive while it loads are
 * kept for its parentPort listener.
 */
const THREAD = 'wfcalc-thread';
const isThread = typeof WorkerGlobalScope !== 'undefined' && self.name === THREAD;

export let workerData = null;
let listener = null;
const early = [];
export const parentPort = isThread
  ? {
      on(type, fn) {
        if (type !== 'message') return;
        listener = fn;
        for (const message of early.splice(0)) fn(message);
      },
      postMessage: (message) => self.postMessage(message),
    }
  : null;

if (isThread) {
  let started = false;
  self.addEventListener('message', ({ data }) => {
    if (started) return listener ? listener(data) : void early.push(data);
    started = true;
    workerData = data.workerData;
    // A failed import surfaces as the thread's error event, as an uncaught error in Node would.
    import(data.entry).catch((error) => setTimeout(() => { throw error; }));
  });
}

export class Worker {
  #worker;
  #listeners = [];

  constructor(entry, options = {}) {
    this.#worker = new globalThis.Worker(import.meta.url, { type: 'module', name: THREAD });
    this.#worker.addEventListener('message', ({ data }) => this.#emit('message', data));
    this.#worker.addEventListener('error', (event) => {
      event.preventDefault();
      this.#emit('error', new Error(event.message || 'worker failed to start'));
    });
    this.#worker.postMessage({ entry: String(entry), workerData: options.workerData ?? null });
  }

  #emit(type, value) {
    for (const entry of [...this.#listeners]) {
      if (entry.type !== type) continue;
      if (entry.once) this.off(type, entry.fn);
      entry.fn(value);
    }
  }

  on(type, fn) { this.#listeners.push({ type, fn, once: false }); return this; }
  once(type, fn) { this.#listeners.push({ type, fn, once: true }); return this; }
  off(type, fn) {
    const at = this.#listeners.findIndex((entry) => entry.type === type && entry.fn === fn);
    if (at >= 0) this.#listeners.splice(at, 1);
    return this;
  }
  postMessage(message) { this.#worker.postMessage(message); }
  // Like Node: a terminated thread exits with code 1.
  terminate() { this.#worker.terminate(); this.#emit('exit', 1); return Promise.resolve(1); }
  unref() {}
}
