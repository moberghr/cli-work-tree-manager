// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { RepliesWire, SessionCi } from '../../src/core/api-types.js';
import type { SessionSummary } from '../../src/web/src/api/client.js';
import type { PrInfo } from '../../src/web/src/api/panes.js';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const h = vi.hoisted(() => ({
  ci: null as unknown,
  replies: { replies: [], waiting: [] } as unknown,
  prompts: [] as Array<{ id: string; body: string }>,
  fixes: [] as string[],
  ciFails: null as string | null,
  configured: null as null | Array<{ label: string; prompt: string; repos?: string[] }>,
}));
// The event stream: a test fires events as work web would.
const sse = vi.hoisted(() => ({ handlers: {} as Record<string, (d: unknown) => void> }));
vi.mock('../../src/web/src/api/events.js', () => ({
  useSse: (_path: string, o: { events: Record<string, (d: unknown) => void> }) => void Object.assign(sse.handlers, o.events),
}));
vi.mock('../../src/web/src/api/client.js', async (orig) => ({
  ...(await orig<typeof import('../../src/web/src/api/client.js')>()),
  fetchSessionCi: async () => {
    if (h.ciFails) throw new Error(h.ciFails);
    return h.ci;
  },
  fetchReplies: async () => h.replies,
  sendPromptToSession: async (id: string, body: string) => void h.prompts.push({ id, body }),
  askClaudeToFixCi: async (id: string) => void h.fixes.push(id),
}));
vi.mock('../../src/web/src/components/Dashboard/PromptsMenu.js', async (orig) => ({
  ...(await orig<typeof import('../../src/web/src/components/Dashboard/PromptsMenu.js')>()),
  fetchPrompts: async () => {
    const { DEFAULT_PROMPTS } = await import('../../src/core/sessions/saved-prompts.js');
    return { prompts: h.configured ?? DEFAULT_PROMPTS, configured: !!h.configured };
  },
}));
import { PrTab } from '../../src/web/src/components/Dashboard/PrTab.js';

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  h.prompts.length = 0;
  h.fixes.length = 0;
  h.ciFails = null;
  h.configured = null;
  h.replies = { replies: [], waiting: [] };
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const session = { id: 's1', target: 'acme', branch: 'fix/x', isGroup: true, paths: ['/a', '/b'] } as unknown as SessionSummary;
const shipPr = (number: number, over: Record<string, unknown> = {}) => ({
  number,
  url: `https://gh/${number}`,
  state: 'OPEN',
  isDraft: false,
  mergeStateStatus: 'CLEAN',
  checks: 'pass',
  headSha: 'abc',
  ...over,
});
const thread = (prNumber: number, id: string, trusted = true) => ({
  threadId: id,
  repo: 'frontend',
  prNumber,
  url: 'u',
  where: 'a.ts:1',
  reviewer: 'copilot',
  excerpt: `comment ${id}`,
  trusted,
});
const button = (text: string | RegExp) =>
  [...container.querySelectorAll('button')].find((b) =>
    typeof text === 'string' ? b.textContent === text : text.test(b.textContent ?? ''),
  ) as HTMLButtonElement | undefined;

async function render(prs: PrInfo[] = [], onShip = vi.fn()) {
  await act(async () => {
    root.render(createElement(PrTab, { session, prs, onShip }));
  });
  await act(async () => {});
  return onShip;
}

describe('the PR tab', () => {
  it('a section per PR, what wants you first and open, a merged one folded; threads under their own PR', async () => {
    h.ci = {
      checkedAt: '',
      repos: [
        { name: 'backend', done: true, pr: shipPr(3509, { state: 'MERGED', mergedAt: '2026-10-05T08:40:20Z' }) },
        {
          name: 'frontend',
          done: false,
          pr: shipPr(1927, { checks: 'fail', failing: [{ name: 'build', url: 'https://ci/1' }], author: 'reviewer-a' }),
        },
      ],
    } as unknown as SessionCi;
    h.replies = { replies: [], waiting: [thread(1927, 'T1'), thread(1927, 'T2')] } as unknown as RepliesWire;
    await render();
    const sections = [...container.querySelectorAll('.wd-pr-section')];
    expect(sections.map((s) => s.querySelector('.wd-pr-name')!.textContent)).toEqual(['frontend #1927', 'backend #3509']);
    expect(sections[0].querySelector('.wd-pr-author')!.textContent).toBe('by @reviewer-a'); // who opened it
    expect(sections[1].querySelector('.wd-pr-author')).toBeNull(); // not known: nothing said
    expect(sections[0].textContent).toContain('Checks failing: build');
    expect(sections[0].textContent).toContain('2 unresolved review threads with no reply yet');
    // Merged: folded, its name and when it merged.
    expect(sections[1].querySelector<HTMLElement>('.wd-pr-section-body')!.hidden).toBe(true);
    expect(sections[1].querySelector('.wd-prtab-stage')!.textContent).toMatch(/^merged .* ago$/);
    expect(container.querySelector('.wd-pr-summary')!.textContent).toContain('3 things want you across 2 PRs');
  });

  it('your own PR says no "by @you" (the watch knows who you are) (reviewed)', async () => {
    h.ci = {
      checkedAt: '',
      viewer: 'me',
      repos: [{ name: 'frontend', done: false, pr: shipPr(1927, { author: 'Me' }) }],
    } as unknown as SessionCi;
    h.replies = { replies: [], waiting: [] } as unknown as RepliesWire;
    await render();
    expect(container.querySelector('.wd-pr-author')).toBeNull();
  });

  it('one Ask on top for every trusted thread with no reply, across the PRs — a plan, nothing changed', async () => {
    h.ci = {
      checkedAt: '',
      repos: [
        { name: 'frontend', done: false, pr: shipPr(1927) },
        { name: 'backend', done: false, pr: shipPr(3509) },
      ],
    } as unknown as SessionCi;
    h.replies = {
      replies: [],
      waiting: [thread(1927, 'T1'), { ...thread(3509, 'T2'), repo: 'backend' }, thread(1927, 'T3', false)],
    } as unknown as RepliesWire;
    await render();
    await act(async () => button('Ask Claude about all 2 threads')!.click());
    expect(h.prompts).toHaveLength(1);
    expect(h.prompts[0].body).toContain('[thread T1]');
    expect(h.prompts[0].body).toContain('[thread T2]');
    expect(h.prompts[0].body).not.toContain('T3'); // not from someone with write access: from its card
    expect(h.prompts[0].body).toContain('Plan first, change nothing');
    expect(button('Asked — the drafts will show here')!.disabled).toBe(true);
  });

  it('failing checks: Ask Claude to fix; Ship… opens the Ship panel', async () => {
    h.ci = { checkedAt: '', repos: [{ name: 'frontend', done: false, pr: shipPr(1927, { checks: 'fail' }) }] } as unknown as SessionCi;
    const onShip = await render();
    await act(async () => button('Ask Claude to fix')!.click());
    expect(h.fixes).toEqual(['s1']);
    expect(container.textContent).toContain('Sent to Claude ✓');
    act(() => button('Ship…')!.click());
    expect(onShip).toHaveBeenCalled();
  });

  it('a second PR from the same branch, only in the PR list, gets its own section (no Ship, no CI fix: less is known)', async () => {
    h.ci = { checkedAt: '', repos: [{ name: 'frontend', done: false, pr: shipPr(1927) }] } as unknown as SessionCi;
    await render([
      {
        number: 1990,
        title: 'Into main',
        branch: 'fix/x',
        url: 'https://gh/1990',
        isDraft: false,
        checksStatus: 'FAILURE',
        reviewDecision: 'NONE',
        myReview: 'NONE',
        isMine: true,
        repoAlias: 'frontend',
      },
    ]);
    const second = [...container.querySelectorAll('.wd-pr-section')].find((s) => s.textContent?.includes('#1990'))!;
    expect(second.textContent).toContain('Into main');
    expect(second.textContent).toContain('Checks failing');
    expect([...second.querySelectorAll('button')].map((b) => b.textContent)).not.toContain('Ask Claude to fix');
  });

  it('no pull request yet: says so, and asks Claude to open one', async () => {
    h.ci = { checkedAt: '', repos: [{ name: 'frontend', done: false, pr: null }] } as unknown as SessionCi;
    await render();
    expect(container.textContent).toContain('No pull request yet.');
    await act(async () => button('Open a pull request')!.click());
    expect(h.prompts[0].body).toContain('gh pr create');
  });
});

describe('the PR tab, as reviewed', () => {
  const ciOf = (...repos: Array<[string, Record<string, unknown>]>) =>
    ({ checkedAt: '', repos: repos.map(([name, pr]) => ({ name, done: false, pr })) }) as unknown as SessionCi;

  it("one Ask anywhere is every Ask's: after the top one, a section's own and each thread's aren't offered again", async () => {
    h.ci = ciOf(['frontend', shipPr(1927)]);
    h.replies = { replies: [], waiting: [thread(1927, 'T1'), thread(1927, 'T2'), thread(1927, 'T3')] } as unknown as RepliesWire;
    await render();
    await act(async () => button('Ask Claude about all 3 threads')!.click());
    expect(h.prompts).toHaveLength(1);
    expect(button('Ask Claude about all 3')).toBeUndefined(); // the section's own
    act(() => button('Show the threads ▾')!.click());
    expect(button('Ask Claude to reply')).toBeUndefined(); // each thread's
  });

  it("a section's fold follows what's in it until you click: a merged PR whose draft loads later opens", async () => {
    h.ci = ciOf(['backend', shipPr(3509, { state: 'MERGED' })]);
    h.replies = { replies: [], waiting: [] } as unknown as RepliesWire;
    await render();
    const body = () => container.querySelector<HTMLElement>('.wd-pr-section-body')!;
    expect(body().hidden).toBe(true);
    // A draft to post arrives for it (replies-changed): it wants you now.
    h.replies = {
      replies: [{ ...thread(3509, 'D1'), repo: 'backend', status: 'draft', draft: 'Fixed', sentAt: '' }],
      waiting: [],
    } as unknown as RepliesWire;
    await act(async () => sse.handlers['replies-changed']({ sessionId: 's1' }));
    await act(async () => {});
    expect(body().hidden).toBe(false);
  });

  it('a draft being edited survives folding its section (kept mounted)', async () => {
    h.ci = ciOf(['frontend', shipPr(1927)]);
    h.replies = {
      replies: [{ ...thread(1927, 'D1'), status: 'draft', draft: 'Fixed', sentAt: '' }],
      waiting: [],
    } as unknown as RepliesWire;
    await render();
    const ta = container.querySelector<HTMLTextAreaElement>('.wd-reply-text')!;
    const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
    act(() => {
      setValue.call(ta, 'Fixed, and added a test.');
      ta.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const fold = container.querySelector<HTMLButtonElement>('.wd-pr-fold')!;
    act(() => fold.click());
    act(() => fold.click());
    expect(container.querySelector<HTMLTextAreaElement>('.wd-reply-text')!.value).toBe('Fixed, and added a test.');
  });

  it('a failed read says so, rather than loading forever', async () => {
    h.ciFails = 'unknown session';
    await render();
    expect(container.textContent).toContain("Couldn't read its pull requests: unknown session");
  });

  it('Open a pull request sends the prompt as configured, and an archived session offers nothing', async () => {
    h.ci = ciOf();
    h.configured = [{ label: 'Open a pull request', prompt: 'Our own PR prompt.' }];
    await render();
    await act(async () => button('Open a pull request')!.click());
    expect(h.prompts[0].body).toBe('Our own PR prompt.');
    act(() => root.unmount());
    root = createRoot(container);
    await act(async () => {
      root.render(createElement(PrTab, { session: { ...session, archivedAt: '2026-10-06' } as SessionSummary, prs: [], onShip: vi.fn() }));
    });
    await act(async () => {});
    expect(container.textContent).toContain('No pull request yet.');
    expect(button('Open a pull request')).toBeUndefined();
  });
});
