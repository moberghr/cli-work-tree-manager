// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { OpenReviewThread, PrReply } from '../../src/core/api-types.js';

vi.mock('../../src/web/src/api/events.js', () => ({ useSse: () => {} }));
import { ReplyDrafts, type ReplyApi } from '../../src/web/src/components/Dashboard/ReplyDrafts.js';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});
const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });
const button = (label: string) => [...container.querySelectorAll('button')].find((b) => b.textContent === label) as HTMLButtonElement;

const reply = (threadId: string, over: Partial<PrReply> = {}): PrReply => ({
  threadId, repo: 'api', prNumber: 7, url: `https://gh/${threadId}`, where: 'src/a.ts:3', reviewer: 'dana', excerpt: 'Why not a const?',
  status: 'draft', draft: 'Fixed in abc1234: now a const.', sentAt: '2026-09-30T10:00:00Z', ...over,
});

function fakeApi(list: PrReply[], waiting: OpenReviewThread[] = []): ReplyApi & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    list: vi.fn(async () => ({ replies: list, waiting })),
    ask: vi.fn(async (_s, body) => void calls.push(`ask ${body}`)),
    edit: vi.fn(async (_s, t, b) => void calls.push(`edit ${t} ${b}`)),
    discard: vi.fn(async (_s, t) => void calls.push(`discard ${t}`)),
    post: vi.fn(async (_s, t, b, resolve) => {
      calls.push(`post ${t} ${b} resolve=${resolve}`);
      return { url: 'u', resolved: resolve };
    }),
  };
}

describe('ReplyDrafts', () => {
  it("shows the reviewer's comment and Claude's draft", async () => {
    act(() => root.render(createElement(ReplyDrafts, { sessionId: 's1', api: fakeApi([reply('PRRT_a'), reply('PRRT_b', { status: 'sent', draft: null })]) })));
    await flush();
    expect(container.querySelector('.wd-replies-title')!.textContent).toBe('✍ 1 reply to post');
    expect(container.querySelector('.wd-reply-quote')!.textContent).toBe('Why not a const?');
    expect(container.querySelector<HTMLTextAreaElement>('.wd-reply-text')!.value).toBe('Fixed in abc1234: now a const.');
  });

  it('Post & resolve saves your edit first, then posts it and resolves the thread', async () => {
    const api = fakeApi([reply('PRRT_a')]);
    act(() => root.render(createElement(ReplyDrafts, { sessionId: 's1', api })));
    await flush();
    const ta = container.querySelector<HTMLTextAreaElement>('.wd-reply-text')!;
    const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
    act(() => {
      setValue.call(ta, 'Fixed in abc1234, and added a test.');
      ta.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => button('Post & resolve').click());
    expect(api.calls).toEqual(['edit PRRT_a Fixed in abc1234, and added a test.', 'post PRRT_a Fixed in abc1234, and added a test. resolve=true']);
  });

  it('Post leaves the thread open; Discard posts nothing; nothing at all shows without threads', async () => {
    const api = fakeApi([reply('PRRT_a')]);
    act(() => root.render(createElement(ReplyDrafts, { sessionId: 's1', api })));
    await flush();
    await act(async () => button('Post').click());
    await act(async () => button('Discard').click());
    expect(api.calls).toEqual(['post PRRT_a Fixed in abc1234: now a const. resolve=false', 'discard PRRT_a']);
    act(() => root.render(createElement(ReplyDrafts, { sessionId: 's2', api: fakeApi([]) })));
    await flush();
    expect(container.querySelector('.wd-replies')).toBeNull();
  });
});

describe('ReplyDrafts with nothing to post', () => {
  it('nothing open and nothing drafted: nothing shows', async () => {
    act(() => root.render(createElement(ReplyDrafts, { sessionId: 's1', api: fakeApi([reply('PRRT_a', { status: 'sent', draft: null })]) })));
    await flush();
    expect(container.querySelector('.wd-replies')).toBeNull();
  });

  it('an open thread with no draft is listed — the comment, a link, Ask Claude to reply (reported: a count and nothing to see)', async () => {
    const open: OpenReviewThread = { threadId: 'PRRT_kwDOfront1', repo: 'straumur-frontend-ai', prNumber: 1927, url: 'https://gh/1927#r1', where: 'payfac-admin/src/pages/inventory/inventory.mutations.ts:53', reviewer: 'copilot-pull-request-reviewer', excerpt: 'This invalidates the queries only once…' };
    const api = fakeApi([reply('PRRT_kwDOfront1', { status: 'sent', draft: null })], [open]);
    act(() => root.render(createElement(ReplyDrafts, { sessionId: 's1', api })));
    await flush();
    expect(container.querySelector('.wd-replies-title')!.textContent).toBe('💬 1 unresolved review thread with no reply yet');
    expect(container.querySelector('.wd-reply-quote')!.textContent).toBe('This invalidates the queries only once…');
    expect(container.textContent).toContain('handed to Claude, no draft yet');
    expect(container.querySelector<HTMLAnchorElement>('.wd-reply-where')!.href).toBe('https://gh/1927#r1');
    await act(async () => button('Ask Claude to reply').click());
    expect(api.calls[0]).toContain('[thread PRRT_kwDOfront1]');
    expect(api.calls[0]).toContain('work pr reply PRRT_kwDOfront1');
    expect(api.calls[0]).toContain("Don't post it.");
    expect(button('Asked — the draft will show here').disabled).toBe(true);
  });
});
