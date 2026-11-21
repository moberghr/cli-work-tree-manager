import { useEffect, useMemo, useState } from 'react';
import { columnOrder } from '../../../../../core/jira/jira-board.js';
import {
  dismissJiraIssue,
  fetchJiraWatch,
  fetchIssueList,
  setJiraWatch,
  startJiraIssue,
  type JiraDecision,
  type JiraIssue,
  type JiraWatchState,
} from '../../../api/panes.js';
import type { SessionSummary } from '../../../api/client.js';
import { useSse } from '../../../api/events.js';
import { isArchived } from '../../../state/session-display.js';
import { sessionIsForIssue } from '../../../../../core/jira/jira-prompt.js';
import { timeAgo } from '../../../utils/time.js';
import { Button, PageHeader, Select } from '../../../ui/index.js';

interface Props {
  sessions: SessionSummary[];
  /** Start from an issue: the New worktree dialog, filled in. */
  onPickIssue: (issue: JiraIssue) => void;
  onOpenSession: (id: string) => void;
  /** Test seam; defaults to the API. */
  loadJira?: typeof fetchIssueList;
}

/** The live session made for this issue, if any. Pure. */
export function sessionForIssue(issue: JiraIssue, sessions: SessionSummary[]): SessionSummary | undefined {
  return sessions.find((s) => !isArchived(s) && sessionIsForIssue(s, issue));
}

/**
 * Jira: the issues assigned to you, in workflow order (done ones left out),
 * each with Start — the New worktree dialog, filled in — or a link to the
 * session already on it; and the switch that starts newly assigned issues
 * by themselves (the Jira watch), with what it did with each.
 */
export function JiraTab({ sessions, onPickIssue, onOpenSession, loadJira = fetchIssueList }: Props) {
  const [issues, setIssues] = useState<JiraIssue[] | null>(null);
  const [jiraNote, setJiraNote] = useState<string | null>(null);
  /** Where the list is from, by name (the connectors that could be asked). */
  const [from, setFrom] = useState<string[]>(['Jira']);
  /** A connector that couldn't be asked while others could. */
  const [partNote, setPartNote] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    const load = () => {
      loadJira().then(
        (r) => {
          if (!live) return;
          setIssues(r.issues);
          if (r.from?.length) setFrom(r.from);
          // None could be asked: say why in place of the list. Some could: the list, with the note above it.
          setJiraNote(r.available === false ? (r.error ?? 'acli isn’t available or logged in.') : null);
          setPartNote(r.available === false ? null : (r.error ?? null));
        },
        (err: Error) => live && setJiraNote(err.message),
      );
    };
    load();
    const t = setInterval(load, 120_000);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [loadJira]);

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

  // Issues in workflow order (to do → in progress → review), done ones left out.
  const ordered = useMemo(() => {
    if (!issues) return [];
    const open = issues.filter((i) => i.statusCategory !== 'done');
    const statuses = [...new Map(open.map((i) => [i.status, i.statusCategory])).entries()].map(([status, category]) => ({
      status,
      category,
    }));
    const rank = new Map(columnOrder(statuses).map((s, i) => [s, i]));
    return [...open].sort((a, b) => (rank.get(a.status) ?? 0) - (rank.get(b.status) ?? 0));
  }, [issues]);
  const existing = (s: SessionSummary | undefined) =>
    s ? (
      <Button variant="link" className="wd-start-existing" onClick={() => onOpenSession(s.id)} title="Open the session on it">
        {s.titleIsYours && s.title ? s.title : s.branch} →
      </Button>
    ) : null;

  return (
    <div className="wd-dash-tab-pane wd-tab-jira">
      <PageHeader
        title="Issues"
        meta={issues !== null && !jiraNote ? `${ordered.length} assigned to you · from ${from.join(', ')}` : undefined}
      />

      <section className="wd-start-section" aria-label="Jira issues assigned to you">
        {jiraNote && <p className="wd-start-note">{jiraNote}</p>}
        {partNote && <p className="wd-start-note">{partNote}</p>}
        {!jiraNote && issues === null && <p className="wd-start-note">Loading…</p>}
        {!jiraNote && issues !== null && ordered.length === 0 && <p className="wd-start-note">Nothing assigned to you.</p>}
        <ul className="wd-start-list">
          {ordered.map((i) => {
            const decision = decisions.get(i.key);
            return (
              <li key={`${i.source ?? 'jira'}:${i.key}`} className="wd-start-row">
                <a className="wd-start-key" href={i.url} target="_blank" rel="noreferrer" title="Open in Jira">
                  {i.key}
                </a>
                <span className="wd-start-what" title={i.summary}>
                  {i.summary}
                </span>
                <span className="wd-start-state">{i.status}</span>
                <span className="wd-start-action">
                  {existing(sessionForIssue(i, sessions)) ?? (
                    <Button
                      onClick={() => onPickIssue(i)}
                      title={i.startsIn ? `Starts in ${i.startsIn} (your issue rules, Settings → Issues)` : undefined}
                    >
                      {i.startsIn ? `Start in ${i.startsIn}` : 'Start'}
                    </Button>
                  )}
                </span>
                {decision && (
                  <WatchDecision
                    decision={decision}
                    targets={watch?.targets ?? []}
                    onOpenSession={onOpenSession}
                    onChanged={refreshWatch}
                  />
                )}
              </li>
            );
          })}
        </ul>
      </section>

      {watch && (
        <div className="wd-start-watch">
          <label
            className="wd-jira-watch-switch"
            title="When an issue is assigned to you and one of your rules for it says (auto) (Settings → Issues → Issues start in), work starts a session on it (feat/<KEY>) in that rule's project. Any other new issue is listed here with the project it would go in, for you to start. Issues assigned before you turned it on are left alone."
          >
            <input type="checkbox" checked={watch.settings.enabled} disabled={switching} onChange={(e) => toggle(e.target.checked)} /> Start
            newly assigned Jira issues by themselves
          </label>
          {watch.settings.enabled && (
            <p className="wd-start-note">
              Watching since {timeAgo(watch.settings.since ?? '')}
              {watch.lastRunAt ? ` · last check ${timeAgo(watch.lastRunAt)}` : ''} · at most 2 starts a check and 5 a day; each choice is in
              the Activity panel.
            </p>
          )}
          {watchError && <p className="wd-start-note wd-tab-error">{watchError}</p>}
        </div>
      )}
    </div>
  );
}

/** What the Jira watch did with this issue, under its row; a suggestion can be started or dismissed. */
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
        ▶ started by itself in {d.target}
        {d.sessionId && onOpenSession && (
          <Button variant="link" onClick={() => onOpenSession(d.sessionId!)}>
            open
          </Button>
        )}
      </span>
    );
  }
  if (d.action === 'suggested' || d.action === 'failed') {
    return (
      <div className="wd-jira-watch wd-jira-watch-ask">
        <span title={d.reason}>
          {d.action === 'failed'
            ? `⚠ couldn't start it: ${d.reason}`
            : d.target
              ? `not started by itself — it would go in ${d.target}`
              : '? not sure where it belongs'}
        </span>
        <span className="wd-jira-watch-actions">
          <Select compact value={target} onChange={(e) => setTarget(e.target.value)} disabled={busy} aria-label={`Project for ${d.key}`}>
            {targets.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </Select>
          <Button variant="primary" size="sm" disabled={busy || !target} onClick={() => run(() => startJiraIssue(d.key, target))}>
            {busy ? 'Starting…' : `Start in ${target || '…'}`}
          </Button>
          <Button size="sm" disabled={busy} onClick={() => run(() => dismissJiraIssue(d.key))} title="Not this one">
            Dismiss
          </Button>
        </span>
        {error && <span className="wd-jira-watch-error">{error}</span>}
      </div>
    );
  }
  return null; // skipped (it has a session: the row says so), dismissed, baseline
}
