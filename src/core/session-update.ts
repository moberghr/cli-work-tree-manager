import path from 'node:path';
import { updateFromMain, type UpdateResult } from './behind-main.js';
import { loadConfig } from './config.js';
import { loadHistory, setSessionBase } from './history.js';
import { sessionIdFor } from './session-id.js';
import type { WorktreeSession } from './session-types.js';
import { sessionStacks } from './stack-sessions.js';
import { parentTipFor, retargetOntoMain } from './stack-retarget.js';
import type { CommandRunner } from './ship.js';
import { shownState } from './turn-activity.js';

/**
 * Bringing a session's branch up to date — the dashboard's Update from main /
 * Update from <parent> / Move onto main, and `work update` — one
 * implementation for both front-ends. Never while its Claude works or waits
 * on you (the files would move under it), asked again before each repo.
 */

export type SessionUpdate = { ok: true; results: UpdateResult[]; how: 'main' | 'parent' | 'onto-main'; base?: string } | { ok: false; status: 404 | 409; error: string };

function busy(s: WorktreeSession): string | null {
  const st = shownState(s);
  return st === 'working' || st === 'needs_input' ? (st === 'working' ? 'working' : 'waiting for your answer') : null;
}

function refuse(s: WorktreeSession): SessionUpdate | null {
  if (s.archivedAt) return { ok: false, status: 409, error: 'it is archived: restore it first' };
  const b = busy(s);
  return b ? { ok: false, status: 409, error: `Not now: its Claude is ${b} (the files would change under it).` } : null;
}

/** From origin/<main>, or — stacked on a live session — from that session's branch. */
export async function updateFromBase(s: WorktreeSession, run?: CommandRunner): Promise<SessionUpdate> {
  const no = refuse(s);
  if (no) return no;
  const parent = sessionStacks(loadHistory(), loadConfig()).parentOf.get(sessionIdFor(s))?.branch;
  const results: UpdateResult[] = [];
  for (const p of s.paths) {
    const b = busy(s);
    if (b) {
      results.push({ ok: false, repo: path.basename(p), reason: `its Claude started ${b}: stopped here` });
      break;
    }
    results.push(await updateFromMain(p, run, parent));
  }
  return { ok: true, results, how: parent ? 'parent' : 'main', ...(parent ? { base: parent } : {}) };
}

/** Stacked on a session that merged (archived): onto main, only its own commits (stack-retarget.ts). */
export async function moveOntoMain(s: WorktreeSession, run?: CommandRunner): Promise<SessionUpdate> {
  const no = refuse(s);
  if (no) return no;
  const config = loadConfig();
  const parent = sessionStacks(loadHistory(), config).mergedParentOf.get(sessionIdFor(s));
  if (!parent) return { ok: false, status: 409, error: 'it is not stacked on a merged session' };
  const r = await retargetOntoMain(
    s,
    async (repo) => ({ branch: parent.branch, tip: await parentTipFor(repo, parent, config, run) }),
    run,
    () => {
      const b = busy(s);
      return b ? `its Claude started ${b}: stopped` : null;
    },
  );
  // On main now: no longer stacked on anything.
  if (r.ok && r.bases) await setSessionBase(s.target, s.branch, r.bases);
  return { ok: true, results: r.results, how: 'onto-main', base: parent.branch };
}

/** Whichever it needs: onto main when its parent merged, else from its parent or main (`work update`). */
export async function updateSession(s: WorktreeSession, run?: CommandRunner): Promise<SessionUpdate> {
  const merged = sessionStacks(loadHistory(), loadConfig()).mergedParentOf.has(sessionIdFor(s));
  return merged ? moveOntoMain(s, run) : updateFromBase(s, run);
}
