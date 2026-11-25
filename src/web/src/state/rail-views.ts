import type { SessionSummary } from '../api/client.js';
import type { RailGroup, RailLayout } from '../../../core/rail/rail-layout.js';
import { displayStatus, OLDER_GROUP, owedBadge, railGroups, railSessions, type DisplayKind } from './session-display.js';

/**
 * How the rail groups its rows: `mine` is yours (pins, sections, your drag order); `state` is by what each session
 * needs now (Needs you, Working, Idle, Snoozed, then Older); `project` is by project, one heading each, then Older.
 * Mine and State draw the same two-line rows; Project's are one line, since the heading says the project. Pure.
 */
export type RailView = 'mine' | 'state' | 'project';

/** The rail header's switch, in its order. */
export const RAIL_VIEWS: ReadonlyArray<{ value: RailView; label: string; title: string }> = [
  { value: 'mine', label: 'Mine', title: 'Your order: pins, sections, where you dragged them' },
  { value: 'state', label: 'State', title: 'By what each needs now: Needs you, Working, Idle, Snoozed' },
  { value: 'project', label: 'Project', title: 'By project: one heading each, with a + to start another worktree there' },
];

const VIEW_KEY = 'work-web:rail-view';

/** The view this browser last showed (a view preference, like the fold state): Mine at first or when unreadable. */
export function readRailView(): RailView {
  try {
    const v = localStorage.getItem(VIEW_KEY);
    return RAIL_VIEWS.find((x) => x.value === v)?.value ?? 'mine';
  } catch {
    return 'mine';
  }
}

export function writeRailView(view: RailView): void {
  try {
    localStorage.setItem(VIEW_KEY, view);
  } catch {
    /* storage blocked: it just won't be remembered */
  }
}

/** A State heading. */
export type StateGroup = 'needs' | 'working' | 'idle' | 'snoozed';

const STATE_ORDER: readonly StateGroup[] = ['needs', 'working', 'idle', 'snoozed'];
const STATE_TITLE: Record<StateGroup, string> = { needs: 'Needs you', working: 'Working', idle: 'Idle', snoozed: 'Snoozed' };
/** The statuses whose agent (or work itself) is at something. */
const BUSY: ReadonlySet<DisplayKind> = new Set<DisplayKind>(['working', 'background', 'active', 'archiving', 'restoring']);

/**
 * Which State heading a session is under: Snoozed whatever else is true of it (its row says `snoozed`); else Needs
 * you when its agent asks or you owe it something (the owed badge: a turn to review, replies, merge, CI — what the
 * row's unseen mark says); else Working while its agent or work is at something; else Idle (one in review too).
 */
export function stateGroupOf(s: SessionSummary, kind: DisplayKind = displayStatus(s)): StateGroup {
  if (s.snoozed) return 'snoozed';
  if (kind === 'needs_input' || owedBadge(s)) return 'needs';
  if (BUSY.has(kind)) return 'working';
  return 'idle';
}

/**
 * The State view's groups, in the shape `railGroups` gives: Needs you, Working, Idle, Snoozed (keys `state:<group>`,
 * an empty one left out), each in the rail's order (your drag order, unplaced first: `railSessions`), so a row keeps
 * its place among its neighbours and moves only when its state does; then Older as in Mine. Pins and sections group
 * nothing here. Older holds the old sessions that want nothing of you: the selected one, and one that needs you (a
 * PR to merge on a session untouched for weeks), stay in their State group however old.
 */
export function stateGroups(
  sessions: SessionSummary[],
  opts: { now?: number; order?: readonly string[]; activeId?: string | null },
): { groups: RailGroup<SessionSummary>[] } {
  const now = opts.now ?? Date.now();
  const { current, older } = railSessions(sessions, now, opts.order ?? []);
  const kindOf = (s: SessionSummary) => stateGroupOf(s, displayStatus(s, now));
  const shown = (s: SessionSummary) => s.id === opts.activeId || kindOf(s) === 'needs';
  const by: Record<StateGroup, SessionSummary[]> = { needs: [], working: [], idle: [], snoozed: [] };
  for (const s of [...current, ...older.filter(shown)]) by[kindOf(s)].push(s);
  const groups: RailGroup<SessionSummary>[] = STATE_ORDER.filter((g) => by[g].length > 0).map((g) => ({
    key: `state:${g}`,
    title: STATE_TITLE[g],
    sessions: by[g],
  }));
  const rest = older.filter((s) => !shown(s));
  if (rest.length > 0) groups.push({ key: OLDER_GROUP, title: 'Older', sessions: rest });
  return { groups };
}

const PROJECT_PREFIX = 'project:';

/** The project a Project heading stands for (what its `+` starts a worktree in); null for any other heading. */
export function projectOfGroup(key: string): string | null {
  return key.startsWith(PROJECT_PREFIX) ? key.slice(PROJECT_PREFIX.length) : null;
}

/**
 * The Project view's groups: one per project (a session's `target`: its repo, or its group's name), keys
 * `project:<name>`, in alphabetical order whatever the case, each in the rail's order (`railSessions`); then Older as
 * in State: the selected older session and one that needs you stay under their project.
 */
export function projectGroups(
  sessions: SessionSummary[],
  opts: { now?: number; order?: readonly string[]; activeId?: string | null },
): { groups: RailGroup<SessionSummary>[] } {
  const now = opts.now ?? Date.now();
  const { current, older } = railSessions(sessions, now, opts.order ?? []);
  const shown = (s: SessionSummary) => s.id === opts.activeId || stateGroupOf(s, displayStatus(s, now)) === 'needs';
  const by = new Map<string, SessionSummary[]>();
  for (const s of [...current, ...older.filter(shown)]) by.set(s.target, [...(by.get(s.target) ?? []), s]);
  const groups: RailGroup<SessionSummary>[] = [...by.keys()]
    .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()) || a.localeCompare(b))
    .map((name) => ({ key: PROJECT_PREFIX + name, title: name, sessions: by.get(name)! }));
  const rest = older.filter((s) => !shown(s));
  if (rest.length > 0) groups.push({ key: OLDER_GROUP, title: 'Older', sessions: rest });
  return { groups };
}

/** The rail's groups in a view: what the rail draws and what j/k walk before the rail has said what it shows. */
export function groupsForView(
  view: RailView,
  sessions: SessionSummary[],
  opts: { now?: number; order?: readonly string[]; layout: RailLayout; activeId?: string | null },
): { groups: RailGroup<SessionSummary>[] } {
  return view === 'state' ? stateGroups(sessions, opts) : view === 'project' ? projectGroups(sessions, opts) : railGroups(sessions, opts);
}
