import { useEffect, useMemo, useState } from 'react';
import { columnOrder } from '../../../../../core/jira-board.js';
import {
  dismissJiraIssue,
  fetchJira,
  fetchJiraWatch,
  setJiraWatch,
  startJiraIssue,
  type JiraDecision,
  type JiraIssue,
  type JiraWatchState,
} from '../../../api/panes.js';
import { useSse } from '../../../api/events.js';
import { relativeTime } from '../../../utils/time.js';

interface Props {
  onPick: (issue: JiraIssue) => void;
  /** Existing sessions; used to badge issues that already have a worktree
   *  so the user doesn't accidentally create a duplicate. Indexed by
   *  jiraKey field on the SessionSummary. */
  sessionJiraKeys: Set<string>;
  /** Open a session the Jira watch started. */
  onOpenSession?: (id: string) => void;
}

/**
 * Jira as a kanban board grouped by status. Each card shows the key,
 * summary, and (when applicable) a marker that a worktree already
 * exists for this issue. Clicking creates / jumps to one.
 */
export function JiraTab({ onPick, sessionJiraKeys, onOpenSession }: Props) {
  const [issues, setIssues] = useState<JiraIssue[] | null>(null);
  const [available, setAvailable] = useState(true);
  const [error, setError] = useState<string | null>(null);

  function refresh() {
    fetchJira().then(
      (r) => {
        setIssues(r.issues);
        if (r.available === false) setAvailable(false);
        if (r.error) setError(r.error);
        else setError(null);
      },
      (err: Error) => setError(err.message),
    );
  }

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 120_000);
    return () => clearInterval(t);
  }, []);

  // The Jira watch: its switch, and what it did with each issue.
  const [watch, setWatch] = useState<JiraWatchState | null>(null);
  const [switching, setSwitching] = useState(false);
  const [watchError, setWatchError] = useState<string | null>(null);
  const refreshWatch = () => void fetchJiraWatch().then(setWatch, () => {});
  useEffect(refreshWatch, []);
  useSse('/events', { events: { 'jira-watch-changed': refreshWatch } });
  const decisions = useMemo(() => new Map((watch?.decisions ?? []).map((d) => [d.key, d])), [watch]);
  const toggle = (on: boolean) => {
    setSwitching(true);
    setWatchError(null);
    setJiraWatch(on).then(
      () => {
        setSwitching(false);
        refreshWatch();
      },
      (err: Error) => {
        setSwitching(false);
        setWatchError(err.message);
      },
    );
  };

  // Columns in workflow order (to do → in progress → review → testing), not
  // in whichever order the most recently updated issue put them.
  const byStatus = useMemo(() => {
    if (!issues) return [];
    const m = new Map<string, JiraIssue[]>();
    for (const i of issues) {
      const arr = m.get(i.status) ?? [];
      arr.push(i);
      m.set(i.status, arr);
    }
    const order = columnOrder([...m.entries()].map(([status, group]) => ({ status, category: group[0].statusCategory })));
    return order.map((status) => [status, m.get(status)!] as const);
  }, [issues]);

  return (
    <div className="wd-dash-tab-pane wd-tab-jira">
      <header className="wd-tab-header">
        <h1>
          Jira{' '}
          <span className="wd-tab-header-muted">
            ({issues?.length ?? '…'} issues)
          </span>
        </h1>
        <div className="wd-tab-controls">
          {watch && (
            <label
              className="wd-jira-watch-switch"
              title="When an issue is assigned to you, an AI picks the project it belongs in and work starts a session on it (feat/<KEY>). Not sure, it suggests one here for you to start. Issues assigned before you turned it on are left alone."
            >
              <input
                type="checkbox"
                role="switch"
                checked={watch.settings.enabled}
                disabled={switching}
                onChange={(e) => toggle(e.target.checked)}
              />{' '}
              Start new issues automatically
            </label>
          )}
          <button
            type="button"
            className="wd-btn-secondary"
            onClick={refresh}
            title="Refresh"
          >
            ⟳
          </button>
        </div>
      </header>
      {watch?.settings.enabled && (
        <p className="wd-jira-watch-line">
          Watching for issues assigned to you since {ago(watch.settings.since ?? '')}
          {watch.lastRunAt ? ` · last check ${ago(watch.lastRunAt)}` : ''}
          {' · '}at most 2 starts a check and 5 a day. Each choice is in the Activity panel.
        </p>
      )}
      {watchError && <div className="wd-tab-empty wd-tab-error">{watchError}</div>}
      {!available && (
        <div className="wd-tab-empty">
          <code>acli</code> CLI not available or not authenticated.
        </div>
      )}
      {error && <div className="wd-tab-empty wd-tab-error">{error}</div>}
      {available && issues && issues.length === 0 && !error && (
        <div className="wd-tab-empty">No issues assigned to you.</div>
      )}
      {byStatus.length > 0 && (
        <div className="wd-jira-board">
          {byStatus.map(([status, group]) => (
            <div key={status} className="wd-jira-col">
              <header className="wd-jira-col-header">
                <span>{status}</span>
                <span className="wd-tab-header-muted">{group.length}</span>
              </header>
              <ul className="wd-jira-col-list">
                {group.map((i) => {
                  const hasSession = sessionJiraKeys.has(i.key);
                  return (
                    <li
                      key={i.key}
                      className="wd-jira-card"
                      onClick={() => onPick(i)}
                      role="button"
                      tabIndex={0}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') onPick(i);
                      }}
                      title={i.summary}
                    >
                      <header className="wd-jira-card-header">
                        <span className="wd-jira-card-key">{i.key}</span>
                        <a
                          href={i.url}
                          target="_blank"
                          rel="noreferrer"
                          className="wd-jira-card-link"
                          onClick={(e) => e.stopPropagation()}
                          title="Open in Jira"
                        >
                          ↗
                        </a>
                      </header>
                      <p className="wd-jira-card-summary">{i.summary}</p>
                      {hasSession && (
                        <span className="wd-jira-card-has-session">
                          ● has worktree
                        </span>
                      )}
                      {decisions.has(i.key) && (
                        <WatchDecision decision={decisions.get(i.key)!} targets={watch?.targets ?? []} onOpenSession={onOpenSession} onChanged={refreshWatch} />
                      )}
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** "4m ago", or "just now". */
function ago(iso: string): string {
  const t = relativeTime(iso);
  return t === 'just now' || t === '' ? t : `${t} ago`;
}

/** What the Jira watch did with this issue, on its card; a suggestion can be started or dismissed. */
function WatchDecision({
  decision: d,
  targets,
  onOpenSession,
  onChanged,
}: {
  decision: JiraDecision;
  targets: string[];
  onOpenSession?: (id: string) => void;
  onChanged: () => void;
}) {
  const [target, setTarget] = useState(d.target ?? targets[0] ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const stop = (e: React.SyntheticEvent) => e.stopPropagation();
  const run = (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    fn().then(
      () => {
        setBusy(false);
        onChanged();
      },
      (err: Error) => {
        setBusy(false);
        setError(err.message);
      },
    );
  };
  if (d.action === 'started') {
    return (
      <span className="wd-jira-watch wd-jira-watch-started" title={d.reason}>
        ▶ started in {d.target}
        {d.sessionId && onOpenSession && (
          <button type="button" className="wd-link-button" onClick={(e) => (stop(e), onOpenSession(d.sessionId!))}>
            open
          </button>
        )}
      </span>
    );
  }
  if (d.action === 'suggested' || d.action === 'failed') {
    return (
      <div className="wd-jira-watch wd-jira-watch-ask" onClick={stop} onKeyDown={stop}>
        <span title={d.reason}>
          {d.action === 'failed' ? `⚠ couldn't start it: ${d.reason}` : `? not sure where it belongs${d.target ? ` — maybe ${d.target}` : ''}`}
        </span>
        <span className="wd-jira-watch-actions">
          <select value={target} onChange={(e) => setTarget(e.target.value)} disabled={busy} aria-label={`Project for ${d.key}`}>
            {targets.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
          <button type="button" className="wd-btn-primary" disabled={busy || !target} onClick={() => run(() => startJiraIssue(d.key, target))}>
            {busy ? 'Starting…' : 'Start'}
          </button>
          <button type="button" className="wd-btn-secondary" disabled={busy} onClick={() => run(() => dismissJiraIssue(d.key))} title="Not this one">
            Dismiss
          </button>
        </span>
        {error && <span className="wd-jira-watch-error">{error}</span>}
      </div>
    );
  }
  return null; // skipped (it has a session: the card says so), dismissed, baseline
}
