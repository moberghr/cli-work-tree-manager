import type { DashboardRoute } from '../../state/dashboard-route.js';
import { ThemeToggle } from '../ThemeToggle.js';

interface Props {
  active: DashboardRoute['tab'];
  onSelect: (tab: DashboardRoute['tab']) => void;
  /** Click handler for the brand / "work" home link. Resets the route
   *  to the Sessions tab. */
  onHome: () => void;
  /** Sessions that want you now (needs input + finished, unseen). */
  inboxCount?: number;
  /** Narrow layouts: toggles the session drawer (the button only shows
   *  below the breakpoint, via CSS). */
  onToggleRail?: () => void;
  railOpen?: boolean;
  /** Opens / closes the Ctrl+K assistant. */
  onAssistant?: () => void;
  assistantOpen?: boolean;
  /** What work is doing in the background (ActivityIndicator): a small dot. */
  activity?: React.ReactNode;
  /** The Tasks button and its panel (TasksPanel). */
  tasks?: React.ReactNode;
  /** Help: version, updates, what's new, shortcuts (HelpMenu). */
  help?: React.ReactNode;
  /** Served by the dev server (`work web --dev`): DEV next to the brand. */
  dev?: boolean;
}

interface TabDef {
  key: DashboardRoute['tab'];
  label: string;
  /** Single-key shortcut under the `g` chord (gmail/github style):
   *  pressing `g` then this key navigates here. */
  hotkey: string;
}

const TABS: TabDef[] = [
  { key: 'inbox', label: 'Inbox', hotkey: 'i' },
  { key: 'sessions', label: 'Sessions', hotkey: 's' },
  { key: 'start', label: 'Start', hotkey: 'w' },
  { key: 'jira', label: 'Jira', hotkey: 'j' },
  { key: 'time', label: 'Time', hotkey: 'h' },
];

/** Pages reached from a tab show that tab as current: Today and Clean up are Sessions' views. */
const TAB_OF: Partial<Record<DashboardRoute['tab'], DashboardRoute['tab']>> = {
  today: 'sessions',
  cleanup: 'sessions',
  repos: 'start',
  welcome: 'start',
};

/**
 * Top bar, kept short: brand, the tabs (Inbox, Sessions, Start, Jira), then Tasks, Ask, the background
 * jobs' dot, the version (Help: updates, what's new, shortcuts) and the theme toggle (shared, persisted preference — see
 * ThemeProvider). The session list is the rail beside every page; a
 * session's own page opens from it.
 */
export function TopNav({
  active,
  onSelect,
  onHome,
  inboxCount = 0,
  onToggleRail,
  railOpen = false,
  onAssistant,
  assistantOpen = false,
  activity,
  tasks,
  help,
  dev = false,
}: Props) {
  const current = TAB_OF[active] ?? active;
  return (
    <nav className="wd-dash-topnav" role="navigation" aria-label="Dashboard">
      {onToggleRail && (
        <button
          type="button"
          className="wd-dash-rail-toggle"
          onClick={onToggleRail}
          aria-label={railOpen ? 'Close session list' : 'Open session list'}
          aria-expanded={railOpen}
        >
          ☰
        </button>
      )}
      <button type="button" className="wd-dash-brand" onClick={onHome} title="work — dashboard home">
        work
      </button>
      {dev && (
        <span className="wd-dash-dev" title="This checkout's build on your real sessions (work web --dev), beside the installed work">
          DEV
        </span>
      )}
      <ul className="wd-dash-tabs" role="tablist">
        {TABS.map((t) => (
          <li key={t.key}>
            <button
              type="button"
              role="tab"
              aria-selected={current === t.key}
              className={'wd-dash-tab' + (current === t.key ? ' wd-dash-tab-active' : '')}
              title={`${t.label}  (press g ${t.hotkey})`}
              onClick={() => onSelect(t.key)}
            >
              {t.label}
              {t.key === 'inbox' && inboxCount > 0 && (
                <span className="wd-dash-tab-badge" aria-label={`${inboxCount} need you`}>
                  {inboxCount}
                </span>
              )}
            </button>
          </li>
        ))}
      </ul>
      <div className="wd-dash-topnav-spacer" />
      {tasks}
      {onAssistant && (
        <button
          type="button"
          className={'wd-assistant-toggle' + (assistantOpen ? ' wd-assistant-toggle-on' : '')}
          onClick={onAssistant}
          aria-pressed={!!assistantOpen}
          title="Ask Claude about your sessions (Ctrl+K)"
        >
          Ask <kbd>Ctrl K</kbd>
        </button>
      )}
      {activity}
      {help}
      <ThemeToggle />
    </nav>
  );
}
