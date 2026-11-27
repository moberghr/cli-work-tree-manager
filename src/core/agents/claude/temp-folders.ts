import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { encodeProjectDir, sessionRunFolders } from './activity.js';
import type { WorktreeSession } from '../../sessions/session-types.js';

/**
 * Where Claude Code keeps a session's scratch files — an artifact's HTML before it is published, a mockup, a report —
 * so the pane beside the terminal can show them (`work show`, a click on the path): `/tmp/claude-<uid>` on macOS and
 * Linux (that folder, not `$TMPDIR`: measured, macOS's `$TMPDIR` is under /var/folders and Claude doesn't use it), and
 * `%TEMP%\claude` on Windows; then one folder per folder it runs in, named as its projects folders are. Pure.
 */
export function claudeTempRoot(
  platform: NodeJS.Platform = process.platform,
  uid: number = typeof process.getuid === 'function' ? process.getuid() : -1,
  tmpdir: string = os.tmpdir(),
): string {
  return platform === 'win32' ? path.win32.join(tmpdir, 'claude') : `/tmp/claude-${uid}`;
}

/** This session's own, by name: one per folder its Claude runs in (its root and each repo). Pure. */
export function claudeTempFolders(session: Pick<WorktreeSession, 'paths' | 'isGroup'>, root: string = claudeTempRoot()): string[] {
  const join = root.includes('\\') ? path.win32.join : path.posix.join;
  return sessionRunFolders(session, false).map((folder) => join(root, encodeProjectDir(folder)));
}

export interface TempFolderIo {
  realpath(p: string): string;
  lstat(p: string): { isDirectory(): boolean; isSymbolicLink(): boolean; uid: number; mode: number };
}
// The OS's own realpath, as the file's is resolved (findTempFile): on Windows it also turns a short 8.3 name
// (`C:\Users\RUNNER~1\…`, often %TEMP%'s) into the long one, so the folder and the file are named alike.
const realIo: TempFolderIo = { realpath: (p) => fs.realpathSync.native(p), lstat: (p) => fs.lstatSync(p) };

/**
 * The scratch root as it really is, or null when it can't be trusted. `/tmp` is shared by every user, so anyone could
 * make `/tmp/claude-<uid>` first, or a link there pointing at a folder of yours: only its parent's links are followed
 * (macOS's /tmp is /private/tmp), and the root itself must be a real folder — on macOS and Linux one owned by us that
 * nobody else may write to or read (Claude makes it 0700).
 */
export function trustedTempRoot(
  root: string = claudeTempRoot(),
  platform: NodeJS.Platform = process.platform,
  uid: number = typeof process.getuid === 'function' ? process.getuid() : -1,
  io: TempFolderIo = realIo,
): string | null {
  const p = platform === 'win32' ? path.win32 : path.posix;
  try {
    const real = p.join(io.realpath(p.dirname(root)), p.basename(root));
    const st = io.lstat(real);
    if (!st.isDirectory() || st.isSymbolicLink()) return null;
    if (platform !== 'win32' && (st.uid !== uid || (st.mode & 0o077) !== 0)) return null;
    return real;
  } catch {
    return null;
  }
}

/**
 * The scratch folders a session's files may be shown from: its own (`claudeTempFolders`) under a trusted root, each a
 * real folder (a link is never followed, so what is shown is always under the root it names). Missing ones are left out.
 */
export function sessionTempFolders(
  session: Pick<WorktreeSession, 'paths' | 'isGroup'>,
  root: string = claudeTempRoot(),
  platform: NodeJS.Platform = process.platform,
  uid: number = typeof process.getuid === 'function' ? process.getuid() : -1,
  io: TempFolderIo = realIo,
): string[] {
  const real = trustedTempRoot(root, platform, uid, io);
  if (!real) return [];
  return claudeTempFolders(session, real).filter((f) => {
    try {
      const st = io.lstat(f);
      return st.isDirectory() && !st.isSymbolicLink();
    } catch {
      return false;
    }
  });
}
