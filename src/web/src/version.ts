declare const __WORK2_VERSION__: string;

/**
 * The shipped package version, inlined at build time from package.json by
 * the Vite `define` (mirrors the server bundle's tsup define). Under the
 * dev server the define is still applied, so this is accurate there too;
 * the 'dev' fallback only shows if the constant is somehow absent.
 */
export const VERSION: string =
  typeof __WORK2_VERSION__ !== 'undefined' ? __WORK2_VERSION__ : 'dev';
