import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { getConfigDir, getConfigPath, loadConfig } from '../../../src/core/platform/config.js';
import { setReviewMode } from '../../../src/core/worktree/repo-admin.js';
import { realFixIo, realReviewRouteIo, reviewSettings } from '../../../src/core/review/review-deps.js';
import { sessionIdFor } from '../../../src/core/sessions/session-id.js';
import { upsertSession } from '../../../src/core/sessions/history.js';
import { writeReview } from '../../../src/core/review/review-store.js';
import { demoReview } from '../../../src/server/demo/demo-reviews.js';

// Each test file has its own HOME (tests/setup): this config.json and state.db are throwaways.

function seed(config: Record<string, unknown>) {
  fs.mkdirSync(getConfigDir(), { recursive: true });
  fs.writeFileSync(getConfigPath(), JSON.stringify({ worktreesRoot: '/wt', repos: { api: '/r/api', web: '/r/web' }, ...config }));
}
const raw = () => JSON.parse(fs.readFileSync(getConfigPath(), 'utf-8')) as Record<string, unknown>;

describe("config's reviews block, read", () => {
  it('keeps the valid modes and limits; anything malformed is left out, not trusted', () => {
    seed({
      groups: { shop: ['api', 'web'] },
      reviews: { projects: { api: 'asked', web: 'sometimes', shop: 'off' }, maxPerDay: -1, maxLines: 0, rules: 'nope' },
    });
    expect(loadConfig()!.reviews).toEqual({ projects: { api: 'asked', shop: 'off' } });
    seed({ reviews: { projects: ['all'], maxPerDay: 3, maxLines: 500, rules: [] } });
    expect(loadConfig()!.reviews).toEqual({ maxPerDay: 3, maxLines: 500, rules: [] });
    seed({ reviews: ['all'] });
    expect(loadConfig()!.reviews).toBeUndefined();
  });
});

describe('setting a project’s mode, and the settings the Reviews tab shows', () => {
  it('a repo or a group gets its mode in config.json (the rest of the file kept); anything else is refused', async () => {
    seed({ groups: { shop: ['api', 'web'] }, someFutureSetting: { keep: true } });
    await setReviewMode('shop', 'asked');
    await setReviewMode('api', 'off');
    expect(raw().reviews).toEqual({ projects: { shop: 'asked', api: 'off' } });
    expect(raw().someFutureSetting).toEqual({ keep: true });
    await expect(setReviewMode('nope', 'all')).rejects.toThrow("nope isn't one of your repos or groups");
    expect(reviewSettings()).toEqual({
      projects: [
        { name: 'api', kind: 'repo', mode: 'off', from: 'repo' },
        { name: 'web', kind: 'repo', mode: 'asked', from: 'group', group: 'shop' },
        { name: 'shop', kind: 'group', mode: 'asked', from: 'repo' },
      ],
      maxPerDay: null,
      maxLines: 3000,
    });
  });

  it("the routes' I/O: today's count is the reviews prepared on this local day; a repo's folder by its alias", () => {
    seed({});
    const now = new Date();
    writeReview({ ...demoReview(now), number: 1, preparedAt: now.toISOString() });
    writeReview({ ...demoReview(now), number: 2, preparedAt: new Date(now.getTime() - 3 * 86_400_000).toISOString() });
    const io = realReviewRouteIo();
    expect(io.today()).toBe(1);
    expect(io.repoPath('api')).toBe('/r/api');
    expect(io.repoPath('nope')).toBeNull();
  });
});

describe("Fix it myself's real session side", () => {
  it('makes the session as New worktree does (the repo, the PR’s branch, a name) and names it by its id; finds a live one from the history', async () => {
    seed({});
    const asked: unknown[] = [];
    const io = realFixIo({
      create: async (req) => {
        asked.push(req);
        return { ok: true, branch: req.branch!, launchDir: '/wt/x', paths: ['/wt/x'], warnings: ['w'] };
      },
      note: async () => undefined,
    });
    expect(await io.create('api', 'feat/refunds', 'Fix my review of #231')).toEqual({
      ok: true,
      sessionId: sessionIdFor({ target: 'api', branch: 'feat/refunds' }),
      label: 'api · feat/refunds',
      warnings: ['w'],
    });
    expect(asked).toEqual([{ target: 'api', branch: 'feat/refunds', name: 'Fix my review of #231' }]);
    // A live session whose folder is there (this HOME's, standing in for its worktree) and on the branch.
    const dir = getConfigDir();
    await upsertSession('api', false, 'feat/refunds', [dir], undefined, undefined, undefined, ['api']);
    expect(io.liveSessionOn('api', 'feat/refunds')).toEqual({
      id: sessionIdFor({ target: 'api', branch: 'feat/refunds' }),
      label: 'api · feat/refunds',
    });
    expect(io.liveSessionOn('api', 'other')).toBeNull();
  });
});
