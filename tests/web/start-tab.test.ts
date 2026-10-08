// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { JiraIssue, JiraWatchState, PrInfo } from '../../src/web/src/api/panes.js';
import type { SessionSummary } from '../../src/web/src/api/client.js';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const api = vi.hoisted(() => ({
  issues: [] as JiraIssue[],
  prs: [] as PrInfo[],
  watch: null as unknown as JiraWatchState,
  setJiraWatch: vi.fn(),
  startJiraIssue: vi.fn(),
  dismissJiraIssue: vi.fn(),
}));
vi.mock('../../src/web/src/api/panes.js', () => ({
  fetchJira: async () => ({ issues: api.issues, available: true }),
  fetchJiraWatch: async () => api.watch,
  setJiraWatch: (on: boolean) => api.setJiraWatch(on),
  startJiraIssue: (k: string, t: string) => api.startJiraIssue(k, t),
  dismissJiraIssue: (k: string) => api.dismissJiraIssue(k),
}));
vi.mock('../../src/web/src/api/events.js', () => ({ useSse: () => {} }));
const { StartTab, prState, sessionForPr, waitsForYourReview } = await import('../../src/web/src/components/Dashboard/tabs/StartTab.js');
const { JiraTab, sessionForIssue } = await import('../../src/web/src/components/Dashboard/tabs/JiraTab.js');

const issue = (key: string, status: string, statusCategory: JiraIssue['statusCategory']): JiraIssue => ({
  key,
  summary: `Do ${key}`,
  status,
  statusCategory,
  issuetype: 'Task',
  priority: 'Low',
  url: `u/${key}`,
});

const pr = (over: Partial<PrInfo>): PrInfo => ({
  number: 1,
  title: 't',
  branch: 'b',
  url: 'https://gh/1',
  isDraft: false,
  checksStatus: 'SUCCESS',
  reviewDecision: 'NONE',
  myReview: 'NONE',
  isMine: true,
  repoAlias: 'api',
  ...over,
});
const session = (over: Partial<SessionSummary>) =>
  ({ id: 's', target: 'api', branch: 'b', isGroup: false, paths: [], createdAt: '', lastAccessedAt: '', ...over }) as SessionSummary;
const SESSIONS = [
  session({ id: 'deps', branch: 'chore/deps-update' }),
  session({ id: 'sd3', branch: 'feat/SD-3', jiraKey: 'SD-3' }),
  session({ id: 'gone', branch: 'feat/cache', archivedAt: '2026-10-01T00:00:00Z' }),
];

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  api.issues = [
    issue('SD-3', 'Review', 'indeterminate'),
    issue('SD-1', 'New', 'new'),
    issue('SD-2', 'In Progress', 'indeterminate'),
    issue('SD-9', 'Done', 'done'),
  ];
  api.prs = [
    pr({ number: 212, title: 'Updated express and zod', branch: 'chore/deps-update', checksStatus: 'FAILURE' }),
    pr({ number: 208, title: 'Cache product images', branch: 'feat/cache', reviewDecision: 'APPROVED' }),
    pr({
      number: 99,
      title: 'Someone else’s',
      branch: 'feat/other',
      isMine: false,
      reviewDecision: 'REVIEW_REQUIRED',
      reviewRequested: true,
    }),
    // Needs a review, but not asked of you: not yours to review.
    pr({ number: 97, title: 'Asked of someone else', branch: 'feat/y', isMine: false, reviewDecision: 'REVIEW_REQUIRED' }),
    pr({ number: 98, title: 'Not for me', branch: 'feat/x', isMine: false }),
  ];
  api.watch = {
    settings: { enabled: false, since: null },
    decisions: [
      {
        key: 'SD-1',
        summary: 'Do SD-1',
        url: 'u',
        at: '2026-10-01T10:00:00Z',
        action: 'suggested',
        target: 'straumur',
        reason: 'could be either',
      },
      {
        key: 'SD-2',
        summary: 'Do SD-2',
        url: 'u',
        at: '2026-10-01T10:00:00Z',
        action: 'started',
        target: 'jobly',
        sessionId: 'sid-2',
        reason: 'jobly work',
      },
    ],
    targets: ['straumur', 'jobly'],
    lastRunAt: null,
    nextRunAt: null,
  };
  for (const f of [api.setJiraWatch, api.startJiraIssue, api.dismissJiraIssue]) f.mockReset().mockResolvedValue({ ok: true });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const flush = () =>
  act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
const button = (label: string) => [...container.querySelectorAll('button')].find((b) => b.textContent === label)!;

function render(over: Record<string, unknown> = {}) {
  const props = {
    sessions: SESSIONS,
    prs: api.prs,
    onNewWorktree: vi.fn(),
    onPickPr: vi.fn(),
    onOpenSession: vi.fn(),
    ...over,
  };
  act(() => root.render(createElement(StartTab, props)));
  return props;
}
function renderJira(over: Record<string, unknown> = {}) {
  const props = { sessions: SESSIONS, onPickIssue: vi.fn(), onOpenSession: vi.fn(), ...over };
  act(() => root.render(createElement(JiraTab, props)));
  return props;
}
const rowOf = (key: string) =>
  [...container.querySelectorAll('.wd-start-row')].find((r) => r.querySelector('.wd-start-key')?.textContent === key)!;

describe('Start', () => {
  it('New worktree on top; no Jira here (it has its own page)', async () => {
    const p = render();
    await flush();
    act(() => button('New worktree').click());
    expect(p.onNewWorktree).toHaveBeenCalled();
    expect(container.querySelector('section[aria-label="Jira issues assigned to you"]')).toBeNull();
    expect(container.querySelector('.wd-jira-watch-switch')).toBeNull();
  });

  it('Jira: issues in workflow order (done ones left out)', async () => {
    renderJira();
    await flush();
    const keys = [...container.querySelectorAll('section[aria-label="Jira issues assigned to you"] .wd-start-key')].map(
      (k) => k.textContent,
    );
    expect(keys).toEqual(['SD-1', 'SD-2', 'SD-3']);
  });

  it('each issue and PR: Start, or a link to the session already on it', async () => {
    const j = renderJira();
    await flush();
    act(() => rowOf('SD-1').querySelector<HTMLButtonElement>('button')!.click());
    expect(j.onPickIssue).toHaveBeenCalledWith(expect.objectContaining({ key: 'SD-1' }));
    const sd3 = rowOf('SD-3').querySelector<HTMLButtonElement>('.wd-start-existing')!;
    expect(sd3.textContent).toBe('feat/SD-3 →');
    act(() => sd3.click());
    expect(j.onOpenSession).toHaveBeenCalledWith('sd3');
    const p = render();
    await flush();
    // #212 has a session; #208's was archived, so it's Start again.
    expect(rowOf('#212').querySelector('.wd-start-existing')!.textContent).toBe('chore/deps-update →');
    act(() => [...rowOf('#208').querySelectorAll('button')].find((b) => b.textContent === 'Start')!.click());
    expect(p.onPickPr).toHaveBeenCalledWith(expect.objectContaining({ number: 208 }));
    expect(rowOf('#212').querySelector('.wd-start-state')!.textContent).toBe('Checks failing');
  });

  it('your PRs, then the ones waiting for your review; others are left out', async () => {
    render();
    await flush();
    const numbers = (label: string) =>
      [...container.querySelectorAll(`section[aria-label="${label}"] .wd-start-key`)].map((k) => k.textContent);
    expect(numbers('Your pull requests')).toEqual(['#212', '#208']);
    expect(numbers('Waiting for your review')).toEqual(['#99']);
    expect(container.textContent).not.toContain('Not for me');
    expect(container.textContent).not.toContain('Asked of someone else');
    // Someone else's PR is reviewed, not started on.
    expect([...rowOf('#99').querySelectorAll('button')].map((b) => b.textContent)).toEqual(['Review']);
  });

  it("says who opened someone else's PR (not on yours)", async () => {
    api.prs = [...api.prs.map((p) => (p.number === 99 ? { ...p, author: 'dana' } : { ...p, author: 'me' }))];
    render();
    await flush();
    expect(rowOf('#99').textContent).toContain('by @dana');
    // A long title truncates; the author is in its own span after it, and in the tooltip.
    expect(rowOf('#99').querySelector('.wd-start-what > .wd-start-author')!.textContent).toBe('· by @dana');
    expect(rowOf('#99').querySelector('.wd-start-what')!.getAttribute('title')).toContain('by @dana');
    expect(rowOf('#208').textContent).not.toContain('by @');
  });

  it("someone else's PR: Work on it (their branch) beside Review; a fork's is offered but disabled, saying why", async () => {
    api.prs = [
      ...api.prs,
      pr({ number: 77, title: 'From a fork', branch: 'patch-1', isMine: false, reviewRequested: true, fork: true, author: 'outsider' }),
    ];
    const onWorkOnPr = vi.fn();
    render({ onWorkOnPr });
    await flush();
    expect([...rowOf('#99').querySelectorAll('button')].map((b) => b.textContent)).toEqual(['Work on it', 'Review']);
    act(() => [...rowOf('#99').querySelectorAll('button')].find((b) => b.textContent === 'Work on it')!.click());
    expect(onWorkOnPr).toHaveBeenCalledWith(expect.objectContaining({ number: 99, branch: 'feat/other' }));
    const fork = [...rowOf('#77').querySelectorAll('button')].find((b) => b.textContent === 'Work on it')!;
    expect(fork.disabled).toBe(true);
    expect(fork.title).toContain('comes from a fork');
    // Your own PRs keep Start alone.
    expect([...rowOf('#208').querySelectorAll('button')].map((b) => b.textContent)).toEqual(['Start']);
  });

  it('Jira: the checkbox turns the watch on', async () => {
    renderJira();
    await flush();
    const box = [...container.querySelectorAll<HTMLLabelElement>('.wd-jira-watch-switch')][0].querySelector('input')!;
    expect(box.checked).toBe(false);
    expect(box.parentElement!.textContent).toContain('Start newly assigned Jira issues by themselves');
    await act(async () => box.click());
    expect(api.setJiraWatch).toHaveBeenCalledWith(true);
  });

  it('Jira: a watch suggestion: pick a project and Start in it (no dialog); a started one opens its session', async () => {
    const p = renderJira();
    await flush();
    expect(container.textContent).toContain('not sure where it belongs — maybe straumur');
    const select = container.querySelector<HTMLSelectElement>('select[aria-label="Project for SD-1"]')!;
    expect(select.value).toBe('straumur');
    await act(async () => button('Start in straumur').click());
    expect(api.startJiraIssue).toHaveBeenCalledWith('SD-1', 'straumur');
    expect(p.onPickIssue).not.toHaveBeenCalled();
    expect(container.textContent).toContain('started by itself in jobly');
    await act(async () => button('open').click());
    expect(p.onOpenSession).toHaveBeenCalledWith('sid-2');
  });

  it('says so when gh or acli is missing', async () => {
    render({ prs: null, prsNote: 'gh isn’t installed or logged in (gh auth login).' });
    await flush();
    expect(container.textContent).toContain('gh isn’t installed or logged in');
    renderJira({ loadJira: async () => ({ issues: [], available: false }) });
    await flush();
    expect(container.textContent).toContain('acli isn’t available or logged in.');
  });
});

describe('prState, and the session already on a PR or an issue', () => {
  it('reads a PR in a word or two', () => {
    expect(prState(pr({ isDraft: true, checksStatus: 'FAILURE' })).text).toBe('Draft');
    expect(prState(pr({ checksStatus: 'FAILURE' }))).toEqual({ text: 'Checks failing', tone: 'bad' });
    expect(prState(pr({ reviewDecision: 'CHANGES_REQUESTED' })).text).toBe('Changes requested');
    expect(prState(pr({ reviewDecision: 'APPROVED' }))).toEqual({ text: 'Approved', tone: 'good' });
    expect(prState(pr({ checksStatus: 'PENDING' })).text).toBe('Checks running');
    expect(prState(pr({ reviewDecision: 'REVIEW_REQUIRED' })).text).toBe('Review needed');
    expect(prState(pr({})).text).toBe('Open');
  });

  it('matches live sessions only', () => {
    expect(sessionForPr(pr({ branch: 'chore/deps-update' }), SESSIONS)?.id).toBe('deps');
    expect(sessionForPr(pr({ branch: 'feat/cache' }), SESSIONS)).toBeUndefined(); // archived
    expect(sessionForPr(pr({ branch: 'chore/deps-update', repoAlias: 'web' }), SESSIONS)).toBeUndefined();
    expect(sessionForIssue(issue('SD-3', 'Review', 'indeterminate'), SESSIONS)?.id).toBe('sd3');
  });
});

describe('Start: what is already someone’s', () => {
  it('a session on the issue’s branch (no Jira key) is the issue’s session', () => {
    const plain = session({ id: 'pay', branch: 'feat/PAY-12' });
    expect(sessionForIssue(issue('PAY-12', 'To Do', 'new'), [plain])?.id).toBe('pay');
  });

  it('a group session claims only its own repos’ PRs (when the groups are known)', () => {
    const group = session({ id: 'g', target: 'platform', branch: 'feat/auth', isGroup: true });
    const outside = pr({ branch: 'feat/auth', repoAlias: 'billing' });
    const inside = pr({ branch: 'feat/auth', repoAlias: 'auth-api' });
    const members = (g: string) => (g === 'platform' ? ['auth-api', 'auth-web'] : undefined);
    expect(sessionForPr(outside, [group], members)).toBeUndefined();
    expect(sessionForPr(inside, [group], members)?.id).toBe('g');
    // Groups not known yet: any same-branch PR, as before.
    expect(sessionForPr(outside, [group])?.id).toBe('g');
  });

  it('a merge conflict reads as one, not as failing checks', () => {
    expect(prState(pr({ conflicting: true, checksStatus: 'SUCCESS' }))).toEqual({ text: 'Merge conflict', tone: 'bad' });
  });

  it('waiting for your review: asked of you by name, not reviewed yet, not yours', () => {
    expect(waitsForYourReview(pr({ isMine: false, reviewRequested: true }))).toBe(true);
    expect(waitsForYourReview(pr({ isMine: false, reviewRequested: true, myReview: 'COMMENTED' }))).toBe(false);
    expect(waitsForYourReview(pr({ isMine: false, reviewDecision: 'REVIEW_REQUIRED' }))).toBe(false);
    expect(waitsForYourReview(pr({ isMine: true, reviewRequested: true }))).toBe(false);
  });
});
