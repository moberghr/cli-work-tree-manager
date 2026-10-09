import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const sessions = vi.hoisted(
  () =>
    ({
      s1: { target: 'repo', branch: 'feat/x', paths: ['/w/repo/feat-x'] },
      old: { target: 'repo', branch: 'feat/old', paths: ['/w/repo/feat-old'], archivedAt: '2026-10-01T00:00:00Z' },
    }) as Record<string, unknown>,
);
vi.mock('../../../src/core/sessions/web-state.js', () => ({ findSession: (id: string) => sessions[id] }));

const { mountDiffPageRoutes } = await import('../../../src/server/routes/diff-page-routes.js');
const { scopeHashForPaths } = await import('../../../src/core/diff/scope-manager.js');

const app = (ensureScope: (s: unknown) => unknown) => {
  const a = new Hono();
  mountDiffPageRoutes(a, { ensureScope });
  return a;
};
const post = (a: Hono, id: string) => a.request(`/api/sessions/${id}/diff-page`, { method: 'POST' });

describe('POST /api/sessions/:id/diff-page (the diff on a page of its own)', () => {
  it("sets the session's scope up (the page needs it, after a restart too) and says where the page is — wd's", async () => {
    const ensure = vi.fn(() => ({}));
    const res = await post(app(ensure), 's1');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ url: `/diff/${scopeHashForPaths(['/w/repo/feat-x'])}` });
    expect(ensure).toHaveBeenCalledWith(sessions.s1);
  });

  it("unknown, archived, or a scope that can't be set up: refused with why", async () => {
    expect(
      (
        await post(
          app(() => ({})),
          'nope',
        )
      ).status,
    ).toBe(404);
    const archived = await post(
      app(() => ({})),
      'old',
    );
    expect(archived.status).toBe(409);
    expect(await archived.json()).toEqual({ error: 'archived: restore it to see its diff' });
    expect(
      (
        await post(
          app(() => null),
          's1',
        )
      ).status,
    ).toBe(500);
  });

  it('a GET does nothing (a page on another site can make the browser open one, §1.5)', async () => {
    const ensure = vi.fn(() => ({}));
    expect((await app(ensure).request('/api/sessions/s1/diff-page')).status).toBe(404);
    expect(ensure).not.toHaveBeenCalled();
  });
});
