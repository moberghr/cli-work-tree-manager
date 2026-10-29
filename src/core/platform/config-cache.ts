import fs from 'node:fs';
import path from 'node:path';
import { configDirPath } from './config-dir.js';

/**
 * config.json as raw JSON, read again only when the file changed (its path, size and mtime): what the per-row lookups
 * share (the agent settings, agents/index.ts; Claude's accounts, agents/claude/accounts.ts), since a full loadConfig per
 * session row was a read and a parse each time. Light on purpose (node builtins and config-dir): launch paths ask it.
 */

type Raw = Record<string, unknown> | null;

let kept: { key: string; raw: Raw } | null = null;

/** The file's identity now ('' when there is none), and what it holds (null: no file, or one that doesn't parse). */
function current(): { key: string; raw: Raw } {
  // A read: ~/.work isn't made for it (postinstall's skills install asks, and must write nothing there).
  const file = path.join(configDirPath(), 'config.json');
  let key: string;
  try {
    const st = fs.statSync(file);
    key = `${file}|${st.size}|${st.mtimeMs}`;
  } catch {
    return { key: '', raw: null };
  }
  if (kept?.key === key) return kept;
  let raw: Raw = null;
  try {
    const v: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
    raw = v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    /* unreadable: as if there were none */
  }
  kept = { key, raw };
  return kept;
}

/**
 * A view of the config: `derive` runs on the raw JSON once per change of the file (so a warning it gives is said once per
 * change, not per read), and its value is handed out until the next change. `derive` gets null when there is no file.
 */
export function configView<T>(derive: (raw: Raw) => T): () => T {
  let mine: { key: string; value: T } | null = null;
  return () => {
    const { key, raw } = current();
    if (mine?.key === key && key !== '') return mine.value;
    const value = derive(raw);
    mine = { key, value };
    return value;
  };
}
