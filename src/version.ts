declare const __WORK2_VERSION__: string;

/**
 * Inlined at build time from package.json#version. When running via `tsx`
 * (dev mode) the define isn't applied, so we fall back to a placeholder.
 */
export const VERSION: string =
  typeof __WORK2_VERSION__ !== 'undefined' ? __WORK2_VERSION__ : 'dev';
