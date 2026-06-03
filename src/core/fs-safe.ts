import fs from 'node:fs';
import lockfile from 'proper-lockfile';

/**
 * Write a file atomically. Writes to a sibling tmp file and renames
 * over the target, so a crash mid-write can't leave a truncated file.
 */
export function atomicWriteFile(filePath: string, content: string): void {
  const tmpPath = `${filePath}.tmp-${process.pid}`;
  fs.writeFileSync(tmpPath, content, 'utf-8');
  fs.renameSync(tmpPath, filePath);
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
