import type { DevServerState, SessionSummary } from '../api/client.js';
import type { MenuItem } from '../components/Dashboard/RowMenu.js';
import { formatTokens } from '../utils/tokens.js';
import { sessionKey } from './shortcuts.js';

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
  sendPrompt: () => void;
  notes: () => void;
  devStart: () => void;
  devStop: () => void;
  rename: () => void;
  remove: () => void;
}

export function sessionHeaderItems(session: SessionSummary, dev: DevServerState | null, a: HeaderMenuActions): MenuItem[] {
  const archived = !!session.archivedAt;
  // An archived session's Claude is stopped and its folder may be gone:
  // only what reads it, or names or deletes it, is offered.
  const live: MenuItem[] = archived
    ? []
    : [
        { label: 'Reconnect terminal', hint: sessionKey('reconnect'), run: a.reconnectTerminal },
        { label: 'Open in terminal', hint: sessionKey('terminal'), run: a.openTerminal },
        { label: 'Ship (push, PR, merge)…', hint: sessionKey('ship'), run: a.ship },
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
    ...(archived ? [] : [{ label: 'Send a prompt…', hint: sessionKey('prompt'), run: a.sendPrompt }]),
    { label: session.hasNote ? 'Notes •' : 'Notes', hint: sessionKey('notes'), run: a.notes },
    ...devItem,
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
