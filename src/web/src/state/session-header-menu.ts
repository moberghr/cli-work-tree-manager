import type { DevServerState, SessionSummary } from '../api/client.js';
import { formatTokens } from '../utils/tokens.js';
import { sessionKey } from './shortcuts.js';
import { canAddRepo } from './add-repo.js';
import { canSwitchAccount } from './accounts.js';
import type { MenuItem } from '../ui/index.js';

/**
 * The session header's ⋯ menu. The header itself shows one action (Archive,
 * or Restore); everything else you do to a session now and then is here.
 * Pure: the actions are passed in.
 */
export interface HeaderMenuActions {
  openTerminal: () => void;
  /** A new connection for its Terminal tab (terminal-reconnect.ts). */
  reconnectTerminal: () => void;
  ship: () => void;
  catchUp: () => void;
  /** Its agent's newest message, as written, to the clipboard (not the terminal's wrapped drawing of it). */
  copyReply: () => void;
  /** How it got here (its prompts, turns, commits, PRs) and how long its Claude worked. */
  timeline: () => void;
  sendPrompt: () => void;
  notes: () => void;
  devStart: () => void;
  devStop: () => void;
  rename: () => void;
  remove: () => void;
  /** Restart its agent, resuming its conversation: it reads its settings, MCP servers and plugins again. */
  restartAgent?: () => void;
  /** Keep it once its PR merges, or go back to archiving it then (the rail menu's item). */
  keep?: (keep: boolean) => void;
  /** Open Processes…: what it holds in memory, and stopping one left running (a live session only). */
  processes?: () => void;
  /** Open Add a repo… — offered only for a session folder that isn't archived (`canAddRepo`). */
  addRepo?: () => void;
  /** Open Claude account… — given only while more than one account exists; offered for a live Claude session. */
  account?: () => void;
}

export function sessionHeaderItems(session: SessionSummary, dev: DevServerState | null, a: HeaderMenuActions): MenuItem[] {
  const archived = !!session.archivedAt;
  // An archived session's Claude is stopped and its folder may be gone:
  // only what reads it, or names or deletes it, is offered.
  const live: MenuItem[] = archived
    ? []
    : [
        { label: 'Reconnect terminal', hint: sessionKey('reconnect'), run: a.reconnectTerminal },
        ...(a.restartAgent ? [{ label: 'Restart Claude (reads settings, MCP servers, plugins again)', run: a.restartAgent }] : []),
        { label: 'Open in terminal', hint: sessionKey('terminal'), run: a.openTerminal },
        { label: 'Ship (push, PR, merge)…', hint: sessionKey('ship'), run: a.ship },
        ...(a.keep
          ? [
              session.keepAfterMerge
                ? { label: 'Archive after its PR merges', hint: sessionKey('keep'), run: () => a.keep!(false) }
                : { label: 'Keep after its PR merges', hint: sessionKey('keep'), run: () => a.keep!(true) },
            ]
          : []),
        ...(a.account && canSwitchAccount(session) ? [{ label: 'Claude account…', hint: sessionKey('account'), run: a.account }] : []),
        ...(a.addRepo && canAddRepo(session) ? [{ label: 'Add a repo…', hint: sessionKey('add-repo'), run: a.addRepo }] : []),
      ];
  const devItem: MenuItem[] =
    archived || !dev || dev.port === null || (!dev.command && !dev.running)
      ? []
      : [
          dev.running
            ? { label: 'Stop dev server', hint: `:${dev.port} · ${sessionKey('dev')}`, run: a.devStop }
            : { label: 'Start dev server', hint: `:${dev.port} · ${sessionKey('dev')}`, run: a.devStart },
        ];
  return [
    ...live,
    { label: 'Catch me up', hint: sessionKey('catchup'), run: a.catchUp },
    { label: 'Copy Claude’s last reply', hint: sessionKey('copy-reply'), run: a.copyReply },
    { label: 'Timeline', hint: sessionKey('timeline'), run: a.timeline },
    ...(archived ? [] : [{ label: 'Send a prompt…', hint: sessionKey('prompt'), run: a.sendPrompt }]),
    { label: session.hasNote ? 'Notes •' : 'Notes', hint: sessionKey('notes'), run: a.notes },
    ...devItem,
    ...(!archived && a.processes ? [{ label: 'Processes…', run: a.processes }] : []),
    { label: 'Rename', hint: 'F2', run: a.rename, separated: true },
    { label: 'Delete…', hint: sessionKey('delete'), run: a.remove, danger: true },
  ];
}

/** The menu's muted last line: how full its conversation is, when known. */
export function contextFooter(session: SessionSummary): string | undefined {
  const c = session.context;
  if (!c || c.window <= 0) return undefined;
  const pct = Math.round(Math.min(1, c.used / c.window) * 100);
  return `Context ${pct}% · ${formatTokens(c.used)} of ${formatTokens(c.window)} tokens`;
}
