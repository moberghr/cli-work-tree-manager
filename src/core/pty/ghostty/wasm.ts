import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { compileGhostty, instantiateGhostty, WASM_NAME, type GhosttyInstance } from './wasm-core.js';

/**
 * libghostty-vt in Node: the module read from its file, compiled the first time a GhosttyTerminal is made, never
 * before. The binding itself is wasm-core.ts (pure, shared with the browser); only how the bytes arrive is here.
 */

export {
  callback,
  LIBRARY_VERSION,
  WASM_NAME,
  type GhosttyFunctions,
  type GhosttyInstance,
  type Layout,
  type WasmFn,
} from './wasm-core.js';

/** Next to the bundle (the build copies it into dist/), else the repo's vendor/ (tsx runs the sources). */
const CANDIDATES = [new URL(`./${WASM_NAME}`, import.meta.url), new URL(`../../../../vendor/libghostty-vt/${WASM_NAME}`, import.meta.url)];

let compiled: WebAssembly.Module | Error | undefined;

/** Where the module is, or null. */
export function wasmPath(): string | null {
  for (const url of CANDIDATES) {
    const file = fileURLToPath(url);
    if (existsSync(file)) return file;
  }
  return null;
}

/** The compiled module, compiled once; a failure is kept and thrown again (nothing is read twice). */
function load(): WebAssembly.Module {
  if (compiled instanceof Error) throw compiled;
  if (compiled) return compiled;
  try {
    const file = wasmPath();
    if (!file) throw new Error(`${WASM_NAME} not found (looked next to the bundle and in vendor/libghostty-vt)`);
    compiled = compileGhostty(readFileSync(file));
    return compiled;
  } catch (err) {
    compiled = err instanceof Error ? err : new Error(String(err));
    throw compiled;
  }
}

/** A new instance of the module, its exports checked (names, parameter counts) and its struct layout read. Throws if it can't be. */
export function instantiate(): GhosttyInstance {
  return instantiateGhostty(load());
}
