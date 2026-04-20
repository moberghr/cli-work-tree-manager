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
