import path from 'node:path';
import type { Hono } from 'hono';
import { findSession } from './web-state.js';
import { shownState } from './turn-activity.js';
import { updateFromMain, type UpdateResult } from './behind-main.js';
import { loadConfig } from './config.js';
import { loadHistory, setSessionBase } from './history.js';
import { sessionStacks } from './stack-sessions.js';
import { parentTipFor, retargetOntoMain } from './stack-retarget.js';
import type { CommandRunner } from './ship.js';
import type { UpdateFromMainWire } from './api-types.js';

/**
 * POST /api/sessions/:id/update-from-main — bring the session's branch(es) up
 * to date with origin/<main> (behind-main.ts) — or, when it is stacked on
 * another session (stack.ts), with that session's branch. Not while its
 * Claude is working or waiting on you: the files would move under it.
 */
export function mountUpdateRoutes(
  app: Hono,
  opts: { broadcast: (event: string, data: unknown) => void; changed?: (id: string) => void; run?: CommandRunner },
): void {
  app.post('/api/sessions/:id/update-from-main', async (c) => {
    const id = c.req.param('id');
    const s = findSession(id);
    if (!s) return c.json({ error: 'unknown session' }, 404);
    if (s.archivedAt) return c.json({ error: 'it is archived: restore it first' }, 409);
    const state = shownState(s);
    if (state === 'working' || state === 'needs_input') {
      return c.json({ error: `Not now: its Claude is ${state === 'working' ? 'working' : 'waiting for your answer'} (the files would change under it).` }, 409);
    }
    const results: UpdateResult[] = [];
    const parent = sessionStacks(loadHistory(), loadConfig()).parentOf.get(id)?.branch;
    for (const p of s.paths) {
      // Asked again right before each repo is changed: a turn may have started while git fetched.
      const st = shownState(s);
      if (st === 'working' || st === 'needs_input') {
        results.push({ ok: false, repo: path.basename(p), reason: `its Claude started ${st === 'working' ? 'working' : 'waiting for your answer'}: stopped here` });
        break;
      }
      results.push(await updateFromMain(p, opts.run, parent));
    }
    opts.changed?.(id);
    opts.broadcast('sessions-changed', { ts: Date.now() });
    return c.json({ results } satisfies UpdateFromMainWire);
  });

  // A stacked session whose parent merged (its session archived): onto main (stack-retarget.ts).
  app.post('/api/sessions/:id/retarget', async (c) => {
    const id = c.req.param('id');
    const s = findSession(id);
    if (!s) return c.json({ error: 'unknown session' }, 404);
    if (s.archivedAt) return c.json({ error: 'it is archived: restore it first' }, 409);
    const state = shownState(s);
    if (state === 'working' || state === 'needs_input') {
      return c.json({ error: `Not now: its Claude is ${state === 'working' ? 'working' : 'waiting for your answer'} (the files would change under it).` }, 409);
    }
    const config = loadConfig();
    const parent = sessionStacks(loadHistory(), config).mergedParentOf.get(id);
    if (!parent) return c.json({ error: 'it is not stacked on a merged session' }, 409);
    const r = await retargetOntoMain(
      s,
      async (repo) => ({ branch: parent.branch, tip: await parentTipFor(repo, parent, config, opts.run) }),
      opts.run,
      // Asked again right before each repo is changed: a turn may have started while git fetched.
      () => {
        const st = shownState(s);
        return st === 'working' || st === 'needs_input' ? `its Claude started ${st === 'working' ? 'working' : 'waiting for your answer'}: stopped` : null;
      },
    );
    // On main now: no longer stacked on anything.
    if (r.ok && r.bases) await setSessionBase(s.target, s.branch, r.bases);
    opts.changed?.(id);
    opts.broadcast('sessions-changed', { ts: Date.now() });
    return c.json({ results: r.results } satisfies UpdateFromMainWire);
  });
}
