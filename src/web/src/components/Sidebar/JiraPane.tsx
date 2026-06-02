import { useEffect, useState } from 'react';
import { fetchJira, type JiraIssue } from '../../api/panes.js';

interface Props {
  /** Called when the user picks an issue — caller opens the new-worktree
   *  modal pre-filled with the issue key as jiraKey and a slug branch. */
  onPick: (issue: JiraIssue) => void;
}

/** Cheap slug from an issue summary. Same shape as the TUI. */
export function jiraSlug(issue: JiraIssue): string {
  const base = issue.summary
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return `feat/${issue.key}${base ? '-' + base : ''}`;
}

export function JiraPane({ onPick }: Props) {
  const [issues, setIssues] = useState<JiraIssue[] | null>(null);
  const [available, setAvailable] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

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
    if (!open) return;
    if (issues === null) refresh();
    const t = setInterval(refresh, 120_000);
    return () => clearInterval(t);
  }, [open, issues]);

  const byStatus = (() => {
    const m = new Map<string, JiraIssue[]>();
    for (const i of issues ?? []) {
      const arr = m.get(i.status) ?? [];
      arr.push(i);
      m.set(i.status, arr);
    }
    return Array.from(m.entries());
  })();

  return (
    <details
      className="wd-web-group wd-web-pane"
      open={open}
      onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}
    >
      <summary className="wd-web-group-summary">
        <span className="wd-web-group-target">Jira</span>
        <span className="wd-web-group-count">{issues?.length ?? '…'}</span>
      </summary>
      {!available && (
        <p className="wd-web-empty-list">`acli` not available.</p>
      )}
      {error && <p className="wd-web-empty-list wd-web-error">{error}</p>}
      {available && issues && issues.length === 0 && (
        <p className="wd-web-empty-list">No issues assigned.</p>
      )}
      {byStatus.map(([status, group]) => (
        <div key={status} className="wd-web-jira-status">
          <div className="wd-web-jira-status-label">{status}</div>
          <ul className="wd-web-session-list">
            {group.map((i) => (
              <li
                key={i.key}
                className="wd-web-session-row"
                onClick={() => onPick(i)}
                title={i.summary}
              >
                <div className="wd-web-session-row-main">
                  <span className="wd-web-jira-key">{i.key}</span>
                  <span className="wd-web-session-branch">{i.summary}</span>
                  <a
                    className="wd-web-task-action"
                    href={i.url}
                    target="_blank"
                    rel="noreferrer"
                    onClick={(e) => e.stopPropagation()}
                    title="Open in Jira"
                  >
                    ↗
                  </a>
                </div>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </details>
  );
}
