import fs from 'node:fs';
import path from 'node:path';
import { getConfigDir } from '../platform/config.js';
import { json, withDb } from '../platform/db.js';
import { atomicWriteFile } from '../platform/fs-safe.js';
import { packageRoot } from '../platform/package-root.js';
import { isPidAlive } from '../platform/process.js';
import { loadHistory } from '../sessions/history.js';
import { defaultRunner, type CommandRunner } from '../pr/ship.js';
import { VERSION } from '../../version.js';
import type { UpdateWire } from '../api-types.js';
import {
  availableUpdate,
  installKindOf,
  parseDesktopUpdate,
  parseReleases,
  whatsNewFor,
  type DesktopUpdate,
  type InstallKind,
  type ReleaseNote,
} from './updates.js';

/**
 * Updates and release notes, the I/O (the rules are updates.ts): the
 * release list from GitHub (one request, anonymous; `gh api` when that
 * fails — a private repo, GitHub's limit for this address), the desktop
 * app's updater through its two files in ~/.work, and the version whose
 * notes you last saw (state.db `meta`).
 */

export const RELEASES_REPO = 'moberghr/cli-work-tree-manager';
const RELEASES_URL = `https://api.github.com/repos/${RELEASES_REPO}/releases?per_page=30`;
const SEEN_KEY = 'ui:seen-version';

export const desktopUpdatePath = () => path.join(getConfigDir(), 'desktop-update.json');
export const desktopRequestPath = () => path.join(getConfigDir(), 'desktop-request.json');

/** The published releases, newest first. Throws with the reason when neither GitHub nor gh answers. */
export async function fetchReleases(
  get: (url: string) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }> = (url) =>
    fetch(url, { headers: { 'User-Agent': 'work', Accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(15_000) }),
  run: CommandRunner = defaultRunner,
): Promise<ReleaseNote[]> {
  const why = await get(RELEASES_URL).then(
    async (res) =>
      res.ok
        ? parseReleases(await res.json())
        : res.status === 403
          ? "GitHub's limit for this address is spent"
          : `GitHub answered ${res.status}`,
    (err: Error) => err.message,
  );
  if (typeof why !== 'string') return why;
  const r = await run('gh', ['api', `repos/${RELEASES_REPO}/releases?per_page=30`], process.cwd());
  if (r.code === 0) {
    try {
      return parseReleases(JSON.parse(r.stdout));
    } catch {
      /* not JSON */
    }
  }
  throw new Error(`couldn't read the releases (${why}${r.code === 127 ? '; no gh to ask instead' : ''})`);
}

/** The desktop app's updater, when the app that wrote it still runs. */
export function readDesktopUpdate(file = desktopUpdatePath()): (DesktopUpdate & { pid?: number }) | null {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf-8');
  } catch {
    return null;
  }
  const d = parseDesktopUpdate(text);
  const pid = (json.parse(text) as { pid?: unknown } | null)?.pid;
  if (!d) return null;
  // A file left by an app that quit says nothing now (and can't take a Restart).
  if (typeof pid === 'number' && !isPidAlive(pid)) return null;
  return d;
}

/** Ask the desktop app to check now, or to restart into the update it downloaded (it reads the file within two seconds). */
export function requestDesktop(action: 'check' | 'restart', file = desktopRequestPath()): void {
  atomicWriteFile(file, JSON.stringify({ action, at: new Date().toISOString() }));
}

export function seenVersion(): string | null {
  const row = withDb((d) => d.prepare('SELECT value FROM meta WHERE key = ?').get(SEEN_KEY) as { value: string } | undefined);
  return row?.value ?? null;
}

export function markSeenVersion(version: string): void {
  withDb((d) => d.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(SEEN_KEY, version));
}

export function installKind(): InstallKind {
  const root = packageRoot();
  return installKindOf(root, getConfigDir(), !!root && fs.existsSync(path.join(root, '.git')));
}

export interface UpdatesDeps {
  fetchReleases: () => Promise<ReleaseNote[]>;
  running: string;
  install: () => InstallKind;
  desktop: () => DesktopUpdate | null;
  seen: () => string | null;
  usedBefore: () => boolean;
  now: () => number;
}

const defaultDeps = (): UpdatesDeps => ({
  fetchReleases: () => fetchReleases(),
  running: VERSION,
  install: installKind,
  desktop: () => readDesktopUpdate(),
  seen: seenVersion,
  usedBefore: () => loadHistory().length > 0,
  now: Date.now,
});

/**
 * One per work web: the release list (asked at most every few hours, or
 * when you ask), and the dashboard's view of updates from it, the desktop
 * app and what you've seen.
 */
export function createUpdates(deps: UpdatesDeps = defaultDeps()) {
  let notes: ReleaseNote[] = [];
  let checkedAt: number | null = null;
  let error: string | null = null;
  let inFlight: Promise<void> | null = null;

  const refresh = (): Promise<void> =>
    (inFlight ??= deps
      .fetchReleases()
      .then(
        (n) => {
          notes = n;
          error = null;
        },
        (err: Error) => {
          error = err.message;
        },
      )
      .finally(() => {
        checkedAt = deps.now();
        inFlight = null;
      }));

  const wire = (): UpdateWire => {
    const install = deps.install();
    const desktop = deps.desktop();
    const latest = notes[0]?.version ?? null;
    return {
      running: deps.running,
      install,
      latest,
      checkedAt: checkedAt ? new Date(checkedAt).toISOString() : null,
      checkError: error,
      desktop,
      available: availableUpdate({ running: deps.running, install, latest, desktop }),
      whatsNew: whatsNewFor({ running: deps.running, seen: deps.seen(), usedBefore: deps.usedBefore(), notes }),
    };
  };

  return {
    refresh,
    wire,
    notes: () => notes,
    /** When the list was last asked for (ms), or null. */
    checkedAt: () => checkedAt,
  };
}

/**
 * One look for a newer work (the sweep's, a little after start and every
 * six hours): the release list again, noted in the Activity panel, and a
 * `changed()` when the newest release moved (the dashboard asks again).
 */
export async function lookForUpdates(
  updates: ReturnType<typeof createUpdates>,
  run: { done: (text: string) => void; fail: (text: string) => void },
  changed: () => void,
): Promise<void> {
  const before = updates.wire().latest;
  await updates.refresh();
  const w = updates.wire();
  if (w.checkError) run.fail(w.checkError);
  else run.done(w.available ? `work ${w.available.version} is out (this is ${w.running})` : `up to date (${w.running})`);
  if (w.latest !== before) changed();
}
