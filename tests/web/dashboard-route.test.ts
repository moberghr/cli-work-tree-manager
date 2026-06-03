import { describe, it, expect } from 'vitest';
import {
  DEFAULT_ROUTE,
  parseHash,
  toHash,
} from '../../src/web/src/state/dashboard-route.js';

describe('parseHash', () => {
  it('returns the default route for empty / "#" / "#/"', () => {
    expect(parseHash('')).toEqual(DEFAULT_ROUTE);
    expect(parseHash('#')).toEqual(DEFAULT_ROUTE);
    expect(parseHash('#/')).toEqual(DEFAULT_ROUTE);
  });

  it('parses tab hashes', () => {
    expect(parseHash('#/sessions')).toEqual({
      tab: 'sessions',
      sessionId: null,
      sessionSubTab: 'diff',
    });
    expect(parseHash('#/prs')).toMatchObject({ tab: 'prs', sessionId: null });
    expect(parseHash('#/jira')).toMatchObject({ tab: 'jira' });
    expect(parseHash('#/tasks')).toMatchObject({ tab: 'tasks' });
  });

  it('tolerates a trailing slash on tab hashes', () => {
    expect(parseHash('#/prs/')).toMatchObject({ tab: 'prs' });
  });

  it('parses session URLs with default sub-tab', () => {
    expect(parseHash('#/s/abc-123')).toEqual({
      tab: 'sessions',
      sessionId: 'abc-123',
      sessionSubTab: 'diff',
    });
  });

  it('parses session URLs with an explicit sub-tab', () => {
    expect(parseHash('#/s/abc/term')).toMatchObject({
      sessionId: 'abc',
      sessionSubTab: 'term',
    });
    expect(parseHash('#/s/abc/comments')).toMatchObject({
      sessionId: 'abc',
      sessionSubTab: 'comments',
    });
  });

  it('URL-decodes the session id (worktrees can have slashy ids elsewhere)', () => {
    expect(parseHash('#/s/foo%20bar')).toMatchObject({
      sessionId: 'foo bar',
    });
  });

  it('falls back to default for unrecognised hashes (no silent misroute)', () => {
    expect(parseHash('#/garbage')).toEqual(DEFAULT_ROUTE);
    expect(parseHash('#/sessions/extra/junk')).toEqual(DEFAULT_ROUTE);
  });
});

describe('toHash', () => {
  it('serialises tab routes', () => {
    expect(toHash({ tab: 'sessions', sessionId: null, sessionSubTab: 'diff' }))
      .toBe('#/sessions');
    expect(toHash({ tab: 'prs', sessionId: null, sessionSubTab: 'diff' }))
      .toBe('#/prs');
  });

  it('serialises session routes with the sub-tab', () => {
    expect(toHash({ tab: 'sessions', sessionId: 'abc', sessionSubTab: 'diff' }))
      .toBe('#/s/abc/diff');
    expect(toHash({ tab: 'prs', sessionId: 'abc', sessionSubTab: 'term' }))
      .toBe('#/s/abc/term');
  });

  it('URL-encodes the session id', () => {
    expect(toHash({ tab: 'sessions', sessionId: 'foo bar', sessionSubTab: 'diff' }))
      .toBe('#/s/foo%20bar/diff');
  });

  it('round-trips through parseHash for every variant', () => {
    const cases = [
      { tab: 'sessions' as const, sessionId: null, sessionSubTab: 'diff' as const },
      { tab: 'prs' as const, sessionId: null, sessionSubTab: 'diff' as const },
      { tab: 'jira' as const, sessionId: null, sessionSubTab: 'diff' as const },
      { tab: 'tasks' as const, sessionId: null, sessionSubTab: 'diff' as const },
      { tab: 'sessions' as const, sessionId: 'xyz', sessionSubTab: 'diff' as const },
      { tab: 'sessions' as const, sessionId: 'xyz', sessionSubTab: 'term' as const },
      { tab: 'sessions' as const, sessionId: 'xyz', sessionSubTab: 'comments' as const },
    ];
    for (const route of cases) {
      expect(parseHash(toHash(route))).toEqual(route);
    }
  });
});
