import { describe, expect, it, vi } from 'vitest';
import type { DevServerState, SessionSummary } from '../../src/web/src/api/client.js';
import { contextFooter, sessionHeaderItems, type HeaderMenuActions } from '../../src/web/src/state/session-header-menu.js';
import { prNeedsLine } from '../../src/web/src/state/pr-tab.js';

const session = (over: Partial<SessionSummary> = {}) => ({ id: 's1', target: 'api', branch: 'feat/x', ...over }) as SessionSummary;
const actions = (): HeaderMenuActions => ({
  openTerminal: vi.fn(),
  reconnectTerminal: vi.fn(),
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
  it('Reconnect terminal (⇧R) comes first, beside Open in terminal; an archived session has neither', () => {
    const a = actions();
    const items = sessionHeaderItems(session(), null, a);
    expect(items.slice(0, 2).map((i) => i.label + ' ' + i.hint)).toEqual(['Reconnect terminal ⇧R', 'Open in terminal ⇧T']);
    items[0].run();
    expect(a.reconnectTerminal).toHaveBeenCalled();
    expect(labels(session({ archivedAt: '2026-10-01T00:00:00Z' }), null).some((l) => l.startsWith('Reconnect'))).toBe(false);
  });

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

describe('Needs you (the header line, from the session row: no fetch)', () => {
  const pr = (repo: string, number: number, kind: string) => ({ repo, number, url: `u${number}`, kind });
  it("says what waits on GitHub: open threads, drafts to post, a PR's failing checks or conflict", () => {
    expect(
      prNeedsLine({
        openReviewThreads: 6,
        replyDrafts: 2,
        prStage: {
          kind: 'checks_failing',
          text: '',
          key: '',
          prs: [pr('frontend', 1927, 'checks_failing'), pr('backend', 3509, 'in_review')],
        },
        isGroup: true,
      } as never),
    ).toBe('6 open review threads · 2 replies to post · frontend #1927 checks failing');
    expect(
      prNeedsLine({ openReviewThreads: 1, prStage: { kind: 'conflict', text: '', key: '', prs: [pr('api', 7, 'conflict')] } } as never),
    ).toBe('1 open review thread · #7 merge conflict');
  });

  it("a draft's failing checks count too: its stage says draft, its checks say failing", () => {
    expect(
      prNeedsLine({ prStage: { kind: 'draft', text: '', key: '', prs: [{ ...pr('api', 7, 'draft'), checks: 'fail' }] } } as never),
    ).toBe('#7 checks failing');
    // …not a merged one's.
    expect(
      prNeedsLine({ prStage: { kind: 'merged', text: '', key: '', prs: [{ ...pr('api', 7, 'merged'), checks: 'fail' }] } } as never),
    ).toBeNull();
  });

  it('nothing waiting (a PR in review, checks running): nothing', () => {
    expect(prNeedsLine({ prStage: { kind: 'in_review', text: '', key: '', prs: [pr('api', 7, 'in_review')] } } as never)).toBeNull();
    expect(prNeedsLine({})).toBeNull();
  });
});
