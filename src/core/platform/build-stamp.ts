import fs from 'node:fs';

/**
 * Which build this process is running. `work web` is a singleton that
 * outlives rebuilds and upgrades: a dashboard started at login in
 * September kept being reused by every later `work web`, though it read a
 * state layout that had since moved and lacked routes the SPA now calls
 * (the Today tab 404'd; no sessions showed). A newer build replaces an
 * older server the way the full server replaces a lean one.
 *
 * The stamp is the entry file's mtime: dist/bin.js is rewritten by every
 * build and every install. `WORK_BUILD_STAMP` overrides it, so a test can
 * start a server that claims to be another build.
 */
let cached: string | null = null;

export function buildStamp(): string {
  if (cached) return cached;
  const forced = process.env.WORK_BUILD_STAMP;
  if (forced) return (cached = forced);
  try {
    cached = String(Math.floor(fs.statSync(process.argv[1]).mtimeMs));
  } catch {
    cached = 'unknown';
  }
  return cached;
}
