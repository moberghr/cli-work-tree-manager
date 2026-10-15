// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { SessionSummary } from '../../src/web/src/api/client.js';
import { pointParam, type DiffPoint } from '../../src/core/diff/diff-points.js';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// Every diff fetch is recorded (with its range) and answered with one
// file named after the request, so the test can see which scope loaded.
const h = vi.hoisted(() => {
  const calls: Array<{ sessionId: string; base: string; range?: { from: string; to: string } }> = [];
  let checkpoints: Array<{ id: number; ts: string; label?: string; repos: Record<string, string | null> }> = [];
  let commits: Array<{ repo: string; sha: string; subject: string; at: string }> = [];
  const diffFor = (sessionId: string, file: string) => ({
    sessionId,
    base: 'uncommitted',
    resolvedBase: 'main',
    repos: [
      {
        name: 'repo',
        root: '/tmp/repo',
        files: [
          {
            path: file,
            oldPath: file,
            newPath: file,
            status: 'modified',
            isBinary: false,
            added: 1,
            deleted: 0,
            hunks: [
              {
                oldStart: 1,
                oldLines: 0,
                newStart: 1,
                newLines: 1,
                context: '',
                lines: [{ kind: 'add', content: `in ${sessionId}`, oldNum: null, newNum: 1 }],
              },
            ],
          },
        ],
      },
    ],
  });
  /** A group's repos: a scope or a turn has each (an empty one listed too); a commit's span its repo alone. */
  let groupRepos: Array<{ name: string; files: number }> | null = null;
  const groupDiff = (sessionId: string, file: string, range?: { from: string; to: string }) => {
    const one = diffFor(sessionId, file).repos[0];
    const commitRepo = range && [range.from, range.to].map((p) => /^[cp]:([^:]+):/.exec(p)?.[1]).find(Boolean);
    return {
      ...diffFor(sessionId, file),
      repos: groupRepos!
        .filter((r) => !commitRepo || r.name === commitRepo)
        .map((r) => ({ ...one, name: r.name, root: `/tmp/${r.name}`, files: one.files.slice(0, r.files) })),
    };
  };
  return {
    calls,
    diffFor,
    groupDiff,
    get groupRepos() {
      return groupRepos;
    },
    set groupRepos(v) {
      groupRepos = v;
    },
    get checkpoints() {
      return checkpoints;
    },
    set checkpoints(v) {
      checkpoints = v;
    },
    get commits() {
      return commits;
    },
    set commits(v) {
      commits = v;
    },
  };
});

// The event stream: a test fires events as work web would.
const sse = vi.hoisted(() => ({ handlers: {} as Record<string, (d: unknown) => void>, historyCalls: 0 }));
vi.mock('../../src/web/src/api/events.js', () => ({
  useSse: (_path: string, o: { events: Record<string, (d: unknown) => void> }) => void Object.assign(sse.handlers, o.events),
}));
vi.mock('../../src/web/src/api/review-api.js', () => ({
  sessionReviewApi: () => ({
    fetch: () => Promise.resolve([]),
    post: () => Promise.resolve({ comments: [] }),
    delete: () => Promise.resolve({ comments: [] }),
    resolve: () => Promise.resolve({ comments: [] }),
    submit: () => Promise.resolve({ comments: [], count: 0 }),
    discard: () => Promise.resolve({ comments: [], discarded: 0 }),
    done: () => Promise.resolve(),
    ssePath: '/events',
  }),
}));
vi.mock('../../src/web/src/api/client.js', async (importActual) => {
  const actual = await importActual<typeof import('../../src/web/src/api/client.js')>();
  return {
    ...actual,
    fetchSessionDiff: (sessionId: string, base: string, range?: { from: DiffPoint; to: DiffPoint }) => {
      const r = range && { from: pointParam(range.from), to: pointParam(range.to) };
      h.calls.push({ sessionId, base, range: r });
      const file = r ? `${r.from}..${r.to}.txt` : `${base}.txt`;
      return Promise.resolve(h.groupRepos ? h.groupDiff(sessionId, file, r) : h.diffFor(sessionId, file));
    },
    fetchSessionHistory: () => {
      sse.historyCalls++;
      return Promise.resolve({ scopeHash: 'scope-of-s', entries: h.checkpoints, commits: h.commits });
    },
    fetchCheckpoints: () => Promise.resolve([]),
  };
});

import { DiffView } from '../../src/web/src/components/Diff/DiffView.js';

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  localStorage.clear();
  h.calls.length = 0;
  h.checkpoints = [];
  h.commits = [];
  h.groupRepos = null;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const session = (id: string): SessionSummary => ({
  id,
  target: 'repo',
  branch: 'feat/x',
  isGroup: false,
  paths: ['/tmp/repo'],
  createdAt: '2026-09-01T00:00:00Z',
  lastAccessedAt: '2026-09-01T00:00:00Z',
});
const entry = (id: number, label?: string) => ({ id, ts: `2026-09-01T00:0${id}:00Z`, label, repos: { repo: null } });
const flush = () =>
  act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
const tab = (name: string) =>
  [...container.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find((b) => b.textContent?.trim() === name)!;
const pickerLabel = () => container.querySelector('.wd-history-btn')!.textContent!.replace('▾', '').trim();
async function openPicker() {
  if (!container.querySelector('.wd-history-pop'))
    await act(async () => container.querySelector<HTMLButtonElement>('.wd-history-btn')!.click());
}
/** The picker's rows, newest first, as their tag and title read. */
async function rows() {
  await openPicker();
  return [...container.querySelectorAll('.wd-history-row')].map((r) =>
    [r.querySelector('.wd-history-tag')!.textContent, r.querySelector('.wd-checkpoint-pop-label')!.textContent].join(' ').trim(),
  );
}
async function clickRow(tag: string, shift = false) {
  await openPicker();
  const row = [...container.querySelectorAll<HTMLButtonElement>('.wd-history-row')].find(
    (r) => r.querySelector('.wd-history-tag')!.textContent === tag,
  )!;
  await act(async () => row.dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: shift })));
  await flush();
}
async function preset(name: string) {
  await openPicker();
  const b = [...container.querySelectorAll<HTMLButtonElement>('.wd-checkpoint-pop-preset')].find((x) => x.textContent?.startsWith(name));
  if (!b) return false;
  await act(async () => b.click());
  await flush();
  return true;
}

async function render(id = 's1', startOnLastTurn = false) {
  await act(async () => {
    root.render(createElement(DiffView, { session: session(id), startOnLastTurn }));
  });
  await flush();
}

describe('DiffView: the Changes picker (commits and turns)', () => {
  it('is always there: with nothing finished yet it lists what is uncommitted, and no Last turn', async () => {
    h.checkpoints = [entry(0, 'Initial')];
    await render();
    expect(pickerLabel()).toBe('Changes: all');
    expect(await rows()).toEqual(['Uncommitted']);
    expect(container.textContent).toContain('No commits on this branch and no finished turns yet.');
    expect(await preset('Last turn')).toBe(false);
  });

  it('a turn alone, another, then a span (Shift+click); a scope tab drops it', async () => {
    h.checkpoints = [entry(0, 'Initial'), entry(1, 'Wrote it'), entry(2, 'Fixed review')];
    await render();
    expect(container.textContent).toContain('uncommitted.txt');
    expect(await rows()).toEqual(['Uncommitted', 'Turn 2 Fixed review', 'Turn 1 Wrote it']);

    await clickRow('Turn 2');
    expect(h.calls.at(-1)?.range).toEqual({ from: 'cp:1', to: 'cp:2' });
    expect(container.textContent).toContain('cp:1..cp:2.txt');
    expect(pickerLabel()).toBe('Changes: Turn 2 · Fixed review');
    expect(tab('Uncommitted').getAttribute('aria-selected')).toBe('false');
    expect(tab('Since branch').getAttribute('aria-selected')).toBe('false');

    await clickRow('Turn 1');
    expect(h.calls.at(-1)?.range).toEqual({ from: 'cp:0', to: 'cp:1' });
    // Shift+click: from the last click to it — turn 1 up to what is uncommitted.
    await clickRow('Uncommitted', true);
    expect(h.calls.at(-1)?.range).toEqual({ from: 'cp:0', to: 'working' });
    expect(pickerLabel()).toBe('Changes: Turn 1 → Uncommitted');

    await act(async () => tab('Since branch').click());
    await flush();
    expect(h.calls.at(-1)).toMatchObject({ base: 'branch', range: undefined });
    expect(pickerLabel()).toBe('Changes: all');
  });

  it("lists the branch's commits among the turns by time; a commit alone, or from it to the working tree", async () => {
    h.checkpoints = [entry(0, 'Initial'), entry(1, 'Wrote it'), entry(2, 'Fixed review')];
    const sha = '604e66a1b2c3d4e5f60718293a4b5c6d7e8f9012';
    h.commits = [{ repo: 'repo', sha, subject: 'Commit the first part', at: '2026-09-01T00:01:30Z' }];
    await render();
    expect(await rows()).toEqual(['Uncommitted', 'Turn 2 Fixed review', '604e66a Commit the first part', 'Turn 1 Wrote it']);
    await clickRow('604e66a');
    expect(h.calls.at(-1)?.range).toEqual({ from: `p:repo:${sha}`, to: `c:repo:${sha}` });
    expect(pickerLabel()).toBe('Changes: 604e66a · Commit the first part');
    await clickRow('Uncommitted', true);
    expect(h.calls.at(-1)?.range).toEqual({ from: `p:repo:${sha}`, to: 'working' });
  });

  it('what is uncommitted, picked alone, is the Uncommitted scope (the one Revert works in)', async () => {
    h.checkpoints = [entry(0), entry(1)];
    await render();
    await clickRow('Turn 1');
    await clickRow('Uncommitted');
    expect(h.calls.at(-1)).toMatchObject({ base: 'uncommitted', range: undefined });
    expect(tab('Uncommitted').getAttribute('aria-selected')).toBe('true');
  });
});

describe('DiffView "Last turn"', () => {
  it('opened to review finished work, it starts on the last turn — once, then the picks are yours', async () => {
    h.checkpoints = [entry(0), entry(1), entry(2)];
    await render('s1', true);
    await flush();
    expect(h.calls.at(-1)?.range).toEqual({ from: 'cp:1', to: 'cp:2' });
    expect(pickerLabel()).toBe('Changes: Last turn');
    await act(async () => tab('Uncommitted').click());
    await flush();
    await render('s1', true); // a re-render (SSE refresh) doesn't pull you back
    expect(tab('Uncommitted').getAttribute('aria-selected')).toBe('true');
    // No finished turn yet: stays on Uncommitted.
    h.checkpoints = [entry(0)];
    await render('s2', true);
    expect(h.calls.at(-1)).toMatchObject({ sessionId: 's2', range: undefined });
  });

  it('is a shortcut in the picker; switching sessions starts over on Uncommitted', async () => {
    h.checkpoints = [entry(0), entry(1)];
    await render('s1');
    expect(await preset('Last turn')).toBe(true);
    expect(h.calls.at(-1)?.range).toEqual({ from: 'cp:0', to: 'cp:1' });
    await render('s2');
    expect(h.calls.at(-1)).toMatchObject({ sessionId: 's2', range: undefined });
  });
});

describe('DiffView: when the history is read again', () => {
  it("a turn of this session reloads it; another session's turn doesn't", async () => {
    h.checkpoints = [entry(0), entry(1)];
    await render();
    const before = sse.historyCalls;
    await act(async () => sse.handlers['checkpoints-changed']({ scopeHash: 'another-session', id: 4 }));
    expect(sse.historyCalls).toBe(before);
    await act(async () => sse.handlers['checkpoints-changed']({ scopeHash: 'scope-of-s', id: 2 }));
    expect(sse.historyCalls).toBe(before + 1);
  });

  it('a change soon after a load (a commit by hand) is read when the quiet window ends, not dropped', async () => {
    vi.useFakeTimers();
    try {
      h.checkpoints = [entry(0)];
      await act(async () => {
        root.render(createElement(DiffView, { session: session('s9') }));
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      const before = sse.historyCalls;
      await act(async () => sse.handlers['diff-changed'](null));
      expect(sse.historyCalls).toBe(before); // too soon: waits…
      await act(async () => sse.handlers['diff-changed'](null)); // …and a second change doesn't queue another
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5_000);
      });
      expect(sse.historyCalls).toBe(before + 1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('DiffView: a group', () => {
  it("a span from a commit says it shows that commit's repo alone", async () => {
    h.checkpoints = [entry(0), entry(1)];
    const sha = '604e66a1b2c3d4e5f60718293a4b5c6d7e8f9012';
    h.commits = [{ repo: 'repo', sha, subject: 'Commit it', at: '2026-09-01T00:00:30Z' }];
    await act(async () => {
      root.render(createElement(DiffView, { session: { ...session('g1'), isGroup: true, paths: ['/tmp/repo', '/tmp/other'] } }));
    });
    await flush();
    expect(container.querySelector('.wd-dash-difftoolbar')!.textContent).not.toContain('repo only');
    await clickRow('604e66a');
    await clickRow('Uncommitted', true);
    expect(h.calls.at(-1)?.range).toEqual({ from: `p:repo:${sha}`, to: 'working' });
    expect(container.querySelector('.wd-dash-difftoolbar')!.textContent).toContain('repo only');
  });

  const repoTabs = () =>
    [...container.querySelectorAll<HTMLButtonElement>('.wd-diff-repo-switch [role="tab"]')].map(
      (b) => `${b.textContent}${b.getAttribute('aria-selected') === 'true' ? ' *' : ''}`,
    );
  const repoTab = (name: string) =>
    [...container.querySelectorAll<HTMLButtonElement>('.wd-diff-repo-switch [role="tab"]')].find((b) => b.textContent?.startsWith(name))!;
  const renderGroup = async () => {
    await act(async () => {
      root.render(
        createElement(DiffView, {
          session: { ...session('g2'), isGroup: true, paths: ['/wt/grp/backend', '/wt/grp/frontend'] },
        }),
      );
    });
    await flush();
  };

  it("the repos are in the toolbar, always, in the session's order — none above the diff", async () => {
    h.groupRepos = [
      { name: 'backend', files: 0 },
      { name: 'frontend', files: 1 },
    ];
    await renderGroup();
    // The one with changes is open; the empty one is still there, in its place.
    expect(repoTabs()).toEqual(['backend 0', 'frontend 1 *']);
    expect(repoTab('backend').classList.contains('wd-diff-repo-empty')).toBe(true);
    expect(container.querySelector('.wd-web-repo-tabs')).toBeNull();
    await act(async () => repoTab('backend').click());
    expect(repoTabs()).toEqual(['backend 0 *', 'frontend 1']);
  });

  it('a commit of one repo picked: the other repo is one click away (its branch), not a dead end', async () => {
    h.groupRepos = [
      { name: 'backend', files: 1 },
      { name: 'frontend', files: 1 },
    ];
    h.checkpoints = [entry(0)];
    const sha = 'd04aeeb56a1b2c3d4e5f60718293a4b5c6d7e8f9';
    h.commits = [{ repo: 'frontend', sha, subject: 'Terminal type column', at: '2026-09-01T00:00:30Z' }];
    await renderGroup();
    await act(async () => repoTab('frontend').click());
    await clickRow('d04aeeb');
    expect(h.calls.at(-1)?.range).toEqual({ from: `p:frontend:${sha}`, to: `c:frontend:${sha}` });
    // The diff has the commit's repo alone; the switch still has both.
    expect(repoTabs()).toEqual(['backend', 'frontend 1 *']);
    await act(async () => repoTab('backend').click());
    await flush();
    expect(h.calls.at(-1)).toMatchObject({ base: 'branch', range: undefined });
    expect(tab('Since branch').getAttribute('aria-selected')).toBe('true');
    expect(repoTabs()).toEqual(['backend 1 *', 'frontend 1']);
  });

  it('a single repo has no repo switch', async () => {
    await render('s-one');
    expect(container.querySelector('.wd-diff-repo-switch')).toBeNull();
  });
});
