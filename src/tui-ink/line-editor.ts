/**
 * Pure helpers for the dashboard's raw-stdin input handling:
 *
 * - {@link splitInputChunks} tokenizes a raw stdin chunk into individual key
 *   events (escape sequences) and printable runs, so batched input (held-down
 *   arrow keys, fast mouse wheel, pasted text) isn't dropped or misparsed.
 * - {@link editLine} is a tiny line editor with cursor movement, used by the
 *   branch-name and task text inputs.
 *
 * Both are pure functions so they can be unit-tested without a TTY.
 */

/** Escape sequences understood by the line editor. */
export const KEYS = {
  UP: '\x1B[A',
  DOWN: '\x1B[B',
  RIGHT: '\x1B[C',
  LEFT: '\x1B[D',
  HOME: '\x1B[H',
  END: '\x1B[F',
  HOME_ALT: '\x1B[1~',
  END_ALT: '\x1B[4~',
  PAGE_UP: '\x1B[5~',
  PAGE_DOWN: '\x1B[6~',
  DELETE: '\x1B[3~',
  ESC: '\x1B',
  ENTER: '\r',
  BACKSPACE: '\x7F',
  BACKSPACE_ALT: '\b',
  CTRL_C: '\x03',
  CTRL_D: '\x04',
  CTRL_U: '\x15',
  TAB: '\t',
} as const;

/**
 * Split a raw stdin chunk into discrete tokens: each escape sequence (CSI,
 * SS3, or lone ESC) becomes its own token; consecutive printable characters
 * are grouped into one token (so a paste arrives as a single string).
 * Control characters (other than ESC) are emitted as single-char tokens.
 */
export function splitInputChunks(data: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  let run = '';

  const flushRun = () => {
    if (run) {
      tokens.push(run);
      run = '';
    }
  };

  while (i < data.length) {
    const ch = data[i];
    if (ch === '\x1B') {
      flushRun();
      const next = data[i + 1];
      if (next === '[') {
        // CSI: ESC [ ... final byte in 0x40–0x7E. SGR mouse uses '<' prefix.
        let j = i + 2;
        while (j < data.length) {
          const code = data.charCodeAt(j);
          if (code >= 0x40 && code <= 0x7e) break;
          j++;
        }
        tokens.push(data.slice(i, Math.min(j + 1, data.length)));
        i = j + 1;
        continue;
      }
      if (next === 'O' && i + 2 < data.length) {
        // SS3 (application cursor keys): ESC O <final>
        tokens.push(data.slice(i, i + 3));
        i += 3;
        continue;
      }
      // Lone ESC (or ESC + unknown) — emit ESC alone
      tokens.push('\x1B');
      i++;
      continue;
    }
    const code = data.charCodeAt(i);
    if (code < 32 || code === 0x7f) {
      flushRun();
      tokens.push(ch);
      i++;
      continue;
    }
    run += ch;
    i++;
  }
  flushRun();
  return tokens;
}

/** State of an in-progress single-line text input. */
export interface LineState {
  value: string;
  /** Cursor position, 0..value.length (insertion point). */
  pos: number;
}

export type LineAction = 'submit' | 'cancel' | null;

export interface LineEditResult {
  state: LineState;
  /** 'submit' on Enter, 'cancel' on Esc/Ctrl+C, null otherwise. */
  action: LineAction;
}

/** Strip control characters from pasted text and stop at the first newline. */
export function sanitizePaste(text: string): string {
  const firstLine = text.split(/\r|\n/, 1)[0] ?? '';
  // eslint-disable-next-line no-control-regex
  return firstLine.replace(/[\u0000-\u001f\u007f]/g, '');
}

/**
 * Apply one input token (from {@link splitInputChunks}) to a line-editor
 * state. Returns the new state plus a submit/cancel action when applicable.
 */
export function editLine(state: LineState, token: string): LineEditResult {
  const { value, pos } = state;

  switch (token) {
    case KEYS.ESC:
    case KEYS.CTRL_C:
      return { state, action: 'cancel' };
    case KEYS.ENTER:
      return { state, action: 'submit' };
    case KEYS.BACKSPACE:
    case KEYS.BACKSPACE_ALT:
      if (pos === 0) return { state, action: null };
      return {
        state: { value: value.slice(0, pos - 1) + value.slice(pos), pos: pos - 1 },
        action: null,
      };
    case KEYS.DELETE:
      if (pos >= value.length) return { state, action: null };
      return {
        state: { value: value.slice(0, pos) + value.slice(pos + 1), pos },
        action: null,
      };
    case KEYS.LEFT:
      return { state: { value, pos: Math.max(0, pos - 1) }, action: null };
    case KEYS.RIGHT:
      return { state: { value, pos: Math.min(value.length, pos + 1) }, action: null };
    case KEYS.HOME:
    case KEYS.HOME_ALT:
      return { state: { value, pos: 0 }, action: null };
    case KEYS.END:
    case KEYS.END_ALT:
      return { state: { value, pos: value.length }, action: null };
    case KEYS.CTRL_U:
      // Kill to start of line (readline convention)
      return { state: { value: value.slice(pos), pos: 0 }, action: null };
  }

  // Other escape sequences / control chars: ignore
  if (token.startsWith('\x1B') || token.charCodeAt(0) < 32 || token === '\x7F') {
    return { state, action: null };
  }

  // Printable text (single key or paste) — sanitize and insert at cursor
  const insert = sanitizePaste(token);
  if (!insert) return { state, action: null };
  return {
    state: { value: value.slice(0, pos) + insert + value.slice(pos), pos: pos + insert.length },
    action: null,
  };
}
