import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * libghostty-vt's official WebAssembly build (vendor/libghostty-vt/README.md): loaded the first time a GhosttyTerminal is
 * made, never before. The only module in work that touches WebAssembly (tests/architecture/boundaries.test.ts). The
 * module has no imports; every terminal gets its own instance of it (about 0.2 ms), so freeing a terminal is dropping
 * its instance, and one terminal's memory never grows another's.
 */

export const LIBRARY_VERSION = '1.0.1';
export const WASM_NAME = `ghostty-vt-${LIBRARY_VERSION}.wasm`;

/** Next to the bundle (the build copies it into dist/), else the repo's vendor/ (tsx runs the sources). */
const CANDIDATES = [new URL(`./${WASM_NAME}`, import.meta.url), new URL(`../../../../vendor/libghostty-vt/${WASM_NAME}`, import.meta.url)];

/** Every export used, with its parameter count: checked against the module, so a different build fails loudly here. */
const FUNCTIONS = {
  ghostty_type_json: 0,
  ghostty_wasm_alloc: 1,
  ghostty_wasm_free: 2,
  ghostty_wasm_alloc_opaque: 0,
  ghostty_wasm_take_opaque: 1,
  ghostty_free: 3,
  ghostty_terminal_new: 4,
  ghostty_terminal_free: 1,
  ghostty_terminal_resize: 5,
  ghostty_terminal_vt_write: 3,
  ghostty_terminal_get: 3,
  ghostty_terminal_set: 3,
  ghostty_terminal_continuation_alloc: 4,
  ghostty_terminal_grid_ref: 3,
  ghostty_formatter_terminal_new: 3,
  ghostty_formatter_set: 3,
  ghostty_formatter_format_alloc: 4,
  ghostty_formatter_free: 1,
  ghostty_snapshot_encode_alloc: 4,
  ghostty_snapshot_decoder_new_buf: 4,
  ghostty_snapshot_decoder_decode: 2,
  ghostty_snapshot_decoder_free: 1,
} as const;

/** All of the C API used takes and returns i32 (pointers and size_t are 4 bytes on wasm32). */
export type WasmFn = (...args: number[]) => number;
export type GhosttyFunctions = { readonly [K in keyof typeof FUNCTIONS]: WasmFn };

/** Byte offsets in the structs passed to and from the C API, read from the module's own `ghostty_type_json`. */
export interface Layout {
  string: { ptr: number; len: number };
  modeConfig: { size: number; mode: number; value: number };
  /** GhosttyPoint; `x` and `y` are the coordinate's, from the point's start. */
  point: { size: number; align: number; tag: number; x: number; y: number };
  selection: { size: number; start: number; end: number; rectangle: number };
  progress: { state: number; progress: number };
  program: { state: number; kind: number; progress: number; id: number; app: number; title: number; message: number };
  rgb: { size: number; r: number; g: number; b: number };
}

export interface GhosttyInstance {
  readonly fn: GhosttyFunctions;
  readonly memory: WebAssembly.Memory;
  readonly table: WebAssembly.Table;
  readonly layout: Layout;
}

interface Compiled {
  module: WebAssembly.Module;
  layout: Layout | null;
}

let compiled: Compiled | Error | undefined;

/** Where the module is, or null. */
export function wasmPath(): string | null {
  for (const url of CANDIDATES) {
    const file = fileURLToPath(url);
    if (existsSync(file)) return file;
  }
  return null;
}

/** The compiled module, compiled once; a failure is kept and thrown again (nothing is read twice). */
function load(): Compiled {
  if (compiled instanceof Error) throw compiled;
  if (compiled) return compiled;
  try {
    const file = wasmPath();
    if (!file) throw new Error(`${WASM_NAME} not found (looked next to the bundle and in vendor/libghostty-vt)`);
    compiled = { module: new WebAssembly.Module(readFileSync(file)), layout: null };
    return compiled;
  } catch (err) {
    compiled = err instanceof Error ? err : new Error(String(err));
    throw compiled;
  }
}

const isFn = (v: unknown): v is WasmFn => typeof v === 'function';

/** A new instance of the module, its exports checked (names, parameter counts) and its struct layout read. Throws if it can't be. */
export function instantiate(): GhosttyInstance {
  const c = load();
  const exports = new WebAssembly.Instance(c.module, {}).exports;
  const { memory, __indirect_function_table: table } = exports;
  if (!(memory instanceof WebAssembly.Memory)) throw new Error('libghostty-vt: no memory export');
  if (!(table instanceof WebAssembly.Table)) throw new Error('libghostty-vt: no function table export');
  const fn: Partial<Record<keyof typeof FUNCTIONS, WasmFn>> = {};
  for (const [name, arity] of Object.entries(FUNCTIONS)) {
    const f = exports[name];
    if (!isFn(f) || f.length !== arity) throw new Error(`libghostty-vt: ${name} missing or not ${arity} parameters`);
    fn[name as keyof typeof FUNCTIONS] = f;
  }
  const complete = fn as GhosttyFunctions; // every key was set above, or it threw
  c.layout ??= readLayout(complete, memory);
  return { fn: complete, memory, table, layout: c.layout };
}

// ---- the struct layout --------------------------------------------------------------------------------------------

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function num(v: unknown, what: string): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) throw new Error(`libghostty-vt layout: ${what} is not an offset`);
  return v;
}

function readLayout(fn: GhosttyFunctions, memory: WebAssembly.Memory): Layout {
  const at = fn.ghostty_type_json();
  const bytes = new Uint8Array(memory.buffer);
  const end = bytes.indexOf(0, at);
  const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes.subarray(at, end < 0 ? at : end)));
  if (!isRecord(parsed) || !isRecord(parsed.types)) throw new Error('libghostty-vt layout: no types');
  if (parsed.library_version !== LIBRARY_VERSION) throw new Error(`libghostty-vt layout: version ${String(parsed.library_version)}`);
  const types = parsed.types;
  const type = (name: string) => {
    const t = types[name];
    if (!isRecord(t) || !isRecord(t.fields)) throw new Error(`libghostty-vt layout: no ${name}`);
    return t;
  };
  const size = (name: string) => num(type(name).size, `${name}.size`);
  const off = (name: string, field: string) => {
    const f = type(name).fields;
    const entry = isRecord(f) ? f[field] : undefined;
    return num(isRecord(entry) ? entry.offset : undefined, `${name}.${field}`);
  };
  const S = 'GhosttyString';
  const P = 'GhosttyTerminalProgramStatus';
  const value = off('GhosttyPoint', 'value');
  return {
    string: { ptr: off(S, 'ptr'), len: off(S, 'len') },
    modeConfig: {
      size: size('GhosttyTerminalModeConfig'),
      mode: off('GhosttyTerminalModeConfig', 'mode'),
      value: off('GhosttyTerminalModeConfig', 'value'),
    },
    point: {
      size: size('GhosttyPoint'),
      align: num(type('GhosttyPoint').align, 'GhosttyPoint.align'),
      tag: off('GhosttyPoint', 'tag'),
      x: value + off('GhosttyPointCoordinate', 'x'),
      y: value + off('GhosttyPointCoordinate', 'y'),
    },
    selection: {
      size: size('GhosttySelection'),
      start: off('GhosttySelection', 'start'),
      end: off('GhosttySelection', 'end'),
      rectangle: off('GhosttySelection', 'rectangle'),
    },
    progress: { state: off('GhosttyTerminalProgressReport', 'state'), progress: off('GhosttyTerminalProgressReport', 'progress') },
    program: {
      state: off(P, 'state'),
      kind: off(P, 'kind'),
      progress: off(P, 'progress'),
      id: off(P, 'id'),
      app: off(P, 'app'),
      title: off(P, 'title'),
      message: off(P, 'message'),
    },
    rgb: { size: size('GhosttyColorRgb'), r: off('GhosttyColorRgb', 'r'), g: off('GhosttyColorRgb', 'g'), b: off('GhosttyColorRgb', 'b') },
  };
}

// ---- callbacks into JS --------------------------------------------------------------------------------------------

const leb = (n: number): number[] => {
  const out: number[] = [];
  do {
    let b = n & 0x7f;
    n >>>= 7;
    if (n) b |= 0x80;
    out.push(b);
  } while (n);
  return out;
};
const section = (id: number, body: number[]): number[] => [id, ...leb(body.length), ...body];
const wasmName = (s: string): number[] => [s.length, ...Array.from(s, (c) => c.charCodeAt(0))];
const trampolines = new Map<number, WebAssembly.Module>();

/**
 * A JS function as an entry of the instance's function table, for the C API's callback options: the table takes only
 * WebAssembly functions, so a one-function module (hand-assembled: type, import `js.f`, export `f`) imports the JS one
 * and is the entry. `params` i32 parameters, no result (every callback used returns void). Returns the table index.
 */
export function callback(instance: GhosttyInstance, params: number, f: (...args: number[]) => void): number {
  let mod = trampolines.get(params);
  if (!mod) {
    mod = new WebAssembly.Module(
      new Uint8Array([
        ...[0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00],
        ...section(1, [1, 0x60, params, ...Array<number>(params).fill(0x7f), 0]),
        ...section(2, [1, ...wasmName('js'), ...wasmName('f'), 0x00, 0x00]),
        ...section(7, [1, ...wasmName('f'), 0x00, 0x00]),
      ]),
    );
    trampolines.set(params, mod);
  }
  const entry = new WebAssembly.Instance(mod, { js: { f } }).exports.f;
  if (!isFn(entry)) throw new Error('libghostty-vt: trampoline has no export');
  const index = instance.table.grow(1);
  instance.table.set(index, entry);
  return index;
}
