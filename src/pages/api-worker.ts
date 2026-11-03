/**
 * The API in a Web Worker, for the GitHub Pages build: src/pages/pages.js posts each of the UI's
 * /api/ requests here and gets back what the Node server would have sent.
 */
import { handleApi } from '../api.ts';

// The worker scope, typed by hand: tsconfig has no DOM or WebWorker lib.
const scope = globalThis as unknown as { onmessage: (event: { data: any }) => void; postMessage: (message: object) => void };
const running = new Map<number, AbortController>();

scope.onmessage = async ({ data }) => {
  if (data.abort) return running.get(data.id)?.abort(new Error('stopped by the client'));
  const { id, method, url, body } = data as { id: number; method: string; url: string; body: string };
  const post = (message: object): void => scope.postMessage({ id, ...message });
  let parsed: unknown = {};
  try {
    if (body) parsed = JSON.parse(body);
  } catch {
    return post({ reply: { status: 400, body: { error: 'request body is not valid JSON', code: 'invalid_json' } } });
  }
  const stopped = new AbortController();
  running.set(id, stopped);
  try {
    const answer = await handleApi(method, new URL(url), parsed, { signal: stopped.signal, progress: (line) => post({ line }) });
    post({ reply: answer ?? { status: 404, body: { error: 'not found' } } });
  } catch (error) {
    console.error(error);
    post({ reply: { status: 500, body: { error: String(error) } } });
  } finally {
    running.delete(id);
  }
};
