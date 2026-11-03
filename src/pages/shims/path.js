// node:path for the GitHub Pages build (tools/build-pages.ts points the import here).
export const join = (...parts) => parts.join('/').replace(/\/+/g, '/');
