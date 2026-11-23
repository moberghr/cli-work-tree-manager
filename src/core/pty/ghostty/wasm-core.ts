/**
 * libghostty-vt's official WebAssembly build (vendor/libghostty-vt/README.md), without the loading: the module's bytes
 * come from the caller — the file next to the bundle in Node (wasm.ts), a fetch of the served asset in the browser (the
 * Terminal tab's ghostty engine). Pure: no Node builtins, so the browser bundles this same binding. Together with the
 * rest of src/core/pty/ghostty/, the only code in work that touches WebAssembly (tests/architecture/boundaries.test.ts).
 * The module has no imports; every terminal gets its own instance of it (about 0.2 ms), so freeing a terminal is
 * dropping its instance, and one terminal's memory never grows another's.
 */

export const LIBRARY_VERSION = '1.0.1';
export const WASM_NAME = `ghostty-vt-${LIBRARY_VERSION}.wasm`;

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
  ghostty_terminal_scroll_viewport: 2,
  ghostty_formatter_terminal_new: 3,
  ghostty_formatter_set: 3,
  ghostty_formatter_format_alloc: 4,
  ghostty_formatter_free: 1,
  ghostty_snapshot_encode_alloc: 4,
  ghostty_snapshot_decoder_new_buf: 4,
  ghostty_snapshot_decoder_decode: 2,
  ghostty_snapshot_decoder_free: 1,
  // The render state (render.h): what a renderer draws, row by row, with what changed since the last frame.
  ghostty_render_state_new: 2,
  ghostty_render_state_free: 1,
  ghostty_render_state_update: 2,
  ghostty_render_state_get: 3,
  ghostty_render_state_clean: 1,
  ghostty_render_state_row_iterator_new: 2,
  ghostty_render_state_row_iterator_free: 1,
  ghostty_render_state_row_iterator_next: 1,
  ghostty_render_state_row_iterator_next_dirty: 2,
  ghostty_render_state_row_get: 3,
  ghostty_render_state_row_cells_new: 2,
  ghostty_render_state_row_cells_free: 1,
  ghostty_render_state_row_cells_select: 2,
  ghostty_render_state_row_cells_get: 3,
  // Input (key/encoder.h, key/event.h, focus.h, paste.h): keys, focus and pastes as the terminal's modes want them.
  ghostty_key_encoder_new: 2,
  ghostty_key_encoder_free: 1,
  ghostty_key_encoder_set: 3,
  ghostty_key_encoder_set_from_terminal: 2,
  ghostty_key_encoder_encode: 5,
  ghostty_key_event_new: 2,
  ghostty_key_event_free: 1,
  ghostty_key_event_set_action: 2,
  ghostty_key_event_set_key: 2,
  ghostty_key_event_set_mods: 2,
  ghostty_key_event_set_consumed_mods: 2,
  ghostty_key_event_set_composing: 2,
  ghostty_key_event_set_utf8: 2,
  ghostty_key_event_set_unshifted_codepoint: 2,
  ghostty_focus_encode: 4,
  ghostty_paste_encode: 6,
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
  /** The module's own description of its types: every other struct offset, enum value and packed bit is read here. */
  readonly manifest: Manifest;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isFn = (v: unknown): v is WasmFn => typeof v === 'function';

function num(v: unknown, what: string): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) throw new Error(`libghostty-vt layout: ${what} is not an offset`);
  return v;
}

/** `ghostty_type_json`'s types: struct sizes and offsets, enum values (by name, without the prefix), packed bits. */
export class Manifest {
  constructor(private readonly types: Record<string, unknown>) {}

  private type(name: string): Record<string, unknown> {
    const t = this.types[name];
    if (!isRecord(t)) throw new Error(`libghostty-vt layout: no ${name}`);
    return t;
  }

  size(name: string): number {
    return num(this.type(name).size, `${name}.size`);
  }

  align(name: string): number {
    return num(this.type(name).align, `${name}.align`);
  }

  offset(name: string, field: string): number {
    const fields = this.type(name).fields;
    const entry = isRecord(fields) ? fields[field] : undefined;
    return num(isRecord(entry) ? entry.offset : undefined, `${name}.${field}`);
  }

  /** An enum's values by name (`ARROW_UP` for GHOSTTY_KEY_ARROW_UP). */
  values(name: string): ReadonlyMap<string, number> {
    const values = this.type(name).values;
    if (!isRecord(values)) throw new Error(`libghostty-vt layout: ${name} is not an enum`);
    const out = new Map<string, number>();
    for (const [k, v] of Object.entries(values)) if (typeof v === 'number') out.set(k, v);
    return out;
  }

  value(name: string, member: string): number {
    const v = this.values(name).get(member);
    if (v === undefined) throw new Error(`libghostty-vt layout: no ${name}.${member}`);
    return v;
  }

  /** A packed type's field: its lowest bit and width. */
  bits(name: string, field: string): { lsb: number; width: number } {
    const bits = this.type(name).bits;
    const entry = isRecord(bits) ? bits[field] : undefined;
    if (!isRecord(entry)) throw new Error(`libghostty-vt layout: no ${name}.${field} bits`);
    return { lsb: num(entry.lsb, `${name}.${field}.lsb`), width: num(entry.width, `${name}.${field}.width`) };
  }
}

/** The module compiled from its bytes, synchronously (Node: off the browser's main thread rules). */
export function compileGhostty(bytes: BufferSource): WebAssembly.Module {
  return new WebAssembly.Module(bytes);
}

/** The module compiled from its bytes, off the main thread (a browser refuses a large module synchronously). */
export function compileGhosttyAsync(bytes: ArrayBuffer): Promise<WebAssembly.Module> {
  return WebAssembly.compile(bytes);
}

/** What each compiled module's instances share: their layout, read from the first. */
const described = new WeakMap<WebAssembly.Module, { layout: Layout; manifest: Manifest }>();

function checked(module: WebAssembly.Module, exports: WebAssembly.Exports): GhosttyInstance {
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
  let d = described.get(module);
  if (!d) {
    d = describe(complete, memory);
    described.set(module, d);
  }
  return { fn: complete, memory, table, ...d };
}

/** A new instance of the module, its exports checked (names, parameter counts) and its struct layout read. Throws if it can't be. */
export function instantiateGhostty(module: WebAssembly.Module): GhosttyInstance {
  return checked(module, new WebAssembly.Instance(module, {}).exports);
}

/** The same, without blocking (the browser). */
export async function instantiateGhosttyAsync(module: WebAssembly.Module): Promise<GhosttyInstance> {
  return checked(module, (await WebAssembly.instantiate(module, {})).exports);
}

// ---- the struct layout --------------------------------------------------------------------------------------------

function describe(fn: GhosttyFunctions, memory: WebAssembly.Memory): { layout: Layout; manifest: Manifest } {
  const at = fn.ghostty_type_json();
  const bytes = new Uint8Array(memory.buffer);
  const end = bytes.indexOf(0, at);
  const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes.subarray(at, end < 0 ? at : end)));
  if (!isRecord(parsed) || !isRecord(parsed.types)) throw new Error('libghostty-vt layout: no types');
  if (parsed.library_version !== LIBRARY_VERSION) throw new Error(`libghostty-vt layout: version ${String(parsed.library_version)}`);
  const m = new Manifest(parsed.types);
  const off = (name: string, field: string) => m.offset(name, field);
  const S = 'GhosttyString';
  const P = 'GhosttyTerminalProgramStatus';
  const value = off('GhosttyPoint', 'value');
  const layout: Layout = {
    string: { ptr: off(S, 'ptr'), len: off(S, 'len') },
    modeConfig: {
      size: m.size('GhosttyTerminalModeConfig'),
      mode: off('GhosttyTerminalModeConfig', 'mode'),
      value: off('GhosttyTerminalModeConfig', 'value'),
    },
    point: {
      size: m.size('GhosttyPoint'),
      align: m.align('GhosttyPoint'),
      tag: off('GhosttyPoint', 'tag'),
      x: value + off('GhosttyPointCoordinate', 'x'),
      y: value + off('GhosttyPointCoordinate', 'y'),
    },
    selection: {
      size: m.size('GhosttySelection'),
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
    rgb: {
      size: m.size('GhosttyColorRgb'),
      r: off('GhosttyColorRgb', 'r'),
      g: off('GhosttyColorRgb', 'g'),
      b: off('GhosttyColorRgb', 'b'),
    },
  };
  return { layout, manifest: m };
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
 * The module is a few dozen bytes: compiled synchronously, which a browser allows for one that small.
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
