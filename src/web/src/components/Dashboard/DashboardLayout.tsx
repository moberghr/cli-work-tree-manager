import type { ReactNode } from 'react';
import type { SessionSummary } from '../../api/client.js';
import type { DashboardRoute } from '../../state/dashboard-route.js';
import { TopNav } from './TopNav.js';
import { SessionRail } from './SessionRail.js';

interface Props {
  route: DashboardRoute;
  sessions: SessionSummary[];
  currentScopeLabel?: string;
  onSelectTab: (tab: DashboardRoute['tab']) => void;
  onSelectSession: (id: string) => void;
  onHome: () => void;
  onNewWorktree: () => void;
  children: ReactNode;
}

/**
 * Three-region dashboard chrome:
 *   ┌──────────────────────────────────────────────────────┐
 *   │ TopNav (brand · Sessions PRs Jira Tasks · scope)     │
 *   ├──────┬───────────────────────────────────────────────┤
 *   │ Rail │           main slot (children)                │
 *   │      │                                               │
 *   └──────┴───────────────────────────────────────────────┘
 *
 * Top nav + rail stay visible across every dashboard view; only the
 * main slot swaps. ReviewApp (the bare `wd` deep-link view) does NOT
 * mount this — it's a different shell entirely.
 */
export function DashboardLayout({
  route,
  sessions,
  currentScopeLabel,
  onSelectTab,
  onSelectSession,
  onHome,
  onNewWorktree,
  children,
}: Props) {
  return (
    <div className="wd-dash-layout">
      <TopNav
        active={route.tab}
        onSelect={onSelectTab}
        currentScopeLabel={currentScopeLabel}
        onHome={onHome}
      />
      <div className="wd-dash-body">
        <SessionRail
          sessions={sessions}
          activeSessionId={route.sessionId}
          onSelect={onSelectSession}
          onNewWorktree={onNewWorktree}
        />
        <main className="wd-dash-main">{children}</main>
      </div>
    </div>
  );
}
