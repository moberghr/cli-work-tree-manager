import type { Hono } from 'hono';
import { checkTools, saveFolders, setupState } from '../../core/setup/first-run.js';
import type { SetupWire, ToolCheck } from '../../core/api-types.js';

/** How long a tool check holds: `claude --version` and friends start processes. */
const TOOLS_TTL_MS = 10 * 60_000;

/**
 * The Welcome page (first-run.ts): where setup stands, and setting the
 * folders. GET only reads (the tool checks run commands that change
 * nothing, cached for ten minutes; `?fresh=1` asks again).
 */
export function mountSetupRoutes(
  app: Hono,
  opts: { broadcast: (event: string, data: unknown) => void; tools?: () => Promise<ToolCheck[]> },
): void {
  let cached: { at: number; tools: Promise<ToolCheck[]> } | null = null;
  const tools = (fresh: boolean) => {
    if (fresh || !cached || Date.now() - cached.at > TOOLS_TTL_MS) cached = { at: Date.now(), tools: (opts.tools ?? checkTools)() };
    return cached.tools;
  };
  app.get('/api/setup', async (c) => c.json((await setupState(() => tools(c.req.query('fresh') === '1'))) satisfies SetupWire));
  app.post('/api/setup', async (c) => {
    const b = (await c.req.json().catch(() => null)) as { worktreesRoot?: unknown; reposFolder?: unknown } | null;
    if (typeof b?.worktreesRoot !== 'string' || typeof b.reposFolder !== 'string')
      return c.json({ error: 'expected {worktreesRoot, reposFolder}' }, 400);
    try {
      await saveFolders({ worktreesRoot: b.worktreesRoot, reposFolder: b.reposFolder });
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400);
    }
    opts.broadcast('repos-changed', { ts: Date.now() });
    return c.json({ ok: true });
  });
}
