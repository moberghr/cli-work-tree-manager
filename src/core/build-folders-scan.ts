import fs from 'node:fs';
import { buildFoldersOf, clearBuildFolders } from './build-folders.js';
import type { BuildFolder, BuildFolderCandidate, BuildFoldersApplyResult, BuildFoldersState } from './api-types.js';
import type { CommandRunner } from './ship.js';
import type { ActivityLog } from './activity.js';

/** Sessions idle at least this long are offered (a week). */
export const BUILD_FOLDERS_IDLE_MS = 7 * 24 * 60 * 60 * 1000;

export interface BuildFolderSession {
  id: string;
  target: string;
  branch: string;
  paths: string[];
  lastActiveMs: number;
  /** A Claude runs in it now: left alone (it may be building). */
  running: boolean;
  /** A repo's own checkout rather than a worktree. */
  baseCheckout?: boolean;
}


export interface BuildFoldersDeps {
  sessions: () => Promise<BuildFolderSession[]>;
  run?: CommandRunner;
  now?: () => number;
}

/** Idle long enough, and no Claude in it: the rule for offering AND for clearing. */
const idleEnough = (s: BuildFolderSession, now: number) => !s.running && now - s.lastActiveMs >= BUILD_FOLDERS_IDLE_MS;

/** The worktrees idle a week or more, and the build folders they hold, biggest first. */
export async function scanBuildFolders(deps: BuildFoldersDeps, onProgress?: (checked: number, total: number) => void): Promise<BuildFolderCandidate[]> {
  const now = (deps.now ?? Date.now)();
  const eligible = (await deps.sessions()).filter((s) => idleEnough(s, now) && s.paths.some((p) => fs.existsSync(p)));
  const out: BuildFolderCandidate[] = [];
  let checked = 0;
  for (const s of eligible) {
    const folders: BuildFolder[] = [];
    for (const p of s.paths) if (fs.existsSync(p)) folders.push(...(await buildFoldersOf(p, deps.run)));
    const bytes = folders.reduce((n, f) => n + f.bytes, 0);
    if (bytes > 0) out.push({ sessionId: s.id, target: s.target, branch: s.branch, ...(s.baseCheckout ? { baseCheckout: true } : {}), lastActive: new Date(s.lastActiveMs).toISOString(), folders, bytes });
    onProgress?.(++checked, eligible.length);
  }
  return out.sort((a, b) => b.bytes - a.bytes);
}

/** One scan at a time; its latest result kept for the view. */
export function createBuildFoldersJob(deps: BuildFoldersDeps, activity?: ActivityLog) {
  let state: BuildFoldersState = { scanning: false, checked: 0, total: 0, scannedAt: null, candidates: [] };
  return {
    state: () => state,
    scan: () => {
      if (state.scanning) return;
      state = { ...state, scanning: true, checked: 0, total: 0 };
      const run = activity?.start('build-folders', 'Measuring build folders in idle worktrees');
      void scanBuildFolders(deps, (checked, total) => {
        state = { ...state, checked, total };
        run?.progress(checked, total);
      })
        .then((candidates) => {
          state = { ...state, scanning: false, candidates, scannedAt: new Date().toISOString() };
          const gb = candidates.reduce((n, c) => n + c.bytes, 0) / 1e9;
          run?.done(`${candidates.length} idle worktree${candidates.length === 1 ? '' : 's'} with build output · ${gb.toFixed(1)} GB`);
        })
        .catch((err: Error) => {
          state = { ...state, scanning: false };
          run?.fail(err.message);
        });
    },
    /** Clear the build folders of these sessions (each checked again as it goes). */
    apply: async (ids: string[]) => {
      const sessions = new Map((await deps.sessions()).map((s) => [s.id, s]));
      const results: BuildFoldersApplyResult[] = [];
      for (const id of ids) {
        const s = sessions.get(id);
        if (!s) {
          results.push({ sessionId: id, ok: false, removed: 0, message: 'Unknown session.' });
          continue;
        }
        if (s.running) {
          results.push({ sessionId: id, ok: false, removed: 0, message: 'Its Claude is running now: left alone.' });
          continue;
        }
        // Checked again, not trusted from the scan (or the caller): used since → left alone.
        if (!idleEnough(s, (deps.now ?? Date.now)())) {
          results.push({ sessionId: id, ok: false, removed: 0, message: 'Used in the last week: left alone.' });
          continue;
        }
        let removed = 0;
        const failed: string[] = [];
        for (const p of s.paths) {
          if (!fs.existsSync(p)) continue;
          const r = await clearBuildFolders(p, deps.run);
          removed += r.removed.length;
          failed.push(...r.failed.map((f) => f.path));
        }
        results.push({ sessionId: id, ok: failed.length === 0, removed, message: failed.length ? `Could not remove: ${failed.join(', ')}` : `Removed ${removed} folder(s)` });
      }
      const done = new Set(results.filter((r) => r.ok).map((r) => r.sessionId));
      state = { ...state, candidates: state.candidates.filter((c) => !done.has(c.sessionId)) };
      return results;
    },
  };
}
