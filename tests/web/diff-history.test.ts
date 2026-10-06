import { describe, expect, it } from 'vitest';
import {
  historyItems,
  inSelection,
  lastTurn,
  pick,
  selectionLabel,
  selectionRange,
  sinceLooked,
  SINCE_BRANCH,
  UNCOMMITTED,
} from '../../src/web/src/state/diff-history.js';
import { emptyDiffMessage, orderRepoTabs, preferredRepo } from '../../src/web/src/state/diff-view.js';

const entry = (id: number, minute: number, label?: string) => ({
  id,
  ts: `2026-10-06T08:${String(minute).padStart(2, '0')}:00Z`,
  label,
  repos: {},
});
const commit = (repo: string, sha: string, minute: number, subject = `commit ${sha}`) => ({
  repo,
  sha: sha.padEnd(40, '0'),
  subject,
  at: `2026-10-06T08:${String(minute).padStart(2, '0')}:00Z`,
});

describe('historyItems', () => {
  it('turns and commits by time, oldest first, what is uncommitted last; a commit before a turn of the same minute', () => {
    const items = historyItems(
      [entry(0, 0, 'Initial'), entry(1, 10, 'Wrote it'), entry(2, 30)],
      [commit('api', 'aaaaaaa', 20), commit('api', 'bbbbbbb', 30)],
      null,
    );
    expect(items.map((i) => i.tag)).toEqual(['Turn 1', 'aaaaaaa', 'bbbbbbb', 'Turn 2', 'Uncommitted']);
    expect(items.map((i) => i.title)).toEqual(['Wrote it', 'commit aaaaaaa', 'commit bbbbbbb', '', '']);
    // Each is the tree before it and with it.
    expect(items[0]).toMatchObject({ before: { kind: 'checkpoint', id: 0 }, after: { kind: 'checkpoint', id: 1 } });
    expect(items[1]).toMatchObject({ before: { kind: 'parent', repo: 'api' }, after: { kind: 'commit', repo: 'api' } });
    expect(items[4]).toMatchObject({ before: { kind: 'head' }, after: { kind: 'working' } });
  });

  it("a group lists the commits of the repo on screen (a commit is one repo's); turns cover every repo", () => {
    const commits = [commit('backend', 'aaaaaaa', 5), commit('frontend', 'bbbbbbb', 6)];
    expect(historyItems([entry(0, 0), entry(1, 9)], commits, 'frontend').map((i) => i.tag)).toEqual(['bbbbbbb', 'Turn 1', 'Uncommitted']);
  });
});

describe('a pick', () => {
  const items = historyItems([entry(0, 0), entry(1, 10, 'Wrote it'), entry(2, 30, 'Fixed')], [commit('api', 'aaaaaaa', 20)], null);

  it('one row: the diff of that one; a span: from before its first to its last', () => {
    expect(selectionRange(items, pick('t:2'))).toEqual({ from: { kind: 'checkpoint', id: 1 }, to: { kind: 'checkpoint', id: 2 } });
    // Either order: Shift+click upwards or downwards.
    const span = { from: { kind: 'checkpoint', id: 0 }, to: { kind: 'working' } };
    expect(selectionRange(items, pick('u', 't:1'))).toEqual(span);
    expect(selectionRange(items, pick('t:1', 'u'))).toEqual(span);
    expect(selectionLabel(items, pick('u', 't:1'))).toBe('Turn 1 → Uncommitted');
    expect(selectionLabel(items, pick('t:1'))).toBe('Turn 1 · Wrote it');
  });

  it('what is uncommitted alone is the Uncommitted scope; a scope has no range and marks what it covers', () => {
    expect(pick('u')).toEqual(UNCOMMITTED);
    expect(selectionRange(items, UNCOMMITTED)).toBeNull();
    expect(items.filter((i) => inSelection(items, UNCOMMITTED, i.key)).map((i) => i.key)).toEqual(['u']);
    expect(items.every((i) => inSelection(items, SINCE_BRANCH, i.key))).toBe(true);
    expect(items.filter((i) => inSelection(items, pick('t:2', 'c:' + 'aaaaaaa'.padEnd(40, '0')), i.key)).map((i) => i.tag)).toEqual([
      'aaaaaaa',
      'Turn 2',
    ]);
  });

  it('a span whose rows are gone (a commit rewritten by a rebase) has no range: the view falls back', () => {
    expect(selectionRange(items, pick('c:' + 'f'.repeat(40)))).toBeNull();
  });

  it('Last turn: the newest turn alone; none before the first', () => {
    expect(selectionRange(items, lastTurn(items)!)).toEqual({ from: { kind: 'checkpoint', id: 1 }, to: { kind: 'checkpoint', id: 2 } });
    expect(lastTurn(historyItems([entry(0, 0)], [], null))).toBeNull();
  });

  it('Since you looked: from the turn seen to the working tree, marking every turn and commit after it', () => {
    const entries = [entry(0, 0), entry(1, 10), entry(2, 30)];
    const sel = sinceLooked(items, entries, 1)!;
    expect(selectionRange(items, sel)).toEqual({ from: { kind: 'checkpoint', id: 1 }, to: { kind: 'working' } });
    expect(items.filter((i) => inSelection(items, sel, i.key)).map((i) => i.tag)).toEqual(['aaaaaaa', 'Turn 2', 'Uncommitted']);
    expect(selectionLabel(items, sel)).toBe('Since you looked');
    // Nothing after it, or never looked: not offered.
    expect(sinceLooked(items, entries, 2)).toBeNull();
    expect(sinceLooked(items, entries, null)).toBeNull();
  });
});

describe('the repo tabs', () => {
  const repos = [
    { name: 'backend', files: [] },
    { name: 'frontend', files: [1] },
  ];

  it('open on the first repo with changes (not "No changes in backend"); a tab you clicked stays yours', () => {
    expect(preferredRepo(repos, null, null)).toBe('frontend');
    expect(preferredRepo(repos, 'backend', null)).toBe('frontend');
    expect(preferredRepo(repos, 'backend', 'backend')).toBe('backend');
    // Nothing anywhere: the first.
    expect(preferredRepo([{ name: 'a', files: [] }], null, null)).toBe('a');
  });

  it('repos with changes first, the empty ones after', () => {
    expect(orderRepoTabs(repos).map((r) => r.name)).toEqual(['frontend', 'backend']);
  });
});

describe('emptyDiffMessage', () => {
  it('says what was asked for', () => {
    expect(emptyDiffMessage(UNCOMMITTED, 'HEAD')).toBe('No uncommitted changes.');
    expect(emptyDiffMessage(SINCE_BRANCH, 'origin/main')).toMatch(/No commits since `origin\/main`/);
    expect(emptyDiffMessage(SINCE_BRANCH, 'HEAD')).toMatch(/Couldn't find this branch's parent/);
    expect(emptyDiffMessage(pick('t:1'), undefined)).toBe('This changed no files.');
    expect(emptyDiffMessage(pick('t:1', 'u'), undefined)).toBe('Nothing changed in this span.');
    expect(emptyDiffMessage(pick('t:1'), undefined, 'Since you looked')).toBe('Nothing changed since you last looked.');
  });
});
