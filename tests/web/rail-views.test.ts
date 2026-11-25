// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionSummary } from '../../src/web/src/api/client.js';
import type { RailLayout } from '../../src/core/rail/rail-layout.js';
import { OLDER_GROUP, railGroups } from '../../src/web/src/state/session-display.js';
import {
  groupsForView,
  projectGroups,
  projectOfGroup,
  RAIL_VIEWS,
  readRailView,
  stateGroupOf,
  stateGroups,
  writeRailView,
  type StateGroup,
} from '../../src/web/src/state/rail-views.js';

const NOW = Date.parse('2026-11-25T12:00:00Z');
const ago = (min: number) => new Date(NOW - min * 60_000).toISOString();
const OLD = ago(60 * 24 * 30);
const session = (id: string, extra: Partial<SessionSummary> = {}): SessionSummary =>
  ({
    id,
    target: 'api',
    branch: `feat/${id}`,
    isGroup: false,
    paths: [`/wt/${id}`],
    createdAt: ago(600),
    lastAccessedAt: ago(90),
    draftCount: 0,
    commentCount: 0,
    claudeCount: 0,
    ptyStatus: 'idle',
    lastActivity: null,
    activityState: 'stale',
    pendingForClaudeCount: 0,
    attention: null,
    diffStat: null,
    archivedAt: null,
    port: null,
    ...extra,
  }) as SessionSummary;
const attention = (state: 'needs_input' | 'working' | 'idle', extra: object = {}) =>
  ({ state, seen: true, since: ago(5), updatedAt: ago(5), stale: false, ...extra }) as SessionSummary['attention'];
const stage = (kind: string) => ({ kind, text: `PR #1 · ${kind}`, key: 'k' }) as SessionSummary['prStage'];
const NO_LAYOUT: RailLayout = { sections: [], places: {} };
const keys = (groups: Array<{ key: string; sessions: SessionSummary[] }>) =>
  groups.map((g) => `${g.key}: ${g.sessions.map((s) => s.id).join(' ')}`);

describe('stateGroupOf: which State heading a session is under', () => {
  const cases: Array<[string, Partial<SessionSummary>, StateGroup]> = [
    ['its agent asks for input', { attention: attention('needs_input') }, 'needs'],
    ['a finished turn you have not looked at', { attention: attention('idle', { seen: false }) }, 'needs'],
    ['replies to post', { replyDrafts: 2 }, 'needs'],
    ['a PR ready to merge', { prStage: stage('ready') }, 'needs'],
    ['failing CI', { prStage: stage('checks_failing') }, 'needs'],
    ['working', { attention: attention('working') }, 'working'],
    ['in background', { attention: attention('working', { background: { what: 'npm test' } }) }, 'working'],
    ['active, no hooks yet', { activityState: 'active' }, 'working'],
    ['archiving', { archiving: true }, 'working'],
    ['restoring', { restoring: true }, 'working'],
    ['idle, seen', { attention: attention('idle') }, 'idle'],
    ['asleep', { asleep: true }, 'idle'],
    ['open, no hooks yet', { activityState: 'open' }, 'idle'],
    ['stale', { lastAccessedAt: ago(60 * 48) }, 'idle'],
    ['in review: its PR waits on others', { prStage: stage('in_review') }, 'idle'],
    ['snoozed', { snoozed: { until: null } }, 'snoozed'],
  ];
  it.each(cases)('%s', (_what, extra, group) => {
    expect(stateGroupOf(session('s', extra))).toBe(group);
  });

  it('snoozed wins over what it owes you or asks', () => {
    expect(stateGroupOf(session('s', { snoozed: { until: ago(-60) }, replyDrafts: 1 }))).toBe('snoozed');
    expect(stateGroupOf(session('s', { snoozed: { until: null }, attention: attention('needs_input') }))).toBe('snoozed');
    expect(stateGroupOf(session('s', { snoozed: { until: null }, attention: attention('working') }))).toBe('snoozed');
  });

  it('what you owe wins over its agent working', () => {
    expect(stateGroupOf(session('s', { attention: attention('working'), replyDrafts: 1 }))).toBe('needs');
  });
});

describe('stateGroups', () => {
  const SESSIONS = [
    session('idle1'),
    session('work1', { attention: attention('working') }),
    session('needs1', { attention: attention('needs_input') }),
    session('idle2', { asleep: true }),
    session('snz', { snoozed: { until: null }, replyDrafts: 3 }),
    session('needs2', { replyDrafts: 1 }),
    session('old1', { lastAccessedAt: OLD }),
    session('old2', { lastAccessedAt: OLD }),
  ];

  it('Needs you, Working, Idle, Snoozed, then Older; every session exactly once, in its group', () => {
    const { groups } = stateGroups(SESSIONS, { now: NOW });
    expect(groups.map((g) => g.title)).toEqual(['Needs you', 'Working', 'Idle', 'Snoozed', 'Older']);
    expect(keys(groups)).toEqual([
      'state:needs: needs1 needs2',
      'state:working: work1',
      'state:idle: idle1 idle2',
      'state:snoozed: snz',
      `${OLDER_GROUP}: old1 old2`,
    ]);
    const ids = groups.flatMap((g) => g.sessions.map((s) => s.id));
    expect(ids.sort()).toEqual(SESSIONS.map((s) => s.id).sort());
  });

  it('a heading with no sessions is left out, Older too', () => {
    const { groups } = stateGroups([session('a'), session('b', { attention: attention('working') })], { now: NOW });
    expect(groups.map((g) => g.key)).toEqual(['state:working', 'state:idle']);
  });

  it('inside a group the order is Mine’s: your drag order, unplaced first', () => {
    const order = ['idle2', 'needs2', 'idle1', 'needs1'];
    const mine = railGroups(SESSIONS, { now: NOW, order, layout: NO_LAYOUT }).groups.flatMap((g) => g.sessions.map((s) => s.id));
    const { groups } = stateGroups(SESSIONS, { now: NOW, order });
    for (const g of groups) {
      const ids = g.sessions.map((s) => s.id);
      expect(ids).toEqual(mine.filter((id) => ids.includes(id)));
    }
    expect(keys(groups).slice(0, 3)).toEqual(['state:needs: needs2 needs1', 'state:working: work1', 'state:idle: idle2 idle1']);
  });

  it('the selected older session stays in its State group; pins do not keep one out of Older', () => {
    const more = [...SESSIONS, session('old3', { lastAccessedAt: OLD, replyDrafts: 1 })];
    const { groups } = stateGroups(more, { now: NOW, activeId: 'old3' });
    expect(keys(groups)).toContain('state:needs: needs1 needs2 old3');
    expect(groups.at(-1)).toMatchObject({ key: OLDER_GROUP, title: 'Older' });
    expect(groups.at(-1)!.sessions.map((s) => s.id)).toEqual(['old1', 'old2']);
    // A pinned older one is Older here: pins group nothing in State.
    const pinned: RailLayout = { sections: [], places: { old1: { pinned: true } } };
    const viaView = groupsForView('state', SESSIONS, { now: NOW, layout: pinned }).groups;
    expect(viaView.at(-1)!.sessions.map((s) => s.id)).toEqual(['old1', 'old2']);
  });

  it('an older session that needs you is under Needs you, not folded away in Older; a snoozed older one stays in Older', () => {
    const more = [
      ...SESSIONS,
      session('oldOwed', { lastAccessedAt: OLD, replyDrafts: 1 }),
      session('oldSnoozed', { lastAccessedAt: OLD, replyDrafts: 1, snoozed: { until: null } }),
    ];
    const { groups } = stateGroups(more, { now: NOW });
    expect(groups.find((g) => g.key === 'state:needs')!.sessions.map((s) => s.id)).toContain('oldOwed');
    expect(groups.at(-1)!.sessions.map((s) => s.id)).toEqual(['old1', 'old2', 'oldSnoozed']);
  });

  it('only older sessions: Older alone', () => {
    expect(stateGroups([session('o', { lastAccessedAt: OLD })], { now: NOW }).groups.map((g) => g.key)).toEqual([OLDER_GROUP]);
  });

  it('groupsForView: Mine is railGroups, as it was', () => {
    const layout: RailLayout = { sections: [{ id: 'x', name: 'Client X' }], places: { idle1: { section: 'x' } } };
    expect(groupsForView('mine', SESSIONS, { now: NOW, layout })).toEqual(railGroups(SESSIONS, { now: NOW, layout }));
  });
});

describe('projectGroups', () => {
  const SESSIONS = [
    session('w1', { target: 'web' }),
    session('a1'),
    session('s1', { target: 'Shop' }),
    session('g1', { target: 'checkout', isGroup: true }),
    session('a2', { attention: attention('working') }),
    session('old1', { lastAccessedAt: OLD }),
    session('oldweb', { target: 'web', lastAccessedAt: OLD }),
  ];

  it('one heading per project in alphabetical order whatever the case, a group under its own name, then Older; each session once', () => {
    const { groups } = projectGroups(SESSIONS, { now: NOW });
    expect(groups.map((g) => g.title)).toEqual(['api', 'checkout', 'Shop', 'web', 'Older']);
    expect(keys(groups)).toEqual([
      'project:api: a1 a2',
      'project:checkout: g1',
      'project:Shop: s1',
      'project:web: w1',
      `${OLDER_GROUP}: old1 oldweb`,
    ]);
    const ids = groups.flatMap((g) => g.sessions.map((s) => s.id));
    expect(ids.sort()).toEqual(SESSIONS.map((s) => s.id).sort());
  });

  it('inside a project the order is Mine’s', () => {
    const { groups } = projectGroups(SESSIONS, { now: NOW, order: ['a2', 'a1'] });
    expect(keys(groups)[0]).toBe('project:api: a2 a1');
  });

  it('the selected older session and one that needs you stay under their project', () => {
    const sessions = [...SESSIONS, session('oldowed', { target: 'docs', lastAccessedAt: OLD, replyDrafts: 1 })];
    const { groups } = projectGroups(sessions, { now: NOW, activeId: 'oldweb' });
    expect(keys(groups)).toContain('project:web: w1 oldweb');
    expect(keys(groups)).toContain('project:docs: oldowed');
    expect(keys(groups).at(-1)).toBe(`${OLDER_GROUP}: old1`);
  });

  it('a project with only old sessions has no heading', () => {
    const { groups } = projectGroups([session('a1'), session('o', { target: 'gone', lastAccessedAt: OLD })], { now: NOW });
    expect(groups.map((g) => g.title)).toEqual(['api', 'Older']);
  });

  it('projectOfGroup: the project of a Project heading, null for any other', () => {
    expect(projectOfGroup('project:api')).toBe('api');
    expect(projectOfGroup('project:a:b')).toBe('a:b');
    expect(projectOfGroup(OLDER_GROUP)).toBeNull();
    expect(projectOfGroup('state:needs')).toBeNull();
  });

  it('groupsForView: Project is projectGroups', () => {
    const opts = { now: NOW, layout: { sections: [], places: {} } };
    expect(keys(groupsForView('project', SESSIONS, opts).groups)).toEqual(keys(projectGroups(SESSIONS, opts).groups));
  });
});

describe('the stored view', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
  });

  it('the switch has Mine, State, then Project', () => {
    expect(RAIL_VIEWS.map((v) => v.label)).toEqual(['Mine', 'State', 'Project']);
  });

  it('Project is remembered too', () => {
    writeRailView('project');
    expect(readRailView()).toBe('project');
  });

  it('Mine at first; what you chose after', () => {
    expect(readRailView()).toBe('mine');
    writeRailView('state');
    expect(localStorage.getItem('work-web:rail-view')).toBe('state');
    expect(readRailView()).toBe('state');
    writeRailView('mine');
    expect(readRailView()).toBe('mine');
  });

  it('a stored value it does not know is Mine', () => {
    localStorage.setItem('work-web:rail-view', 'kanban');
    expect(readRailView()).toBe('mine');
    localStorage.setItem('work-web:rail-view', '"state"');
    expect(readRailView()).toBe('mine');
  });

  it('storage that throws: Mine, and writing does not throw', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    expect(readRailView()).toBe('mine');
    expect(() => writeRailView('state')).not.toThrow();
  });
});
