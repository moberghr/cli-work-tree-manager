import { afterEach, describe, expect, it, vi } from 'vitest';
import yargs from 'yargs';

const session = { target: 'api', branch: 'feat/x', isGroup: false, paths: ['/wt/api'], createdAt: 'x', lastAccessedAt: 'x' };
const draft = { threadId: 'PRRT_kwDOabc123', status: 'draft', draft: 'Fixed in abc1234', reviewer: 'copilot', prNumber: 7 };
const h = vi.hoisted(() => ({ postDrafts: vi.fn(), draftReply: vi.fn(), unsafe: false }));

vi.mock('../../src/core/comments/pending-delivery.js', () => ({ findSessionForCwd: () => session }));
vi.mock('../../src/core/platform/web-discovery.js', () => ({ readWebUrl: () => null }));
vi.mock('../../src/core/pr/pr-replies.js', () => ({
  listReplies: () => [draft],
  saveDraft: vi.fn(),
  draftReply: h.draftReply,
  sessionRepoRefs: () => [],
  postDrafts: h.postDrafts,
}));
// From before --unsafe was retired (legacy-unsafe.ts): the rule is tested on its own; here, that the command asks it.
vi.mock('../../src/core/sessions/legacy-unsafe-io.js', () => ({ runsUnsafeFromBefore: () => h.unsafe }));

const { prCommand } = await import('../../src/commands/pr.js');

afterEach(() => {
  h.postDrafts.mockReset();
  h.draftReply.mockReset();
  h.unsafe = false;
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

describe('an agent still running as started --unsafe before the retirement (remove next release)', () => {
  it('work pr reply and work pr post refuse in it, and nothing is drafted or posted', async () => {
    h.unsafe = true;
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const exit = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`exit ${code}`);
    }) as never);
    for (const args of [
      ['pr', 'reply', draft.threadId, 'Fixed'],
      ['pr', 'post', draft.threadId],
    ]) {
      await expect(yargs().command(prCommand).fail(false).parseAsync(args)).rejects.toThrow('exit 1');
    }
    expect(exit).toHaveBeenCalledTimes(2);
    expect(errors.mock.calls.map((c) => String(c[0]))).toEqual([
      expect.stringContaining('from before --unsafe was retired: restart it (work restart) first'),
      expect.stringContaining('from before --unsafe was retired: restart it (work restart) first'),
    ]);
    expect(h.draftReply).not.toHaveBeenCalled();
    expect(h.postDrafts).not.toHaveBeenCalled();
  });
});
