import { afterEach, describe, expect, it, vi } from 'vitest';
import yargs from 'yargs';

const session = { target: 'api', branch: 'feat/x', isGroup: false, paths: ['/wt/api'], createdAt: 'x', lastAccessedAt: 'x' };
const draft = { threadId: 'PRRT_kwDOabc123', status: 'draft', draft: 'Fixed in abc1234', reviewer: 'copilot', prNumber: 7 };
const h = vi.hoisted(() => ({ postDrafts: vi.fn() }));

vi.mock('../../src/core/comments/pending-delivery.js', () => ({ findSessionForCwd: () => session }));
vi.mock('../../src/core/platform/web-discovery.js', () => ({ readWebUrl: () => null }));
vi.mock('../../src/core/pr/pr-replies.js', () => ({
  listReplies: () => [draft],
  saveDraft: vi.fn(),
  postDrafts: h.postDrafts,
}));

const { prCommand } = await import('../../src/commands/pr.js');

afterEach(() => {
  h.postDrafts.mockReset();
  vi.restoreAllMocks();
});

async function post(...args: string[]) {
  h.postDrafts.mockResolvedValue({ posted: [{ ...draft, url: 'u', resolved: true }], failed: [] });
  vi.spyOn(console, 'log').mockImplementation(() => {});
  await yargs()
    .command(prCommand)
    .parseAsync(['pr', 'post', draft.threadId, ...args]);
  return h.postDrafts.mock.calls[0];
}

describe('work pr post', () => {
  it('resolves each thread it answers by default (a reply that leaves it open kept the session "waiting on you")', async () => {
    expect((await post())[2]).toBe(true);
  });

  it('--no-resolve leaves the thread open, for a question a person should answer; --resolve still works', async () => {
    expect((await post('--no-resolve'))[2]).toBe(false);
    h.postDrafts.mockReset();
    expect((await post('--resolve'))[2]).toBe(true);
  });
});
