import { describe, it, expect } from 'vitest';
import { DEFAULT_ROUTE, LAST_ROUTE_KEY, initialHash, parseHash, saveLastRoute, toHash } from '../../src/web/src/state/dashboard-route.js';

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
      sessionSubTab: 'term',
    });
    expect(parseHash('#/start')).toMatchObject({ tab: 'start', sessionId: null });
    // PRs and Jira are both on Start now: old links land there.
    expect(parseHash('#/prs')).toMatchObject({ tab: 'start', sessionId: null });
    expect(parseHash('#/jira')).toMatchObject({ tab: 'start' });
    expect(parseHash('#/today')).toMatchObject({ tab: 'today' });
    expect(parseHash('#/repos')).toMatchObject({ tab: 'repos', sessionId: null });
    // Tasks is a panel in the top bar now: an old link lands on Sessions.
    expect(parseHash('#/tasks')).toMatchObject({ tab: 'sessions', sessionId: null });
  });

  it('tolerates a trailing slash on tab hashes', () => {
    expect(parseHash('#/start/')).toMatchObject({ tab: 'start' });
  });

  it('parses session URLs with default sub-tab', () => {
    expect(parseHash('#/s/abc-123')).toEqual({
      tab: 'sessions',
      sessionId: 'abc-123',
      sessionSubTab: 'term',
    });
  });

  it('parses session URLs with an explicit sub-tab', () => {
    expect(parseHash('#/s/abc/term')).toMatchObject({
      sessionId: 'abc',
      sessionSubTab: 'term',
    });
    expect(parseHash('#/s/abc/timeline')).toMatchObject({
      sessionId: 'abc',
      sessionSubTab: 'timeline',
    });
  });

  it('old links land where that tab went: comments on the Diff, chat on the Terminal', () => {
    expect(parseHash('#/s/abc/comments')).toMatchObject({ sessionId: 'abc', sessionSubTab: 'diff' });
    expect(parseHash('#/s/abc/chat')).toMatchObject({ sessionId: 'abc', sessionSubTab: 'term' });
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
    expect(toHash({ tab: 'sessions', sessionId: null, sessionSubTab: 'diff' })).toBe('#/sessions');
    expect(toHash({ tab: 'start', sessionId: null, sessionSubTab: 'diff' })).toBe('#/start');
  });

  it('serialises session routes with the sub-tab', () => {
    expect(toHash({ tab: 'sessions', sessionId: 'abc', sessionSubTab: 'diff' })).toBe('#/s/abc/diff');
    expect(toHash({ tab: 'start', sessionId: 'abc', sessionSubTab: 'term' })).toBe('#/s/abc/term');
  });

  it('URL-encodes the session id', () => {
    expect(toHash({ tab: 'sessions', sessionId: 'foo bar', sessionSubTab: 'diff' })).toBe('#/s/foo%20bar/diff');
  });

  it('round-trips through parseHash for every variant', () => {
    const cases = [
      { tab: 'sessions' as const, sessionId: null, sessionSubTab: 'term' as const },
      { tab: 'start' as const, sessionId: null, sessionSubTab: 'term' as const },
      { tab: 'today' as const, sessionId: null, sessionSubTab: 'term' as const },
      { tab: 'sessions' as const, sessionId: 'xyz', sessionSubTab: 'diff' as const },
      { tab: 'sessions' as const, sessionId: 'xyz', sessionSubTab: 'term' as const },
      { tab: 'sessions' as const, sessionId: 'xyz', sessionSubTab: 'timeline' as const },
    ];
    for (const route of cases) {
      expect(parseHash(toHash(route))).toEqual(route);
    }
  });
});

describe('last-route resume', () => {
  const store = (initial: Record<string, string> = {}) => {
    const m = new Map(Object.entries(initial));
    return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), m };
  };

  it('resumes the saved route when the URL has no hash', () => {
    const s = store({ [LAST_ROUTE_KEY]: '#/s/abc/term' });
    expect(initialHash('', s)).toBe('#/s/abc/term');
    expect(initialHash('#', s)).toBe('#/s/abc/term');
    expect(initialHash('#/', s)).toBe('#/s/abc/term');
  });

  it('never overrides an explicit hash', () => {
    const s = store({ [LAST_ROUTE_KEY]: '#/s/abc/term' });
    expect(initialHash('#/start', s)).toBe('#/start');
  });

  it('ignores garbage or default saved values, missing and throwing storage', () => {
    expect(initialHash('', store({ [LAST_ROUTE_KEY]: 'nonsense' }))).toBe('');
    expect(initialHash('', store())).toBe('');
    expect(initialHash('', null)).toBe('');
    const throwing = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
    };
    expect(initialHash('', throwing)).toBe('');
    expect(() => saveLastRoute(DEFAULT_ROUTE, throwing)).not.toThrow();
  });

  it('round-trips through saveLastRoute', () => {
    const s = store();
    saveLastRoute({ tab: 'sessions', sessionId: 'x y', sessionSubTab: 'diff' }, s);
    expect(parseHash(initialHash('', s))).toEqual({ tab: 'sessions', sessionId: 'x y', sessionSubTab: 'diff' });
  });
});
