import type { CodeSearchWire, CodeSymbolKind } from '../../../core/api-types.js';
import type { CodeEntry } from './code-tree.js';

/**
 * The Code tab's search box (Ctrl+T, as Visual Studio's): what it lists,
 * pure. Types and members by name first, then files by path, then lines
 * with the text in them — each a place to open (a file, and a line in it).
 */

export interface CodePlace {
  repo: string;
  path: string;
  /** 1-based; none: the file's top. */
  line?: number;
}

/**
 * Whether a key opens (or closes) the search: Ctrl+T (⌘T) alone, only in the desktop app — a browser tab keeps
 * Ctrl+T for a new tab, which preventDefault can't stop, and the box would be waiting when you came back —, not
 * for an archived session, and not over another dialog (its own excepted, which Ctrl+T closes).
 */
export function isSearchKey(
  e: Pick<KeyboardEvent, 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey' | 'key'>,
  at: { inApp: boolean; archived: boolean; modal: boolean; searching: boolean },
): boolean {
  if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey || e.key.toLowerCase() !== 't') return false;
  return at.inApp && !at.archived && (!at.modal || at.searching);
}

export interface SearchRow extends CodePlace {
  key: string;
  kind: 'symbol' | 'file' | 'text';
  /** What it is: a name, a file name, the matching line. */
  label: string;
  /** Where: its path (and line), or the kind of declaration. */
  sub: string;
  /** A declaration's kind ("class", "method"). */
  symbolKind?: CodeSymbolKind;
}

export interface SearchGroup {
  title: string;
  rows: SearchRow[];
}

/** At most this many of each kind are listed. */
export const SHOWN = { symbols: 15, files: 8, text: 100 } as const;

const where = (repo: string, path: string, group: boolean) => (group && repo ? `${repo}/${path}` : path);

/** The groups to show, in order, each only when it has something. `files` are the tree's matches (filterEntries). */
export function searchGroups(wire: CodeSearchWire | null, files: CodeEntry[], group: boolean): SearchGroup[] {
  const out: SearchGroup[] = [];
  const symbols = (wire?.symbols ?? []).slice(0, SHOWN.symbols).map((s): SearchRow => ({
    key: `s:${s.repo}:${s.path}:${s.line}:${s.name}`,
    kind: 'symbol',
    repo: s.repo,
    path: s.path,
    line: s.line,
    label: s.name,
    sub: `${s.kind} · ${where(s.repo, s.path, group)}:${s.line}`,
    symbolKind: s.kind,
  }));
  if (symbols.length) out.push({ title: 'Types & members', rows: symbols });
  const fileRows = files.slice(0, SHOWN.files).map((f): SearchRow => ({
    key: `f:${f.key}`,
    kind: 'file',
    repo: f.repo,
    path: f.path,
    label: f.display.slice(f.display.lastIndexOf('/') + 1),
    sub: f.display,
  }));
  if (fileRows.length) out.push({ title: 'Files', rows: fileRows });
  const text = (wire?.text ?? []).slice(0, SHOWN.text).map((t): SearchRow => ({
    key: `t:${t.repo}:${t.path}:${t.line}`,
    kind: 'text',
    repo: t.repo,
    path: t.path,
    line: t.line,
    label: t.text.trim(),
    sub: `${where(t.repo, t.path, group)}:${t.line}`,
  }));
  if (text.length) {
    const more = (wire?.text.length ?? 0) > SHOWN.text || wire?.truncated;
    out.push({ title: more ? `Text · the first ${text.length}` : `Text · ${text.length}`, rows: text });
  }
  return out;
}

/** Where `query` is in `text` (smart case, as the server searched), to mark it; null when it isn't. */
export function matchRange(text: string, query: string): [number, number] | null {
  const q = query.trim();
  if (!q) return null;
  const any = q === q.toLowerCase();
  const at = (any ? text.toLowerCase() : text).indexOf(any ? q.toLowerCase() : q);
  return at < 0 ? null : [at, at + q.length];
}
