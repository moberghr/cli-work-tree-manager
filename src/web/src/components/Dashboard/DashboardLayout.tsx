import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { SessionSummary } from '../../api/client.js';
import type { DashboardRoute } from '../../state/dashboard-route.js';
import type { PrLookup } from '../../state/session-display.js';
import { TopNav } from './TopNav.js';
import { SessionRail } from './SessionRail.js';
import {
  RAIL_SPEC,
  ResizeDivider,
  useResizableSize,
} from '../Layout/ResizeDivider.js';

interface Props {
  route: DashboardRoute;
  sessions: SessionSummary[];
  currentScopeLabel?: string;
  onSelectTab: (tab: DashboardRoute['tab']) => void;
  onSelectSession: (id: string) => void;
  onHome: () => void;
  onNewWorktree: () => void;
  /** Badge on the Inbox tab. */
  inboxCount?: number;
  /** Open PRs per session, for the rail badges. */
  prsFor?: PrLookup;
  /** Opens / closes the Ctrl+K assistant (the top-nav button). */
  onAssistant?: () => void;
  assistantOpen?: boolean;
  /** The rail's drag order (session ids, top first) and what a drag sets. */
  sessionOrder?: string[];
  onReorderSessions?: (order: string[]) => void;
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
 * main slot swaps. The rail is resizable (drag the divider; the width
 * persists in localStorage). ReviewApp (the bare `wd` deep-link view) does NOT
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
  inboxCount,
  prsFor,
  onAssistant,
  assistantOpen,
  sessionOrder,
  onReorderSessions,
  children,
}: Props) {
  // Narrow layouts (≤ 720 px, see dashboard.css) show the rail as an
  // off-canvas drawer; on wide ones this flag is inert.
  const [railOpen, setRailOpen] = useState(false);
  // Any navigation — the Inbox, `n`, a link, back/forward — closes it, not
  // just a click inside the drawer.
  useEffect(() => {
    setRailOpen(false);
  }, [route.tab, route.sessionId, route.sessionSubTab]);
  useEffect(() => {
    if (!railOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setRailOpen(false);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [railOpen]);
  const { size: railWidth, setSize: setRailWidth } =
    useResizableSize(RAIL_SPEC);
  // Owns `--rail-width`; ResizeDivider writes it here during a drag.
  const bodyRef = useRef<HTMLDivElement>(null);
  return (
    <div className="wd-dash-layout">
      <TopNav
        active={route.tab}
        onSelect={onSelectTab}
        currentScopeLabel={currentScopeLabel}
        onHome={onHome}
        inboxCount={inboxCount}
        onToggleRail={() => setRailOpen((o) => !o)}
        railOpen={railOpen}
        onAssistant={onAssistant}
        assistantOpen={assistantOpen}
      />
      <div
        ref={bodyRef}
        className={'wd-dash-body' + (railOpen ? ' wd-dash-rail-open' : '')}
        style={{ [RAIL_SPEC.cssVar as string]: `${railWidth}px` }}
      >
        {railOpen && (
          <div
            className="wd-dash-rail-backdrop"
            onClick={() => setRailOpen(false)}
            aria-hidden
          />
        )}
        <SessionRail
          sessions={sessions}
          activeSessionId={route.sessionId}
          onSelect={(id) => {
            setRailOpen(false);
            onSelectSession(id);
          }}
          onNewWorktree={() => {
            setRailOpen(false);
            onNewWorktree();
          }}
          prsFor={prsFor}
          order={sessionOrder}
          onReorder={onReorderSessions}
        />
        <ResizeDivider
          layoutRef={bodyRef}
          size={railWidth}
          onCommit={setRailWidth}
          spec={RAIL_SPEC}
        />
        <main className="wd-dash-main">{children}</main>
      </div>
    </div>
  );
}
