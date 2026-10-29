import fs from 'node:fs';
import path from 'node:path';
import type { WorktreeSession } from '../../sessions/session-types.js';
import { loadConfig } from '../../platform/config.js';
import { isOwnCheckout } from '../../worktree/own-checkout.js';
import type { AccountInfo, AgentAccounts } from '../types.js';
import { accountDir, claudeAccounts, defaultAccountName, isLoggedIn, sessionAccount } from './accounts.js';
import { claudeAccountAdmin } from './account-admin.js';
import { encodeProjectDir, projectsRootOf, sessionRunFolders } from './activity.js';

/**
 * Moving a session's conversations from one Claude account's folder to another's (a switch of account): for each folder
 * its Claude runs in, what is in `<from>/projects/<encoded cwd>/` — transcripts, subagents, memory — goes to the same
 * place under `<to>/projects/`, merged with what is there. Nothing is overwritten: a file the target already has under the
 * same name stays the one with the newer write, and the other is kept beside it under a suffix. A move that fails part
 * way puts back what it moved.
 */

export interface MoveResult {
  /** What went across: the new paths of the entries moved (the files and folders that had no counterpart in the target). */
  moved: string[];
}

/** A move that failed: what it was doing, and whether everything it had moved is back where it was. */
export class AccountMoveError extends Error {
  constructor(
    message: string,
    /** The entry that failed. */
    readonly failed: string,
    /** Entries put back. */
    readonly restored: string[],
    /** Entries that could not be put back (still in the target's folder): the move's failure left them there. */
    readonly stuck: string[],
  ) {
    super(message);
  }
}

/** One thing done, to be undone in reverse: `from` became `to`. */
interface Step {
  from: string;
  to: string;
}

const isDir = (p: string) => {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
};
const exists = (p: string) => {
  try {
    fs.lstatSync(p);
    return true;
  } catch {
    return false;
  }
};
const mtime = (p: string) => {
  try {
    return fs.statSync(p).mtimeMs;
  } catch {
    return 0;
  }
};

/** A rename; across volumes (EXDEV) or where Windows refuses a rename of a folder (EPERM), a copy and then a delete. */
function moveEntry(from: string, to: string): void {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  try {
    fs.renameSync(from, to);
    return;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'EXDEV' && code !== 'EPERM') throw err;
  }
  // Copy first, delete after: a copy that fails leaves the original whole (the half-copy is removed). Each file keeps its
  // times: a transcript's mtime is what `--continue` picks the newest by, and what a merge keeps the newer of.
  try {
    fs.cpSync(from, to, { recursive: true, errorOnExist: true, force: false, preserveTimestamps: true });
  } catch (err) {
    fs.rmSync(to, { recursive: true, force: true });
    throw err;
  }
  try {
    fs.rmSync(from, { recursive: true, force: true });
  } catch (err) {
    // The original went only in part (a file in use stopped the delete): not moved. What the delete took is put back from
    // the copy — never over what is still there —, and only then is the copy taken back, so the entry is whole where it
    // was. Should putting it back fail, the copy stays too: in both places, never in neither.
    try {
      fs.cpSync(to, from, { recursive: true, force: false, errorOnExist: false, preserveTimestamps: true });
    } catch (back) {
      const why = (e: unknown) => (e instanceof Error ? e.message : String(e));
      throw new Error(`${why(err)}; what its delete took couldn't be put back (${why(back)}), so it is kept at ${to} too`, {
        cause: back,
      });
    }
    try {
      fs.rmSync(to, { recursive: true, force: true });
    } catch {
      /* the copy stays (whole or in part): every file is still in `from`, some in both */
    }
    throw err;
  }
}

/** `<name>.from-<tag>`, or with a number when that is taken too. */
function suffixed(file: string, tag: string): string {
  const base = `${file}.from-${tag}`;
  if (!exists(base)) return base;
  for (let n = 2; ; n++) if (!exists(`${base}-${n}`)) return `${base}-${n}`;
}

/** Move what is in `src` into `dst`, merging; every step is recorded in `steps` (and in `moved` when it brought something over). */
function mergeInto(src: string, dst: string, tag: string, steps: Step[], moved: string[]): void {
  if (!exists(dst)) {
    moveEntry(src, dst);
    steps.push({ from: src, to: dst });
    moved.push(dst);
    return;
  }
  if (isDir(src) && isDir(dst)) {
    for (const name of fs.readdirSync(src)) mergeInto(path.join(src, name), path.join(dst, name), tag, steps, moved);
    // What is left of it is empty (everything went across): removed so no stray folder stays behind. Never recursive.
    try {
      fs.rmdirSync(src);
    } catch {
      /* not empty or in use: leave it */
    }
    return;
  }
  // The same name, and not two folders: keep both. The newer write holds the name (the conversation as it stands);
  // the other is kept beside it with a suffix naming where it came from.
  if (mtime(dst) >= mtime(src)) {
    const kept = suffixed(dst, tag);
    moveEntry(src, kept);
    steps.push({ from: src, to: kept });
    moved.push(kept);
  } else {
    const older = suffixed(dst, `${tag}-older`);
    moveEntry(dst, older);
    steps.push({ from: dst, to: older });
    moveEntry(src, dst);
    steps.push({ from: src, to: dst });
    moved.push(dst);
  }
}

/** Put the steps back, newest first; what could not be undone is returned. */
function undo(steps: Step[]): { restored: string[]; stuck: string[] } {
  const restored: string[] = [];
  const stuck: string[] = [];
  for (const s of [...steps].reverse()) {
    try {
      moveEntry(s.to, s.from);
      restored.push(s.from);
    } catch {
      stuck.push(s.to);
    }
  }
  return { restored, stuck };
}

/**
 * The newest conversation of a projects folder — the `<id>.jsonl` `--continue` resumes — and its `<id>/` folder
 * (subagents, tool results) when there is one: what is this session's in a folder other conversations share.
 */
function latestConversation(dir: string): string[] {
  let best: { name: string; at: number } | null = null;
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith('.jsonl')) continue;
    const at = mtime(path.join(dir, name));
    if (!best || at > best.at) best = { name, at };
  }
  if (!best) return [];
  const id = best.name.slice(0, -'.jsonl'.length);
  return [best.name, ...(isDir(path.join(dir, id)) ? [id] : [])];
}

/**
 * Move a session's conversations from the account folder `fromDir` to `toDir` (each an account's `CLAUDE_CONFIG_DIR`, or
 * `~/.claude`). `tag` names the account they came from, for the suffix of a file kept beside one of the same name.
 * `onlyLatest`: a folder others share (a repo's own checkout, where every Claude run there keeps its conversations and
 * memory): only this session's conversation goes — the newest transcript and its folder per folder —, never the rest.
 * Throws an AccountMoveError after putting back what was moved.
 */
export function moveConversations(
  session: Pick<WorktreeSession, 'paths' | 'isGroup'>,
  fromDir: string,
  toDir: string,
  tag = 'old',
  opts: { onlyLatest?: boolean } = {},
): MoveResult {
  const steps: Step[] = [];
  const moved: string[] = [];
  if (path.resolve(fromDir) === path.resolve(toDir)) return { moved };
  const emptied: string[] = [];
  let at = '';
  try {
    for (const cwd of sessionRunFolders(session, false)) {
      const name = encodeProjectDir(cwd);
      const src = path.join(projectsRootOf(fromDir), name);
      if (!isDir(src)) continue;
      at = src;
      const dst = path.join(projectsRootOf(toDir), name);
      if (opts.onlyLatest) {
        // Not the folder: its own conversation alone, into the target's folder of that name (made when missing).
        for (const entry of latestConversation(src)) {
          at = path.join(src, entry);
          mergeInto(path.join(src, entry), path.join(dst, entry), tag, steps, moved);
        }
        continue;
      }
      mergeInto(src, dst, tag, steps, moved);
      emptied.push(src);
    }
  } catch (err) {
    const { restored, stuck } = undo(steps);
    const why = err instanceof Error ? err.message : String(err);
    throw new AccountMoveError(
      `couldn't move its conversations (${at}): ${why}. ` +
        (stuck.length
          ? `${restored.length} put back, ${stuck.length} could not be: ${stuck.join(', ')}`
          : steps.length
            ? 'what was moved is back where it was'
            : 'nothing was moved'),
      at,
      restored,
      stuck,
    );
  }
  // A folder whose entries all went across: gone (never recursive: a leftover keeps it).
  for (const src of emptied) {
    try {
      fs.rmdirSync(src);
    } catch {
      /* something is left in it, or it is already gone */
    }
  }
  return { moved };
}

/** Claude's account part of the adapter (types.ts): which accounts there are, and a switch's file move. */
export const claudeAccountSwitch: AgentAccounts = {
  list(): AccountInfo[] {
    return claudeAccounts().map((a) => ({ name: a.name, dir: a.dir, isDefault: a.isDefault, loggedIn: isLoggedIn(a.dir) }));
  },
  defaultName: () => defaultAccountName(),
  has: (name) => accountDir(name) !== null,
  current: (session) => sessionAccount(session),
  async switchFiles(session, to) {
    const from = sessionAccount(session);
    const fromDir = accountDir(from);
    const toDir = accountDir(to);
    if (!fromDir) throw new Error(`its account “${from}” is not in your config any more`);
    if (!toDir) throw new Error(`no account “${to}”`);
    // A repo's own checkout is everyone's folder (other sessions, your own Claude there): only this session's conversation.
    const onlyLatest = isOwnCheckout(session, loadConfig()?.repos ?? {});
    return moveConversations(session, fromDir, toDir, from, { onlyLatest });
  },
  folders: (session) => sessionRunFolders(session, false),
  admin: claudeAccountAdmin,
};
