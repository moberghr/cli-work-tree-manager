import { describe, expect, it } from 'vitest';
import { jiraAsIssue, jiraSource, issueSources } from '../../../src/core/issues/jira-source.js';
import {
  listIssues,
  placeBySource,
  placedIssue,
  sessionIssue,
  type Issue,
  type IssueSource,
  issueId,
  parseIssue,
  splitIssueId,
} from '../../../src/core/issues/issue-source.js';
import { ISSUE_SOURCES } from '../../../src/core/issues/issue-place.js';

/** Where issues come from: a connector per system behind one contract; Jira is the first. */
const issue = (key: string, over: Partial<{ status: string; statusCategory: 'new' | 'indeterminate' | 'done' }> = {}) => ({
  key,
  summary: `Summary of ${key}`,
  status: over.status ?? 'To Do',
  ...(over.statusCategory ? { statusCategory: over.statusCategory } : {}),
  issuetype: 'Story',
  priority: 'High',
  url: `https://jira.example/browse/${key}`,
});
const cfg = {
  repos: { api: '/r/api', web: '/r/web' },
  groups: { shop: ['api', 'web'] },
  issues: { rules: ['jira:PAY -> api', 'jira:SHOP/checkout -> shop'] },
};

describe('a session’s issue', () => {
  it('is its key and the system it is a key of; a session from before there were others: Jira’s; none: none', () => {
    expect(sessionIssue({ issueKey: 'acme/web#12', issueSource: 'github' })).toEqual({ source: 'github', key: 'acme/web#12' });
    expect(sessionIssue({ issueKey: 'PAY-12' })).toEqual({ source: 'jira', key: 'PAY-12' });
    expect(sessionIssue({ issueKey: 'PAY-12', issueSource: '' })).toEqual({ source: 'jira', key: 'PAY-12' });
    // A system with no key is no issue.
    expect(sessionIssue({ issueSource: 'github' })).toBeNull();
    expect(sessionIssue({})).toBeNull();
  });

  it('work’s own key for an issue is one text, the same for every connector, and reads back', () => {
    const sources = [
      { id: 'jira', isKey: (t: string) => /^[A-Z][A-Z0-9_]*-\d+$/.test(t) },
      { id: 'github', isKey: (t: string) => /^[^/\s]+\/[^/\s]+#\d+$/.test(t) },
    ];
    expect(issueId({ source: 'jira', key: 'PAY-12' })).toBe('jira:PAY-12');
    expect(issueId({ source: 'github', key: 'acme/web#12' })).toBe('github:acme/web#12');
    expect(parseIssue('github:acme/web#12', sources)).toEqual({ source: 'github', key: 'acme/web#12' });
    expect(parseIssue(' JIRA:PAY-12 ', sources)).toEqual({ source: 'jira', key: 'PAY-12' });
    // A bare key is the connector's that knows its shape; one nobody knows is taken as the default's.
    expect(parseIssue('PAY-12', sources)).toEqual({ source: 'jira', key: 'PAY-12' });
    expect(parseIssue('acme/web#12', sources)).toEqual({ source: 'github', key: 'acme/web#12' });
    expect(parseIssue('whatever', sources)).toEqual({ source: 'jira', key: 'whatever' });
    // A word before a colon that is no connector is part of the key.
    expect(parseIssue('trello:abc', sources)).toEqual({ source: 'jira', key: 'trello:abc' });
    expect(parseIssue('  ', sources)).toBeNull();
    expect(parseIssue(undefined, sources)).toBeNull();
  });

  it('splitIssueId needs no connector at hand: a known system before a colon, else a key alone', () => {
    expect(splitIssueId('github:acme/web#12')).toEqual({ source: 'github', key: 'acme/web#12' });
    expect(splitIssueId('Azure: AB#7')).toEqual({ source: 'azure', key: 'AB#7' });
    expect(splitIssueId('PAY-12')).toEqual({ key: 'PAY-12' });
    expect(splitIssueId('trello:abc')).toEqual({ key: 'trello:abc' });
    expect(splitIssueId('jira:')).toEqual({ key: 'jira:' });
  });
});

describe('Jira behind the contract', () => {
  const source = jiraSource({
    pane: async () => ({ available: true, issues: [issue('PAY-12', { statusCategory: 'indeterminate' }), issue('SHOP-4')] }),
    all: async () => [issue('PAY-12'), issue('SHOP-4'), issue('OPS-9')],
    detail: async (key) =>
      key === 'SHOP-4'
        ? {
            project: { key: 'SHOP', name: 'Shop' },
            components: ['checkout'],
            labels: ['urgent'],
            description: 'Two steps',
            created: '2026-11-01',
          }
        : null,
  });

  it('an issue is an issue with where it is from; nothing of it is lost', () => {
    expect(jiraAsIssue(issue('PAY-12', { statusCategory: 'new' }))).toEqual({
      source: 'jira',
      ...issue('PAY-12', { statusCategory: 'new' }),
    });
    expect('statusCategory' in jiraAsIssue(issue('PAY-12'))).toBe(false);
  });

  it('your issues, all of them when asked, and one’s detail: the project its scope, components and labels what narrow it', async () => {
    expect(await source.mine()).toEqual({
      available: true,
      issues: [
        { source: 'jira', ...issue('PAY-12', { statusCategory: 'indeterminate' }) },
        { source: 'jira', ...issue('SHOP-4') },
      ],
    });
    expect((await source.mineOrThrow()).map((t) => t.key)).toEqual(['PAY-12', 'SHOP-4', 'OPS-9']);
    expect(await source.detail('SHOP-4')).toEqual({
      scope: { key: 'SHOP', name: 'Shop' },
      facets: ['checkout', 'urgent'],
      description: 'Two steps',
      created: '2026-11-01',
    });
    expect(await source.detail('PAY-12')).toBeNull();
  });

  it('its keys, their scope, the branch and the first message of a session started from one', () => {
    expect(source.isKey('PAY-12')).toBe(true);
    expect(source.isKey('acme/web#12')).toBe(false);
    expect(source.scopeOf('PAY-12')).toBe('PAY');
    expect(source.scopeOf('not a key')).toBeNull();
    expect(source.branchFor({ source: 'jira', key: 'PAY-12' })).toBe('feat/PAY-12');
    const t = { source: 'jira', ...issue('PAY-12') };
    expect(source.prompt(t)).toContain('Work on PAY-12: Summary of PAY-12');
    expect(source.prompt(t, { automatic: true })).toContain('started automatically');
  });

  it('is the one connector there is, and a rule can name it', () => {
    expect(issueSources().map((s) => s.id)).toEqual(['jira']);
    for (const s of issueSources()) expect(ISSUE_SOURCES as readonly string[]).toContain(s.id);
  });

  it('an issue under your rules: its scope from its key, or from its detail when that is read', () => {
    expect(placedIssue(source, 'PAY-12')).toEqual({ source: 'jira', scope: 'PAY' });
    expect(placedIssue(source, 'X', { scope: { key: 'SHOP', name: 'Shop' }, facets: ['checkout'] })).toEqual({
      source: 'jira',
      scope: 'SHOP',
      facets: ['checkout'],
    });
    // A key that says no scope, and no detail: it can't be placed.
    expect(placedIssue(source, 'not a key')).toBeNull();
    expect(placeBySource(source, 'PAY-12', undefined, cfg)).toEqual({
      target: 'api',
      reason: 'your issue rule: jira:PAY -> api',
      auto: false,
    });
    expect(placeBySource(source, 'not a key', undefined, cfg)).toBeNull();
    expect(placeBySource(source, 'PAY-12', undefined, null)).toBeNull();
  });
});

describe('listIssues', () => {
  const fake = (id: string, name: string, mine: IssueSource['mine']): IssueSource => ({
    id,
    name,
    mine,
    mineOrThrow: async () => (await mine()).issues,
    detail: async () => null,
    scopeOf: (key) => key.split('-')[0] || null,
    isKey: () => true,
    branchFor: (t) => `feat/${t.key}`,
    prompt: (t) => t.summary,
  });
  const row = (source: string, key: string): Issue => ({ source, ...issue(key) });

  it('every connector’s issues in one list, each marked with the project your rules start it in', async () => {
    const r = await listIssues(
      [fake('jira', 'Jira', async () => ({ available: true, issues: [row('jira', 'PAY-12'), row('jira', 'OPS-1')] }))],
      cfg,
    );
    expect(r.sources).toEqual([{ id: 'jira', name: 'Jira', available: true }]);
    expect(r.issues.map((t) => [t.key, t.startsIn])).toEqual([
      ['PAY-12', 'api'],
      ['OPS-1', undefined],
    ]);
  });

  it('a connector that can’t be asked, or throws, is said; the others are still listed', async () => {
    const r = await listIssues(
      [
        fake('jira', 'Jira', async () => ({ available: false, issues: [] })),
        fake('github', 'GitHub', async () => {
          throw new Error('gh is not signed in');
        }),
        fake('azure', 'Azure DevOps', async () => ({ available: true, issues: [row('azure', 'AB-7')] })),
      ],
      null,
    );
    expect(r.sources).toEqual([
      { id: 'jira', name: 'Jira', available: false },
      { id: 'github', name: 'GitHub', available: false, error: 'gh is not signed in' },
      { id: 'azure', name: 'Azure DevOps', available: true },
    ]);
    expect(r.issues.map((t) => t.key)).toEqual(['AB-7']);
    expect(await listIssues([], cfg)).toEqual({ sources: [], issues: [] });
  });
});
