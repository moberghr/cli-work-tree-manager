import type { SessionSummary } from '../api/client.js';
import type { SnoozeFor } from '../../../core/snooze.js';
import type { MenuItem } from '../components/Dashboard/RowMenu.js';

/**
 * A session's right-click menu, after Rename (which the rail adds itself):
 * what the session header and the Sessions table offer as buttons, on the
 * row. Pure: the actions are passed in, so the menu can be tested and the
 * app decides what each does.
 */
export interface SessionMenuActions {
  setArchived: (s: SessionSummary, archived: boolean) => void;
  openTerminal: (s: SessionSummary) => void;
  openEditor: (s: SessionSummary) => void;
  copyBranch: (s: SessionSummary) => void;
  remove: (s: SessionSummary) => void;
  snooze: (s: SessionSummary, choice: SnoozeFor) => void;
  unsnooze: (s: SessionSummary) => void;
}

export function sessionMenuItems(s: SessionSummary, a: SessionMenuActions): MenuItem[] {
  const archived = !!s.archivedAt;
  return [
    archived
      ? { label: 'Restore', run: () => a.setArchived(s, false) }
      : { label: 'Archive', run: () => a.setArchived(s, true) },
    // Snooze: out of the Inbox for a while (an archived one isn't in it).
    ...(archived
      ? []
      : s.snoozed
        ? [{ label: 'Unsnooze', run: () => a.unsnooze(s), separated: true }]
        : [
            { label: 'Snooze 2 hours', run: () => a.snooze(s, '2h'), separated: true },
            { label: 'Snooze until tomorrow 9:00', run: () => a.snooze(s, 'tomorrow') },
            { label: 'Snooze until it changes', run: () => a.snooze(s, 'change') },
          ]),
    // An archived one's Claude is stopped and its folder may be gone: Restore first.
    ...(archived
      ? []
      : [
          { label: 'Open in terminal', run: () => a.openTerminal(s), separated: true },
          { label: 'Open in editor', run: () => a.openEditor(s) },
        ]),
    { label: 'Copy branch name', run: () => a.copyBranch(s), ...(archived ? { separated: true } : {}) },
    { label: 'Delete…', run: () => a.remove(s), danger: true, separated: true },
  ];
}
