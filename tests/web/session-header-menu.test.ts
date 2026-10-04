import { describe, expect, it, vi } from 'vitest';
import type { DevServerState, SessionCi, SessionSummary } from '../../src/web/src/api/client.js';
import { contextFooter, sessionHeaderItems, type HeaderMenuActions } from '../../src/web/src/state/session-header-menu.js';
import { needsYouText } from '../../src/web/src/components/Dashboard/NeedsYouBar.js';
import { ciNeeds } from '../../src/web/src/components/Dashboard/CiStrip.js';
import { replyNeeds } from '../../src/web/src/components/Dashboard/ReplyDrafts.js';

const session = (over: Partial<SessionSummary> = {}) => ({ id: 's1', target: 'api', branch: 'feat/x', ...over }) as SessionSummary;
const actions = (): HeaderMenuActions => ({
  openTerminal: vi.fn(),
  ship: vi.fn(),
  catchUp: vi.fn(),
  sendPrompt: vi.fn(),
  notes: vi.fn(),
  devStart: vi.fn(),
  devStop: vi.fn(),
  rename: vi.fn(),
  remove: vi.fn(),
});
const dev = (over: Partial<DevServerState> = {}): DevServerState => ({
  port: 3028,
  listening: false,
  url: null,
  command: 'npm run dev',
  repo: 'api',
  running: null,
  ...over,
});
const labels = (s: SessionSummary, d: DevServerState | null) => sessionHeaderItems(s, d, actions()).map((i) => i.label + (i.hint ?? ''));

describe('session header ⋯ menu', () => {
  it('a running dev server is stopped from it; one with no command and nothing running is left out', () => {
    expect(labels(session(), dev({ running: { pid: 1, startedAt: '' } }))).toContain('Stop dev server:3028 · ⇧D');
    expect(labels(session(), dev({ command: null })).some((l) => l.includes('dev server'))).toBe(false);
    expect(labels(session(), dev({ port: null })).some((l) => l.includes('dev server'))).toBe(false);
    expect(labels(session(), null).some((l) => l.includes('dev server'))).toBe(false);
  });

  it('Notes says when there is one; Delete is red, Rename starts the group', () => {
    const items = sessionHeaderItems(session({ hasNote: true }), null, actions());
    expect(items.find((i) => i.label.startsWith('Notes'))!.label).toBe('Notes •');
    expect(items.find((i) => i.label === 'Delete…')!.danger).toBe(true);
    expect(items.find((i) => i.label === 'Rename')!.separated).toBe(true);
  });

  it('each item runs its own action', () => {
    const a = actions();
    for (const i of sessionHeaderItems(session(), dev(), a)) i.run();
    for (const fn of Object.values(a).filter((f) => f !== a.devStop)) expect(fn).toHaveBeenCalledTimes(1);
    expect(a.devStop).not.toHaveBeenCalled();
  });

  it('footer: how full the conversation is, when known', () => {
    expect(contextFooter(session({ context: { used: 168_400, window: 200_000 } } as Partial<SessionSummary>))).toBe(
      'Context 84% · 168k of 200k tokens',
    );
    expect(contextFooter(session())).toBeUndefined();
  });
});

describe('Needs you', () => {
  it('joins what each panel says, and is nothing when none says anything', () => {
    expect(needsYouText(['1 reply to post', null, 'CI failing on #212'])).toBe('1 reply to post · CI failing on #212');
    expect(needsYouText([null, undefined])).toBeNull();
  });

  it('replies: drafts to post, threads with no reply', () => {
    expect(replyNeeds(1, 0)).toBe('1 reply to post');
    expect(replyNeeds(2, 1)).toBe('2 replies to post · 1 thread with no reply');
    expect(replyNeeds(0, 3)).toBe('3 threads with no reply');
    expect(replyNeeds(0, 0)).toBeNull();
  });

  it('CI: only failing checks on open PRs need you (running, merged or green ones do not)', () => {
    const ci = (repos: unknown[]) => ({ repos }) as unknown as SessionCi;
    const repo = (name: string, number: number, checks: string, state = 'OPEN') => ({ name, pr: { number, checks, state, url: '' } });
    expect(ciNeeds(ci([repo('api', 212, 'fail'), repo('web', 40, 'pending')]), false)).toBe('CI failing on #212');
    expect(ciNeeds(ci([repo('api', 212, 'fail'), repo('web', 40, 'fail')]), true)).toBe('CI failing on #212 api, #40 web');
    expect(ciNeeds(ci([repo('api', 212, 'fail', 'MERGED'), repo('web', 40, 'pass')]), true)).toBeNull();
    expect(ciNeeds(null, false)).toBeNull();
  });
});
