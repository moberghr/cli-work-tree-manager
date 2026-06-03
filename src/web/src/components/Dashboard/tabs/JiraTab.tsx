import { useEffect, useMemo, useState } from 'react';
import { fetchJira, type JiraIssue } from '../../../api/panes.js';

interface Props {
  onPick: (issue: JiraIssue) => void;
  /** Existing sessions; used to badge issues that already have a worktree
   *  so the user doesn't accidentally create a duplicate. Indexed by
   *  jiraKey field on the SessionSummary. */
  sessionJiraKeys: Set<string>;
}

/**
 * Jira as a kanban board grouped by status. Each card shows the key,
 * summary, and (when applicable) a marker that a worktree already
 * exists for this issue. Clicking creates / jumps to one.
 */
export function JiraTab({ onPick, sessionJiraKeys }: Props) {
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

  const byStatus = useMemo(() => {
    if (!issues) return [];
    const m = new Map<string, JiraIssue[]>();
    for (const i of issues) {
      const arr = m.get(i.status) ?? [];
      arr.push(i);
      m.set(i.status, arr);
    }
    return Array.from(m.entries());
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
