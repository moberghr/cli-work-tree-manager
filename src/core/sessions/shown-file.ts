import fs from 'node:fs';
import path from 'node:path';
import { refusedPath } from '../worktree/terminal-paths.js';

/**
 * A file a session shows beside its terminal (asked for: an agent wrote a spec and asked for approval, and reading
 * the spec meant leaving the terminal for the Code tab and coming back to answer). The agent, or you, names a file
 * of the session (`work show <file>`); the Terminal tab draws it next to the terminal — Markdown rendered with its
 * contents, an image as an image, anything else as text — and follows the file as it changes.
 *
 * Only a file the Code tab would show: inside one of the session's folders and not ignored by git (the routes check
 * through `codeFilePath`) — or one in its agent's own scratch folders (`tempFolders`: Claude writes an artifact's HTML
 * there before it publishes it), judged on the real path (`findTempFile`). What is shown is work web's memory: gone
 * with a restart, as the pane's content is the file.
 */

export interface ShownFile {
  /** The repo's folder name (the Code tab's); '' for a file of a session folder's own. */
  repo: string;
  /** Its path under that repo, `/` separated. */
  path: string;
  /** When it was shown (ISO): a file shown again is shown anew. */
  at: string;
  /** A file of the agent's scratch folders, not one the Code tab lists: its real path (`repo` is '', `path` its name). */
  temp?: string;
}

export type ShownKind = 'markdown' | 'image' | 'html' | 'text';

/** How a shown file is drawn, from its name. An SVG is text: drawn as an image it could carry a script. Pure. */
export function shownKind(file: string): ShownKind {
  const ext = file.slice(file.lastIndexOf('.') + 1).toLowerCase();
  if (ext === 'md' || ext === 'markdown' || ext === 'mdx') return 'markdown';
  // Drawn in a sandboxed frame (its own origin, scripts on: an artifact is often interactive), never as part of the page.
  if (ext === 'html' || ext === 'htm') return 'html';
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'avif'].includes(ext)) return 'image';
  return 'text';
}

/** An image's type for the browser, from its name; null: not one we serve as an image. Pure. */
export function imageType(file: string): string | null {
  const ext = file.slice(file.lastIndexOf('.') + 1).toLowerCase();
  const types: Record<string, string> = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    bmp: 'image/bmp',
    avif: 'image/avif',
  };
  return types[ext] ?? null;
}

const norm = (p: string) => path.resolve(p).replace(/\\/g, '/').replace(/\/+$/, '');
const sameStart = (a: string, b: string) => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);

/**
 * Which of the session's repos a file is in, and its path there — the deepest folder that holds it, so a repo inside
 * a session folder wins over the folder itself. A session folder's own file (beside its repos) is repo ''. Null:
 * the file is in none of them. Pure (no disk): the routes still check it is a real file the Code tab lists.
 */
export function locateInSession(s: { paths: readonly string[]; isGroup?: boolean }, file: string): { repo: string; path: string } | null {
  const target = norm(file);
  const roots = s.paths.map((p) => ({ repo: path.basename(norm(p)), root: norm(p) }));
  if (s.isGroup && roots.length) {
    const parents = [...new Set(roots.map((r) => path.posix.dirname(r.root)))];
    if (parents.length === 1) roots.push({ repo: '', root: parents[0] });
  }
  const holding = roots
    .filter((r) => target.length > r.root.length + 1 && sameStart(target.slice(0, r.root.length + 1), `${r.root}/`))
    .sort((a, b) => b.root.length - a.root.length)[0];
  if (!holding) return null;
  const rel = target.slice(holding.root.length + 1);
  // A session folder's own files are the ones right in it: one in a subfolder that is no repo isn't shown.
  if (holding.repo === '' && rel.includes('/')) return null;
  return { repo: holding.repo, path: rel };
}

/** Whether a real path is inside one of these folders (themselves real paths): a file under one, never the folder. Pure. */
export function insideFolders(real: string, folders: readonly string[], platform: NodeJS.Platform = process.platform): boolean {
  const fold = (p: string) => {
    const n = p.replace(/\\/g, '/').replace(/\/+$/, '');
    return platform === 'win32' ? n.toLowerCase() : n;
  };
  const target = fold(real);
  return folders.some((f) => {
    const root = fold(f);
    return root.length > 0 && target.length > root.length + 1 && target.startsWith(`${root}/`);
  });
}

export interface TempIo {
  realpath(p: string): Promise<string>;
  stat(p: string): Promise<{ isFile(): boolean; size: number }>;
}
const realTempIo: TempIo = { realpath: (p) => fs.promises.realpath(p), stat: (p) => fs.promises.stat(p) };

/**
 * A file in the agent's scratch folders, as it is on disk: its real path (links followed — one pointing out of them is
 * refused) and size, or why not. The folders are taken as given: real paths already, checked by whoever named them
 * (`sessionTempFolders`), never resolved here, so a folder that is a link can't widen what is shown. Another machine's
 * path is refused before anything is looked at (`refusedPath`). Checked again on every read, so a file swapped for a
 * link afterwards is refused then.
 */
export async function findTempFile(
  file: string,
  folders: readonly string[],
  io: TempIo = realTempIo,
  platform: NodeJS.Platform = process.platform,
): Promise<{ real: string; size: number } | { error: string }> {
  if (refusedPath(file, file, platform) || !(platform === 'win32' ? path.win32 : path.posix).isAbsolute(file))
    return { error: 'not a local absolute path' };
  let real: string;
  try {
    real = await io.realpath(file);
  } catch {
    return { error: 'not there' };
  }
  if (!insideFolders(real, folders, platform)) return { error: 'outside' };
  try {
    const st = await io.stat(real);
    if (!st.isFile()) return { error: 'not a file' };
    return { real, size: st.size };
  } catch {
    return { error: 'not there' };
  }
}

/**
 * A shown file's bytes, read without following a link put in its place since it was checked (`O_NOFOLLOW`; Windows has
 * none, and its scratch folder is the user's own), only a plain file, and never more than `limit`: past it, 'too large'.
 */
export async function readShownFile(real: string, limit: number): Promise<{ bytes: Buffer } | { error: 'not there' | 'too large' }> {
  let fh: fs.promises.FileHandle;
  try {
    fh = await fs.promises.open(real, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  } catch {
    return { error: 'not there' };
  }
  try {
    const st = await fh.stat();
    if (!st.isFile()) return { error: 'not there' };
    if (st.size > limit) return { error: 'too large' };
    const buf = Buffer.alloc(limit + 1);
    let n = 0;
    while (n < buf.length) {
      const { bytesRead } = await fh.read(buf, n, buf.length - n, n);
      if (bytesRead === 0) break;
      n += bytesRead;
    }
    return n > limit ? { error: 'too large' } : { bytes: buf.subarray(0, n) };
  } catch {
    return { error: 'not there' };
  } finally {
    await fh.close().catch(() => undefined);
  }
}

/** Where a shown file is on disk, for the pane's Open in app / Show in Finder: a temp file's real path, else its repo's folder joined with its path. Pure. */
export function shownAbsolute(
  s: { paths: readonly string[]; isGroup?: boolean },
  f: Pick<ShownFile, 'repo' | 'path' | 'temp'>,
): string | null {
  if (f.temp) return f.temp;
  const root =
    f.repo === '' ? (s.isGroup && s.paths[0] ? path.dirname(s.paths[0]) : null) : s.paths.find((p) => path.basename(norm(p)) === f.repo);
  return root ? path.join(root, ...f.path.split('/')) : null;
}

/** What the pane beside a session's terminal shows: the shown file, or one of the session's own views. */
export type PaneTab = 'file' | 'diff' | 'code' | 'review';
export const PANE_TABS: readonly PaneTab[] = ['file', 'diff', 'code', 'review'];

/** A place the Code view opens at (`work show --code <file>:<line>`). */
export interface PanePlace {
  repo: string;
  path: string;
  line?: number;
}

export interface PaneView {
  tab: PaneTab;
  /** When it was asked for (ISO): asked again, the pane goes to it again (a new place in Code). */
  at: string;
  /** Code only: where to open. */
  place?: PanePlace;
}

/**
 * What sessions show beside their terminals, in memory: the pane (which view is on, or none: closed) and the file it
 * shows (one a session: showing another replaces it). Showing a file opens the pane on it; closing the pane forgets it.
 */
export function createShownFiles(deps: { onChange: (sessionId: string) => void; now?: () => Date }) {
  const shown = new Map<string, ShownFile>();
  const panes = new Map<string, PaneView>();
  const now = () => (deps.now?.() ?? new Date()).toISOString();
  return {
    get: (sessionId: string): ShownFile | null => shown.get(sessionId) ?? null,
    pane: (sessionId: string): PaneView | null => panes.get(sessionId) ?? null,
    show(sessionId: string, file: { repo: string; path: string; temp?: string }): ShownFile {
      const next: ShownFile = { repo: file.repo, path: file.path, at: now() };
      if (file.temp) next.temp = file.temp;
      shown.set(sessionId, next);
      panes.set(sessionId, { tab: 'file', at: next.at });
      deps.onChange(sessionId);
      return next;
    },
    /** Opens the pane on a view. Null (nothing changes) for the file's when no file is shown. */
    open(sessionId: string, tab: PaneTab, place?: PanePlace): PaneView | null {
      if (tab === 'file' && !shown.has(sessionId)) return null;
      const view: PaneView = { tab, at: now() };
      if (tab === 'code' && place) view.place = place;
      panes.set(sessionId, view);
      deps.onChange(sessionId);
      return view;
    },
    /** Closes the pane and forgets its file. False when it showed nothing. */
    close(sessionId: string): boolean {
      const had = panes.delete(sessionId) || shown.has(sessionId);
      shown.delete(sessionId);
      if (!had) return false;
      deps.onChange(sessionId);
      return true;
    },
  };
}
