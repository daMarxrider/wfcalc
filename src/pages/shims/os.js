// node:os for the GitHub Pages build (tools/build-pages.ts points the import here).
export const availableParallelism = () => navigator.hardwareConcurrency || 4;
