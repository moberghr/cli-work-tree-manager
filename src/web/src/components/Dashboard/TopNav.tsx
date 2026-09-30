import type { DashboardRoute } from '../../state/dashboard-route.js';
import { VERSION } from '../../version.js';
import { ThemeToggle } from '../ThemeToggle.js';

interface Props {
  active: DashboardRoute['tab'];
  onSelect: (tab: DashboardRoute['tab']) => void;
  /** Optional "current scope" hint shown on the right. Lets the user
   *  see which worktree any per-session deep links would resolve to. */
  currentScopeLabel?: string;
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
  /** What work is doing in the background (ActivityIndicator). */
  activity?: React.ReactNode;
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
  { key: 'today', label: 'Today', hotkey: 'd' },
  { key: 'sessions', label: 'Sessions', hotkey: 's' },
  { key: 'prs', label: 'PRs', hotkey: 'p' },
  { key: 'jira', label: 'Jira', hotkey: 'j' },
  { key: 'tasks', label: 'Tasks', hotkey: 't' },
];

/**
 * Top navigation strip: brand + primary tabs + current-scope hint + the
 * light/dark theme toggle (shared, persisted preference — see ThemeProvider). The
 * tabs are the cross-cutting lenses of the dashboard (`Sessions`,
 * `PRs`, `Jira`, `Tasks`). A session-detail view (drill-in) lives
 * outside this nav and breadcrumbs back to whichever tab the user
 * came from.
 */
export function TopNav({
  active,
  onSelect,
  currentScopeLabel,
  onHome,
  inboxCount = 0,
  onToggleRail,
  railOpen = false,
  onAssistant,
  assistantOpen = false,
  activity,
}: Props) {
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
      <button
        type="button"
        className="wd-dash-brand"
        onClick={onHome}
        title="work — dashboard home"
      >
        work
      </button>
      <span className="wd-dash-version" title={`work-tree v${VERSION}`}>
        v{VERSION}
      </span>
      <ul className="wd-dash-tabs" role="tablist">
        {TABS.map((t) => (
          <li key={t.key}>
            <button
              type="button"
              role="tab"
              aria-selected={active === t.key}
              className={
                'wd-dash-tab' +
                (active === t.key ? ' wd-dash-tab-active' : '')
              }
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
      {currentScopeLabel && (
        <span
          className="wd-dash-current-scope"
          title="Current `wd` scope — deep links resolve here"
        >
          {currentScopeLabel}
        </span>
      )}
      {activity}
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
      <ThemeToggle />
    </nav>
  );
}
