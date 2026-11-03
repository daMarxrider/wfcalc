// node:fs for the GitHub Pages build (tools/build-pages.ts points the import here).
// Only the engine's workers call it, and synchronous requests are allowed in workers.
export function readFileSync(path) {
  const request = new XMLHttpRequest();
  request.open('GET', path, false);
  request.send();
  if (request.status !== 200) throw Object.assign(new Error(`ENOENT: no such file, open '${path}'`), { code: 'ENOENT' });
  return request.responseText;
}
