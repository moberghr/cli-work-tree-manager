import fs from 'node:fs';
import path from 'node:path';
import lockfile from 'proper-lockfile';

/**
 * Resolve a path through any symlinks so a tmp-file + rename write replaces
 * the LINK TARGET, not the link. Users routinely symlink config into a
 * dotfiles repo (`~/.claude/settings.json` -> `~/.dotfiles/.../settings.json`);
 * renaming over the link silently detaches it, so our edit lands in a new
 * regular file and the dotfiles copy stops being the live one.
 *
 * Walks links by hand instead of `fs.realpathSync` so a dangling link (target
 * not created yet) still resolves to where it points. Falls back to the path
 * as given when there's nothing there or the links form a cycle. Resolving
 * also keeps the tmp file on the target's filesystem, so the rename can't
 * fail with EXDEV when the link crosses a mount.
 */
export function resolveLinkTarget(filePath: string): string {
  let current = filePath;
  const seen = new Set<string>([current]);
  for (let i = 0; i < 32; i++) {
    let stat;
    try {
      stat = fs.lstatSync(current);
    } catch {
      return current; // nothing there — write where we were told
    }
    if (!stat.isSymbolicLink()) return current;
    const next = path.resolve(path.dirname(current), fs.readlinkSync(current));
    if (seen.has(next)) return filePath; // link cycle — don't touch it
    seen.add(next);
    current = next;
  }
  return filePath;
}

/**
 * Write a file atomically. Writes to a sibling tmp file and renames
 * over the target, so a crash mid-write can't leave a truncated file.
 * Symlinks are followed first (see {@link resolveLinkTarget}) and the
 * existing file's mode is preserved across the replace.
 */
export function atomicWriteFile(filePath: string, content: string): void {
  const target = resolveLinkTarget(filePath);
  const tmpPath = `${target}.tmp-${process.pid}`;
  fs.writeFileSync(tmpPath, content, 'utf-8');
  try {
    fs.chmodSync(tmpPath, fs.statSync(target).mode & 0o777);
  } catch { /* target is new — default umask is right */ }
  fs.renameSync(tmpPath, target);
}

/**
 * Ensure a file exists (creating with the given initial content if missing).
 * Required before `withFileLock` can acquire a lock on it — proper-lockfile
 * resolves the target file's realpath before creating the sibling .lock dir.
 */
export function ensureFile(filePath: string, initialContent: string): void {
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, initialContent, 'utf-8');
  }
}

/**
 * Serialize a read-modify-write sequence across processes using the same
 * advisory-lock mechanism as npm/yarn/pnpm. Caller is responsible for
 * ensuring the target file exists first (see `ensureFile`).
 */
export async function withFileLock<T>(
  filePath: string,
  fn: () => T | Promise<T>,
): Promise<T> {
  const release = await lockfile.lock(filePath, {
    retries: { retries: 20, minTimeout: 25, maxTimeout: 500, factor: 2 },
    stale: 10_000,
  });
  try {
    return await fn();
  } finally {
    await release();
  }
}

/**
 * Synchronous sibling of {@link withFileLock}. Serializes a read-modify-write
 * across processes using the same advisory-lock mechanism, but without an
 * `await` so it can be called from synchronous code paths (e.g. the
 * file-backed comment store, whose API is sync and consumed by sync Hono
 * route handlers). Caller is responsible for ensuring the target file exists
 * first (see `ensureFile`).
 */
export function withFileLockSync<T>(filePath: string, fn: () => T): T {
  // proper-lockfile's sync API forbids its own retry config (it requires an
  // async flow), so we hand-roll a bounded retry: try to acquire, and on a
  // contended lock (ELOCKED) sleep synchronously and try again.
  const maxAttempts = 30;
  let release: (() => void) | undefined;
  for (let attempt = 0; ; attempt++) {
    try {
      release = lockfile.lockSync(filePath, { stale: 10_000 });
      break;
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code !== 'ELOCKED' || attempt >= maxAttempts) throw err;
      sleepSync(Math.min(25 * 2 ** Math.min(attempt, 4), 500));
    }
  }
  try {
    return fn();
  } finally {
    release();
  }
}

/** Block the current thread for `ms` milliseconds without spinning the CPU.
 *  Used only by `withFileLockSync`'s contention backoff. */
function sleepSync(ms: number): void {
  const shared = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(shared, 0, 0, ms);
}
