import fs from 'node:fs';
import path from 'node:path';
import { checkedOutBranch, gitDirs } from './git-head.js';

/**
 * Which branches a checkout has been on, read from its reflog files — no
 * `git` process. A checkout's own `logs/HEAD` has a line per move of HEAD
 * (`checkout: moving from feat/x to fix/y`, a commit, a reset…), each with
 * its time; a branch's own reflog in the shared folder
 * (`logs/refs/heads/<name>`) starts with where it was made from
 * (`branch: Created from origin/dev`). The parsing is pure; the reads are
 * small files.
 */

export interface ReflogLine {
  /** When, in ms. */
  at: number;
  /** What git wrote after the tab: `checkout: moving from a to b`, `commit: …`. */
  message: string;
}

/** `<old> <new> Name <email> 1793784300 +0100\t<message>` → its time and message; null for a line that isn't one. */
export function parseReflogLine(line: string): ReflogLine | null {
  const tab = line.indexOf('\t');
  if (tab < 0) return null;
  const m = /\s(\d+)\s+[+-]\d{4}\s*$/.exec(line.slice(0, tab));
  if (!m) return null;
  return { at: Number(m[1]) * 1000, message: line.slice(tab + 1).trim() };
}

/** A checkout target that names a branch: not a commit (detached), not a remote-tracking ref, not HEAD. */
export function looksLikeBranch(name: string): boolean {
  if (!name || name === 'HEAD' || /\s/.test(name)) return false;
  if (/^[0-9a-f]{7,40}$/.test(name)) return false;
  if (/^(?:origin|upstream)\//.test(name) || name.startsWith('refs/remotes/')) return false;
  return true;
}

export interface ReflogBranch {
  name: string;
  /** When HEAD first came to it (ms): its first sighting in this reflog. */
  firstSeen: number;
  /** When HEAD was last on it (ms): the last line written while it was checked out. */
  lastSeen: number;
  /** The branch HEAD left to come to it, the first time. */
  movedFrom?: string;
}

/**
 * The branches a checkout's HEAD reflog shows it on, in the order it came to
 * them. `start`: the branch it was on before the first move the reflog shows
 * (the session's own); `current`: what HEAD names now — a reflog cut short
 * still has it. Pure.
 */
export function branchesFromReflog(lines: ReflogLine[], opts: { start?: string | null; current?: string | null } = {}): ReflogBranch[] {
  const out = new Map<string, ReflogBranch>();
  const firstMove = lines.map((l) => moveOf(l.message)).find((m) => m !== null);
  // Before the first move HEAD was on the branch it moved from — the start branch, when the reflog has no move.
  let on: string | null = firstMove?.from ?? opts.start ?? opts.current ?? null;
  const see = (name: string | null, at: number, from?: string) => {
    if (!name || !looksLikeBranch(name)) return;
    const b = out.get(name);
    if (b) b.lastSeen = Math.max(b.lastSeen, at);
    else out.set(name, { name, firstSeen: at, lastSeen: at, ...(from && looksLikeBranch(from) ? { movedFrom: from } : {}) });
  };
  for (const l of lines) {
    const move = moveOf(l.message);
    if (move) {
      see(on, l.at);
      on = move.to;
      see(on, l.at, move.from);
      continue;
    }
    // `rebase (finish): returning to refs/heads/x`: back on x after a rebase's detached steps.
    const back = /returning to refs\/heads\/(.+)$/.exec(l.message);
    if (back) on = back[1].trim();
    see(on, l.at);
  }
  if (opts.current && !out.has(opts.current) && looksLikeBranch(opts.current)) {
    const at = lines.length ? lines[lines.length - 1].at : 0;
    out.set(opts.current, { name: opts.current, firstSeen: at, lastSeen: at });
  }
  return [...out.values()];
}

function moveOf(message: string): { from: string; to: string } | null {
  const m = /^checkout: moving from (\S+) to (\S+)$/.exec(message);
  return m ? { from: m[1], to: m[2] } : null;
}

/** `branch: Created from origin/dev` (a branch's own reflog, its first line) → `origin/dev`; null when it says nothing of the kind. */
export function createdFromLine(message: string): string | null {
  const m = /^branch: Created from (\S+)$/.exec(message);
  return m ? m[1] : null;
}

/** Lines of a reflog file, oldest first; [] when it isn't there. At most the last `max` lines (a reflog grows for good). */
export function readReflog(file: string, max = 5000): ReflogLine[] {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const lines = text.split(/\r?\n/);
  return lines
    .slice(Math.max(0, lines.length - max))
    .map(parseReflogLine)
    .filter((l): l is ReflogLine => l !== null);
}

/**
 * Where a branch was made from, as its own reflog says (`origin/dev`), or —
 * made from HEAD (`Created from HEAD`) — the branch HEAD left for it
 * (`movedFrom`). Null when neither says. Reads one small file.
 */
export function branchCreatedFrom(commonDir: string, name: string, movedFrom?: string): string | null {
  const first = readReflog(path.join(commonDir, 'logs', 'refs', 'heads', ...name.split('/')), 50)[0];
  const from = first ? createdFromLine(first.message) : null;
  if (from && from !== 'HEAD') return from;
  return movedFrom ?? null;
}

/**
 * The branches a checkout has been on (its HEAD reflog), each with where it
 * was made from when its own reflog says. File reads only. `start`: the
 * session's branch. [] when it isn't a checkout.
 */
export function checkoutBranchHistory(checkout: string, start?: string | null): Array<ReflogBranch & { from?: string }> {
  const dirs = gitDirs(checkout);
  if (!dirs) return [];
  const lines = readReflog(path.join(dirs.gitDir, 'logs', 'HEAD'));
  return branchesFromReflog(lines, { start: start ?? null, current: checkedOutBranch(checkout) }).map((b) => {
    const from = branchCreatedFrom(dirs.commonDir, b.name, b.movedFrom);
    return from && from !== b.name ? { ...b, from } : b;
  });
}
