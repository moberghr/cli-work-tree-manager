/**
 * Every keyboard shortcut of the dashboard, in one list: the `?` overlay
 * shows it, menus show a key beside an item, and the key handlers ask it
 * which action a key is. Pure.
 *
 * None of them fire while typing in a field (a terminal included), while a
 * dialog is up, or with Ctrl / Alt / ⌘ held — those keys are the page's or
 * the terminal's (the exceptions — Ctrl+K, Ctrl+P, Alt+1…9 — are listed,
 * and caught before a terminal sees them).
 */

/** What a key does to the open session. */
export type SessionAction =
  | 'tab-term'
  | 'tab-diff'
  | 'tab-pr'
  | 'tab-timeline'
  | 'archive'
  | 'snooze'
  | 'block'
  | 'menu'
  | 'prompt'
  | 'catchup'
  | 'notes'
  | 'ship'
  | 'terminal'
  | 'reconnect'
  | 'editor'
  | 'copy'
  | 'fork'
  | 'dev'
  | 'delete';

interface KeyDef {
  key: string;
  shift?: boolean;
  label: string;
}

/** The open session's keys. Shifted ones do something bigger, or less often wanted. */
export const SESSION_KEYS: Record<SessionAction, KeyDef> = {
  'tab-term': { key: '1', label: 'Terminal tab' },
  'tab-diff': { key: '2', label: 'Diff tab' },
  'tab-pr': { key: '3', label: 'PR tab' },
  'tab-timeline': { key: '4', label: 'Timeline tab' },
  archive: { key: 'e', label: 'Archive (Restore when archived)' },
  snooze: { key: 'z', label: 'Snooze…' },
  block: { key: 'b', label: 'Blocked by…' },
  menu: { key: '.', label: 'Its ⋯ menu' },
  prompt: { key: 'p', label: 'Send a prompt…' },
  catchup: { key: 'r', label: 'Catch me up' },
  notes: { key: 'n', shift: true, label: 'Notes' },
  ship: { key: 's', shift: true, label: 'Ship (push, PR, merge)…' },
  terminal: { key: 't', shift: true, label: 'Open in a terminal' },
  reconnect: { key: 'r', shift: true, label: 'Reconnect its terminal' },
  editor: { key: 'o', label: 'Open in editor' },
  copy: { key: 'y', label: 'Copy branch name' },
  fork: { key: 'f', label: 'Fork…' },
  dev: { key: 'd', shift: true, label: 'Start / stop the dev server' },
  delete: { key: 'Delete', shift: true, label: 'Delete…' },
};

/** The parts of a key event the handlers read. */
export interface KeyLike {
  key: string;
  shiftKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
}

/** The open session's action for a key, or null. Shift must match: `n` is "next", Shift+N is Notes. */
export function sessionActionFor(e: KeyLike): SessionAction | null {
  if (e.ctrlKey || e.metaKey || e.altKey) return null;
  const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  for (const [action, def] of Object.entries(SESSION_KEYS) as Array<[SessionAction, KeyDef]>) {
    if (def.key === key && !!def.shift === !!e.shiftKey) return action;
  }
  return null;
}

/** How a key is written: "e", "⇧S", "⇧Del". */
export function keyText(def: Pick<KeyDef, 'key' | 'shift'>): string {
  const k = def.key === 'Delete' ? 'Del' : def.key;
  return def.shift ? `⇧${k.length === 1 ? k.toUpperCase() : k}` : k;
}

/** A session action's key, for a menu item's hint. */
export const sessionKey = (a: SessionAction): string => keyText(SESSION_KEYS[a]);

export interface ShortcutRow {
  keys: string;
  label: string;
}

/** The `?` overlay, by where the keys work. */
export function shortcutGroups(): Array<{ title: string; rows: ShortcutRow[] }> {
  return [
    {
      title: 'Anywhere',
      rows: [
        { keys: 'c', label: 'New worktree' },
        { keys: 'n', label: 'Next session that wants you (next in the review queue)' },
        { keys: 'j / k', label: 'Next / previous session in the list on the left' },
        { keys: 'Alt+1…9', label: 'Open the first nine sessions on the left' },
        { keys: '/', label: 'Search sessions' },
        { keys: 'Ctrl+P', label: 'Switch to a session by name' },
        { keys: 'Ctrl+K', label: 'Ask (the assistant)' },
        { keys: '?', label: 'These shortcuts' },
      ],
    },
    {
      title: 'Go to',
      rows: [
        { keys: 'g i', label: 'Inbox' },
        { keys: 'g s', label: 'Sessions' },
        { keys: 'g d', label: 'Today' },
        { keys: 'g w', label: 'Start' },
        { keys: 'g j', label: 'Jira' },
        { keys: 'g r', label: 'Repos & groups' },
        { keys: 'g c', label: 'Clean up' },
        { keys: 'g t', label: 'Tasks (open / close)' },
      ],
    },
    {
      title: 'The open session',
      rows: [
        ...Object.values(SESSION_KEYS).map((d) => ({ keys: keyText(d), label: d.label })),
        { keys: 'F2', label: 'Rename' },
        { keys: 'Alt+↑ / ↓', label: 'Move it up / down the list (on its row)' },
      ],
    },
    {
      title: 'The diff',
      rows: [{ keys: '] / [', label: 'Next / previous comment' }],
    },
  ];
}

/** The event the dashboard sends the open session's header for the keys it acts on (its menu, Ship, notes…). */
export const SESSION_ACTION_EVENT = 'work:session-action';
export interface SessionActionDetail {
  id: string;
  action: SessionAction;
}

/** What the dashboard does for each of the open session's keys (DashboardApp passes its functions). */
export interface SessionKeyHandlers {
  tab: (sub: 'term' | 'diff' | 'pr' | 'timeline') => void;
  setArchived: (archived: boolean) => void;
  snoozeMenu: () => void;
  blockBy: () => void;
  openEditor: () => void;
  copyBranch: () => void;
  fork: () => void;
  remove: () => void;
  /** The rest are its header's (its menu, Ship, notes, a prompt, catch-up, the dev server, a terminal). */
  header: (a: SessionAction) => void;
}

/** Run a session key. An archived session has no Claude and maybe no folder: only what reads, names or deletes it. */
export function runSessionKey(action: SessionAction, s: { archived: boolean }, h: SessionKeyHandlers): void {
  const live = !s.archived;
  switch (action) {
    case 'tab-term':
      return h.tab('term');
    case 'tab-diff':
      return h.tab('diff');
    case 'tab-pr':
      return h.tab('pr');
    case 'tab-timeline':
      return h.tab('timeline');
    case 'archive':
      return h.setArchived(live);
    case 'snooze':
      return live ? h.snoozeMenu() : undefined;
    case 'block':
      return live ? h.blockBy() : undefined;
    case 'editor':
      return live ? h.openEditor() : undefined;
    case 'copy':
      return h.copyBranch();
    case 'fork':
      return live ? h.fork() : undefined;
    case 'delete':
      return h.remove();
    default:
      return h.header(action);
  }
}
