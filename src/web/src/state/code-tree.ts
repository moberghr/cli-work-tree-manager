import type { CodeFilesWire } from '../../../core/api-types.js';

/**
 * The Code tab's tree, pure. A group's repos are folders beside the group
 * folder's own files; a single repo's files are the tree. Built once per
 * listing into an index by folder, so opening a folder is a lookup (a repo
 * can have tens of thousands of files).
 */

export interface CodeEntry {
  /** `repo` and `path` joined: unique in the session. */
  key: string;
  /** '' for a group folder's own file. */
  repo: string;
  path: string;
  /** As the tree shows it: a group's `repo/path`, else `path`. */
  display: string;
  changed: boolean;
}

export const codeKey = (repo: string, path: string) => `${repo}\u0000${path}`;

export function codeEntries(w: CodeFilesWire): CodeEntry[] {
  const out: CodeEntry[] = [];
  for (const f of w.rootFiles) out.push({ key: codeKey('', f), repo: '', path: f, display: f, changed: false });
  for (const r of w.repos) {
    const changed = new Set(r.changed);
    for (const f of r.files) {
      out.push({ key: codeKey(r.name, f), repo: r.name, path: f, display: w.group ? `${r.name}/${f}` : f, changed: changed.has(f) });
    }
  }
  return out;
}

/**
 * The entry a key names: the listing's, or — a file the listing doesn't have (created since it was read, or past a
 * big repo's cut) — one made up for a repo the listing knows, so a search's pick still opens (the server decides
 * whether it may be read). Null for an unknown repo.
 */
export function entryOf(w: CodeFilesWire, key: string, listed?: ReadonlyMap<string, CodeEntry>): CodeEntry | null {
  const known = listed?.get(key);
  if (known) return known;
  const at = key.indexOf('\u0000');
  if (at < 0) return null;
  const repo = key.slice(0, at);
  const path = key.slice(at + 1);
  if (!path) return null;
  if (repo === '') return w.group ? { key, repo, path, display: path, changed: false } : null;
  const r = w.repos.find((x) => x.name === repo);
  if (!r) return null;
  return { key, repo, path, display: w.group ? `${repo}/${path}` : path, changed: r.changed.includes(path) };
}

export interface Folder {
  /** Sub-folders by name, sorted. */
  dirs: string[];
  files: CodeEntry[];
  /** Changed files anywhere under it. */
  changed: number;
}

/** Every folder ('' = the top) with what's directly in it. */
export function indexFolders(entries: CodeEntry[]): Map<string, Folder> {
  const index = new Map<string, Folder>();
  const folder = (dir: string): Folder => {
    let f = index.get(dir);
    if (!f) index.set(dir, (f = { dirs: [], files: [], changed: 0 }));
    return f;
  };
  const dirSets = new Map<string, Set<string>>();
  folder('');
  for (const e of entries) {
    const parts = e.display.split('/');
    let dir = '';
    for (let i = 0; i < parts.length - 1; i++) {
      const child = dir ? `${dir}/${parts[i]}` : parts[i];
      let set = dirSets.get(dir);
      if (!set) dirSets.set(dir, (set = new Set()));
      set.add(parts[i]);
      if (e.changed) folder(child).changed++;
      else folder(child);
      dir = child;
    }
    folder(dir).files.push(e);
    if (e.changed) folder('').changed++;
  }
  for (const [dir, set] of dirSets) folder(dir).dirs = [...set].sort((a, b) => a.localeCompare(b));
  for (const f of index.values()) f.files.sort((a, b) => a.display.localeCompare(b.display));
  return index;
}

/** The folders holding a file, outermost first ("src", "src/app"): opened to show it. */
export function foldersOf(display: string): string[] {
  const parts = display.split('/');
  return parts.slice(0, -1).map((_, i) => parts.slice(0, i + 1).join('/'));
}

/**
 * Files matching what was typed: every word in its path (any case). A name that starts with the last word first,
 * then a name that has it, then the rest; changed ones first within each; at most `limit`.
 */
export function filterEntries(entries: CodeEntry[], query: string, limit = 200): CodeEntry[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];
  const last = words[words.length - 1];
  const scored: Array<{ e: CodeEntry; score: number }> = [];
  for (const e of entries) {
    const d = e.display.toLowerCase();
    if (!words.every((w) => d.includes(w))) continue;
    const name = d.slice(d.lastIndexOf('/') + 1);
    const score = (name.startsWith(last) ? 0 : name.includes(last) ? 2 : 4) + (e.changed ? 0 : 1);
    scored.push({ e, score });
  }
  scored.sort((a, b) => a.score - b.score || a.e.display.length - b.e.display.length || a.e.display.localeCompare(b.e.display));
  return scored.slice(0, limit).map((x) => x.e);
}
