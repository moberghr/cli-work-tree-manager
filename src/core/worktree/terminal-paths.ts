import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { WorktreeSession } from '../sessions/history.js';
import type { TerminalPathWire } from '../api-types.js';
import { codeRoots, groupRoot, listRepoFiles } from './code-browse.js';
import { splitLine } from './terminal-path-refs.js';
import { openWithDefaultApp, revealInFileManager, startEditor } from '../platform/launch.js';

/**
 * A path a session's terminal printed (terminal-path-refs.ts finds them): where it is on disk, and how a click opens it.
 *
 * Terminal text is not trusted (an agent prints what it read), so nothing here starts a file. The system's default app
 * gets only the viewer types below, judged on the real path after links are followed; any other file goes to the editor
 * as a file to show, and a folder is revealed (a `.app` is a folder that runs). Opening resolves the path again and takes
 * nothing the browser said about it.
 */

/** Opened with the system's default app: types it shows, never runs. Lower case, without the dot. */
export const VIEWER_EXTENSIONS: ReadonlySet<string> = new Set(['html', 'htm', 'pdf', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'svg']);

/** A `:line` past this is ignored (the editor routes take no more). */
export const MAX_TERMINAL_LINE = 10_000_000;

type Session = Pick<WorktreeSession, 'paths' | 'isGroup'>;

export interface TerminalPathIo {
  /** A repo's listed files, relative and `/`-separated: what the Code tab lists (code-browse.ts). */
  listFiles: (root: string) => Promise<string[]>;
}

const realIo: TerminalPathIo = {
  listFiles: (root) => listRepoFiles(root),
};

interface OnDisk {
  real: string;
  kind: 'file' | 'dir';
}

/** The candidate's real path (links followed) and what it is; null for anything missing, unreadable, or not a file or folder. */
function onDisk(candidate: string): OnDisk | null {
  try {
    const real = fs.realpathSync.native(candidate);
    const st = fs.statSync(real);
    if (st.isDirectory()) return { real, kind: 'dir' };
    if (st.isFile()) return { real, kind: 'file' };
    return null; // a socket, a device: nothing to open
  } catch {
    return null; // gone, unreadable, a dangling link: as good as missing
  }
}

function found(raw: string, at: OnDisk, line: number | undefined): TerminalPathWire {
  if (at.kind === 'dir') return { raw, path: at.real, kind: 'dir', opens: 'reveal' };
  // The real path's type, not the printed one: a `notes.html` linking to a `run.sh` is a script.
  const ext = path.extname(at.real).slice(1).toLowerCase();
  const opens = VIEWER_EXTENSIONS.has(ext) ? 'app' : 'editor';
  return line === undefined ? { raw, path: at.real, kind: 'file', opens } : { raw, path: at.real, kind: 'file', opens, line };
}

const missing = (raw: string): TerminalPathWire => ({ raw, path: null, kind: 'missing', opens: null });

/** Folders a relative path is tried against, in order: a group's own folder, then each repo's worktree. */
function relativeRoots(session: Session): string[] {
  const group = groupRoot(session);
  return [...(group ? [group] : []), ...codeRoots(session).map((r) => r.root)];
}

/**
 * The session's listed files that `rel` names: the file itself, or one it is the end of (`Dashboard/SessionRail.tsx` for
 * `src/web/src/components/Dashboard/SessionRail.tsx`, `SessionRail.tsx` for any folder's). Each by its real path, once.
 */
async function listedMatches(session: Session, rel: string, io: TerminalPathIo): Promise<OnDisk[]> {
  const want = rel.replace(/\\/g, '/').replace(/^(?:\.\/)+/, '');
  if (!want || want.split('/').includes('..')) return [];
  const lists = await Promise.all(
    codeRoots(session).map(async ({ root }) => {
      if (!fs.existsSync(root)) return { root, files: [] as string[] };
      try {
        return { root, files: await io.listFiles(root) };
      } catch {
        return { root, files: [] as string[] }; // git could not list it: nothing found there
      }
    }),
  );
  const hits = new Map<string, OnDisk>();
  for (const { root, files } of lists) {
    for (const f of files) {
      if (f !== want && !f.endsWith('/' + want)) continue;
      const at = onDisk(path.join(root, f));
      if (at) hits.set(at.real, at);
    }
  }
  return [...hits.values()];
}

/**
 * Where `raw` (a piece of terminal text, `:line` and `file://` allowed) is on disk, and how a click opens it. Absolute
 * paths as they are (`~` is the home folder); a relative one against the group's folder, then each repo; one that is
 * nowhere there by the session's listed files (a bare name, or the end of a path): one match is that file, several are
 * `ambiguous`. Never throws: anything that fails is `missing`.
 */
export async function resolveTerminalPath(session: Session, raw: string, io: TerminalPathIo = realIo): Promise<TerminalPathWire> {
  try {
    const split = splitLine(raw);
    const p = split.path;
    const line = split.line !== undefined && split.line <= MAX_TERMINAL_LINE ? split.line : undefined;
    if (!p) return missing(raw);

    if (/^~(?=$|[\\/])/.test(p)) {
      const at = onDisk(path.join(os.homedir(), p.slice(1)));
      return at ? found(raw, at, line) : missing(raw);
    }
    if (path.isAbsolute(p)) {
      const at = onDisk(p);
      return at ? found(raw, at, line) : missing(raw);
    }
    // A Windows drive path on another system: it cannot be here.
    if (/^[A-Za-z]:[\\/]/.test(p)) return missing(raw);

    for (const root of relativeRoots(session)) {
      const at = onDisk(path.resolve(root, p));
      if (at) return found(raw, at, line);
    }
    const matches = await listedMatches(session, p, io);
    if (matches.length === 1) return found(raw, matches[0], line);
    if (matches.length > 1) return { raw, path: null, kind: 'ambiguous', opens: 'search' };
    return missing(raw);
  } catch {
    return missing(raw); // a listing that failed, a path the platform refuses: not a link
  }
}

/** How the browser asked to open a path: a plain click (`default`), or one of the menu's. */
export type TerminalPathHow = 'default' | 'editor' | 'reveal';

export type OpenTerminalPathResult = { ok: true; opened: string } | { error: 'missing' | 'ambiguous' | 'failed'; message?: string };

/** What opens a path (launch.ts), and the listing; tests inject them to see what would start. */
export interface OpenTerminalPathDeps {
  startEditor: (folder: string, file?: { path: string; line?: number }) => Promise<string | null>;
  openWithDefaultApp: (target: string) => Promise<string | null>;
  revealInFileManager: (target: string) => Promise<string | null>;
  io: TerminalPathIo;
}

/**
 * The editor's window for `real`: the session's folder (a group's folder, as the open-editor route) when the file is in
 * it, else the file's own folder.
 */
function editorFolder(session: Session, real: string): string {
  const first = session.paths[0] as string | undefined;
  const folder = first && session.isGroup ? path.dirname(first) : first;
  if (folder) {
    let realFolder = folder;
    try {
      realFolder = fs.realpathSync.native(folder);
    } catch {
      // The folder is gone: compared as written (the file then is not in it).
    }
    const rel = path.relative(realFolder, real);
    if (rel && rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel)) return folder;
  }
  return path.dirname(real);
}

/**
 * Open a path from the terminal. Resolves `raw` again (nothing the browser said about it is taken), then: `reveal`, or a
 * folder, shows it in the file manager; `editor`, or any file that is not a viewer type, goes to the editor at its line;
 * only `default` on a viewer type starts the system's default app.
 */
export async function openTerminalPath(
  session: Session,
  raw: string,
  how: TerminalPathHow,
  deps: Partial<OpenTerminalPathDeps> = {},
): Promise<OpenTerminalPathResult> {
  const r = await resolveTerminalPath(session, raw, deps.io ?? realIo);
  if (r.kind === 'ambiguous') return { error: 'ambiguous' };
  if (r.kind === 'missing' || r.path === null) return { error: 'missing' };
  const real = r.path;

  let failed: string | null;
  if (how === 'reveal' || r.kind === 'dir') {
    failed = await (deps.revealInFileManager ?? revealInFileManager)(real);
  } else if (how === 'editor' || r.opens !== 'app') {
    const file = r.line === undefined ? { path: real } : { path: real, line: r.line };
    failed = await (deps.startEditor ?? startEditor)(editorFolder(session, real), file);
  } else {
    failed = await (deps.openWithDefaultApp ?? openWithDefaultApp)(real);
  }
  return failed ? { error: 'failed', message: failed } : { ok: true, opened: real };
}
