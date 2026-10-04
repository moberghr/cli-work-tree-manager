import { useEffect, useMemo, useState } from 'react';
import { columnOrder } from '../../../../../core/jira/jira-board.js';
import {
  dismissJiraIssue,
  fetchJira,
  fetchJiraWatch,
  setJiraWatch,
  startJiraIssue,
  type JiraDecision,
  type JiraIssue,
  type JiraWatchState,
  type PrInfo,
} from '../../../api/panes.js';
import type { SessionSummary } from '../../../api/client.js';
import { useSse } from '../../../api/events.js';
import { isArchived, prsForSession } from '../../../state/session-display.js';
import { sessionIsForIssue } from '../../../../../core/jira/jira-prompt.js';
import { relativeTime } from '../../../utils/time.js';

interface Props {
  sessions: SessionSummary[];
  onNewWorktree: () => void;
  /** Start from a Jira issue or a PR: the New worktree dialog, filled in. */
  onPickIssue: (issue: JiraIssue) => void;
  onPickPr: (pr: PrInfo) => void;
  onOpenSession: (id: string) => void;
  /** The Repos page (which repos work knows, groups). */
  onManageRepos?: () => void;
  /** The dashboard's open-PR list (one poll for every view); null until it came. */
  prs: PrInfo[] | null;
  /** Why there is no list: gh missing, an error. */
  prsNote?: string | null;
  /** The configured groups' repos (a group session claims only their PRs). */
  membersOf?: (group: string) => string[] | undefined;
  /** Test seam; defaults to the API. */
  loadJira?: typeof fetchJira;
}

/** A PR in a word or two, and how it reads: "Checks failing", "Approved"… Pure. */
export function prState(pr: PrInfo): { text: string; tone: 'bad' | 'good' | 'muted' } {
  if (pr.isDraft) return { text: 'Draft', tone: 'muted' };
  if (pr.conflicting) return { text: 'Merge conflict', tone: 'bad' };
  if (pr.checksStatus === 'FAILURE') return { text: 'Checks failing', tone: 'bad' };
  if (pr.reviewDecision === 'CHANGES_REQUESTED') return { text: 'Changes requested', tone: 'bad' };
  if (pr.reviewDecision === 'APPROVED') return { text: 'Approved', tone: 'good' };
  if (pr.checksStatus === 'PENDING') return { text: 'Checks running', tone: 'muted' };
  if (pr.reviewDecision === 'REVIEW_REQUIRED') return { text: 'Review needed', tone: 'muted' };
  return { text: 'Open', tone: 'muted' };
}

/** The live session already working on this PR's branch, if any. Pure. */
export function sessionForPr(
  pr: PrInfo,
  sessions: SessionSummary[],
  membersOf?: (group: string) => string[] | undefined,
): SessionSummary | undefined {
  return sessions.find((s) => !isArchived(s) && prsForSession(s, [pr], membersOf).length > 0);
}

/** Someone else's PR that asks for your review (by name), and you haven't reviewed yet. Pure. */
export function waitsForYourReview(pr: PrInfo): boolean {
  return !pr.isMine && !!pr.reviewRequested && pr.myReview === 'NONE';
}

/** The live session made for this issue, if any. Pure. */
export function sessionForIssue(issue: JiraIssue, sessions: SessionSummary[]): SessionSummary | undefined {
  return sessions.find((s) => !isArchived(s) && sessionIsForIssue(s, issue));
}

/**
 * Start: where new work comes from. New worktree on top; then the Jira
 * issues assigned to you and your pull requests (and ones waiting for your
 * review), each with Start — the New worktree dialog, filled in — or a link
 * to the session already on it; then the switch that starts newly assigned
 * issues by themselves (the Jira watch).
 */
export function StartTab({
  sessions,
  onNewWorktree,
  onPickIssue,
  onPickPr,
  onOpenSession,
  onManageRepos,
  prs,
  prsNote: prNote = null,
  membersOf,
  loadJira = fetchJira,
}: Props) {
  const [issues, setIssues] = useState<JiraIssue[] | null>(null);
  const [jiraNote, setJiraNote] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    const load = () => {
      loadJira().then(
        (r) => {
          if (!live) return;
          setIssues(r.issues);
          setJiraNote(r.available === false ? 'acli isn’t available or logged in.' : (r.error ?? null));
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
  const mine = (prs ?? []).filter((p) => p.isMine);
  const toReview = (prs ?? []).filter(waitsForYourReview);

  const existing = (s: SessionSummary | undefined) =>
    s ? (
      <button type="button" className="wd-link-button wd-start-existing" onClick={() => onOpenSession(s.id)} title="Open the session on it">
        {s.titleIsYours && s.title ? s.title : s.branch} →
      </button>
    ) : null;

  return (
    <div className="wd-dash-tab-pane wd-tab-start">
      <header className="wd-tab-header">
        <h1>Start work</h1>
        <div className="wd-tab-controls">
          {onManageRepos && (
            <button type="button" className="wd-btn-secondary" onClick={onManageRepos}>
              Repos & groups
            </button>
          )}
          <button type="button" className="wd-btn-primary" onClick={onNewWorktree}>
            New worktree
          </button>
        </div>
      </header>

      <section className="wd-start-section" aria-label="Jira issues assigned to you">
        <h2 className="wd-start-title">Assigned to you · Jira</h2>
        {jiraNote && <p className="wd-start-note">{jiraNote}</p>}
        {!jiraNote && issues === null && <p className="wd-start-note">Loading…</p>}
        {!jiraNote && issues !== null && ordered.length === 0 && <p className="wd-start-note">Nothing assigned to you.</p>}
        <ul className="wd-start-list">
          {ordered.map((i) => {
            const decision = decisions.get(i.key);
            return (
              <li key={i.key} className="wd-start-row">
                <a className="wd-start-key" href={i.url} target="_blank" rel="noreferrer" title="Open in Jira">
                  {i.key}
                </a>
                <span className="wd-start-what" title={i.summary}>
                  {i.summary}
                </span>
                <span className="wd-start-state">{i.status}</span>
                <span className="wd-start-action">
                  {existing(sessionForIssue(i, sessions)) ?? (
                    <button type="button" className="wd-btn-secondary" onClick={() => onPickIssue(i)}>
                      Start
                    </button>
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

      <section className="wd-start-section" aria-label="Your pull requests">
        <h2 className="wd-start-title">Your pull requests · GitHub</h2>
        {prNote && <p className="wd-start-note">{prNote}</p>}
        {!prNote && prs === null && <p className="wd-start-note">Loading…</p>}
        {!prNote && prs !== null && mine.length === 0 && <p className="wd-start-note">No open pull requests of yours.</p>}
        <PrList prs={mine} sessions={sessions} onPick={onPickPr} existing={existing} membersOf={membersOf} />
      </section>

      {toReview.length > 0 && (
        <section className="wd-start-section" aria-label="Waiting for your review">
          <h2 className="wd-start-title">Waiting for your review · GitHub</h2>
          <PrList prs={toReview} sessions={sessions} onPick={onPickPr} existing={existing} membersOf={membersOf} />
        </section>
      )}

      {watch && (
        <div className="wd-start-watch">
          <label
            className="wd-jira-watch-switch"
            title="When an issue is assigned to you, an AI picks the project it belongs in and work starts a session on it (feat/<KEY>). Not sure, it suggests one here for you to start. Issues assigned before you turned it on are left alone."
          >
            <input type="checkbox" checked={watch.settings.enabled} disabled={switching} onChange={(e) => toggle(e.target.checked)} /> Start
            newly assigned Jira issues by themselves
          </label>
          {watch.settings.enabled && (
            <p className="wd-start-note">
              Watching since {ago(watch.settings.since ?? '')}
              {watch.lastRunAt ? ` · last check ${ago(watch.lastRunAt)}` : ''} · at most 2 starts a check and 5 a day; each choice is in the
              Activity panel.
            </p>
          )}
          {watchError && <p className="wd-start-note wd-tab-error">{watchError}</p>}
        </div>
      )}
    </div>
  );
}

function PrList({
  prs,
  sessions,
  onPick,
  existing,
  membersOf,
}: {
  prs: PrInfo[];
  sessions: SessionSummary[];
  onPick: (pr: PrInfo) => void;
  existing: (s: SessionSummary | undefined) => React.ReactNode;
  membersOf?: (group: string) => string[] | undefined;
}) {
  return (
    <ul className="wd-start-list">
      {prs.map((pr) => {
        const state = prState(pr);
        return (
          <li key={`${pr.repoAlias}#${pr.number}`} className="wd-start-row">
            <a className="wd-start-key wd-start-key-pr" href={pr.url} target="_blank" rel="noreferrer" title="Open on GitHub">
              #{pr.number}
            </a>
            <span className="wd-start-what" title={pr.title}>
              {pr.title} <span className="wd-start-repo">{pr.repoAlias}</span>
            </span>
            <span className={`wd-start-state wd-start-state-${state.tone}`}>{state.text}</span>
            <span className="wd-start-action">
              {existing(sessionForPr(pr, sessions, membersOf)) ?? (
                <button
                  type="button"
                  className="wd-btn-secondary"
                  onClick={() => onPick(pr)}
                  title={
                    pr.isMine ? 'Continue on it in a worktree' : 'Have Claude review it in a worktree (it changes nothing, posts nothing)'
                  }
                >
                  {pr.isMine ? 'Start' : 'Review'}
                </button>
              )}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

/** "4m ago", or "just now". */
function ago(iso: string): string {
  const t = relativeTime(iso);
  return t === 'just now' || t === '' ? t : `${t} ago`;
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
          <button type="button" className="wd-link-button" onClick={() => onOpenSession(d.sessionId!)}>
            open
          </button>
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
            : `? not sure where it belongs${d.target ? ` — maybe ${d.target}` : ''}`}
        </span>
        <span className="wd-jira-watch-actions">
          <select value={target} onChange={(e) => setTarget(e.target.value)} disabled={busy} aria-label={`Project for ${d.key}`}>
            {targets.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="wd-btn-primary"
            disabled={busy || !target}
            onClick={() => run(() => startJiraIssue(d.key, target))}
          >
            {busy ? 'Starting…' : `Start in ${target || '…'}`}
          </button>
          <button
            type="button"
            className="wd-btn-secondary"
            disabled={busy}
            onClick={() => run(() => dismissJiraIssue(d.key))}
            title="Not this one"
          >
            Dismiss
          </button>
        </span>
        {error && <span className="wd-jira-watch-error">{error}</span>}
      </div>
    );
  }
  return null; // skipped (it has a session: the row says so), dismissed, baseline
}
