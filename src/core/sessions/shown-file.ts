import path from 'node:path';

/**
 * A file a session shows beside its terminal (asked for: an agent wrote a spec and asked for approval, and reading
 * the spec meant leaving the terminal for the Code tab and coming back to answer). The agent, or you, names a file
 * of the session (`work show <file>`); the Terminal tab draws it next to the terminal — Markdown rendered with its
 * contents, an image as an image, anything else as text — and follows the file as it changes.
 *
 * Only a file the Code tab would show: inside one of the session's folders and not ignored by git (the routes check
 * through `codeFilePath`). What is shown is work web's memory: gone with a restart, as the pane's content is the file.
 */

export interface ShownFile {
  /** The repo's folder name (the Code tab's); '' for a file of a session folder's own. */
  repo: string;
  /** Its path under that repo, `/` separated. */
  path: string;
  /** When it was shown (ISO): a file shown again is shown anew. */
  at: string;
}

export type ShownKind = 'markdown' | 'image' | 'text';

/** How a shown file is drawn, from its name. An SVG is text: drawn as an image it could carry a script. Pure. */
export function shownKind(file: string): ShownKind {
  const ext = file.slice(file.lastIndexOf('.') + 1).toLowerCase();
  if (ext === 'md' || ext === 'markdown' || ext === 'mdx') return 'markdown';
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

/** The files sessions show, in memory (one a session: showing another replaces it). */
export function createShownFiles(deps: { onChange: (sessionId: string) => void; now?: () => Date }) {
  const shown = new Map<string, ShownFile>();
  return {
    get: (sessionId: string): ShownFile | null => shown.get(sessionId) ?? null,
    show(sessionId: string, file: { repo: string; path: string }): ShownFile {
      const next = { repo: file.repo, path: file.path, at: (deps.now?.() ?? new Date()).toISOString() };
      shown.set(sessionId, next);
      deps.onChange(sessionId);
      return next;
    },
    /** False when it showed nothing. */
    close(sessionId: string): boolean {
      if (!shown.delete(sessionId)) return false;
      deps.onChange(sessionId);
      return true;
    },
  };
}
