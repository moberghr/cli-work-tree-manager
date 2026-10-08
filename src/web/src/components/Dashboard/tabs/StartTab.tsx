import type { PrInfo } from '../../../api/panes.js';
import type { SessionSummary } from '../../../api/client.js';
import { isArchived, prsForSession } from '../../../state/session-display.js';

interface Props {
  sessions: SessionSummary[];
  onNewWorktree: () => void;
  /** Start from a PR: the New worktree dialog, filled in. */
  onPickPr: (pr: PrInfo) => void;
  /** Work on someone else's PR, on their branch (what you push lands in it): the dialog, filled in. */
  onWorkOnPr?: (pr: PrInfo) => void;
  onOpenSession: (id: string) => void;
  /** The Repos page (which repos work knows, groups). */
  onManageRepos?: () => void;
  /** The dashboard's open-PR list (one poll for every view); null until it came. */
  prs: PrInfo[] | null;
  /** Why there is no list: gh missing, an error. */
  prsNote?: string | null;
  /** The configured groups' repos (a group session claims only their PRs). */
  membersOf?: (group: string) => string[] | undefined;
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

/**
 * Start: where new work comes from. New worktree and the repos on top; then
 * your pull requests and the ones waiting for your review, each with Start
 * (or Review) — the New worktree dialog, filled in — or a link to the
 * session already on it. Jira issues have a page of their own (JiraTab).
 */
export function StartTab({
  sessions,
  onNewWorktree,
  onPickPr,
  onWorkOnPr,
  onOpenSession,
  onManageRepos,
  prs,
  prsNote: prNote = null,
  membersOf,
}: Props) {
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
          <PrList prs={toReview} sessions={sessions} onPick={onPickPr} onWork={onWorkOnPr} existing={existing} membersOf={membersOf} />
        </section>
      )}
    </div>
  );
}

function PrList({
  prs,
  sessions,
  onPick,
  onWork,
  existing,
  membersOf,
}: {
  prs: PrInfo[];
  sessions: SessionSummary[];
  onPick: (pr: PrInfo) => void;
  /** Someone else's PR: work on it, on their branch. */
  onWork?: (pr: PrInfo) => void;
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
            <span className="wd-start-what" title={!pr.isMine && pr.author ? `${pr.title} — by @${pr.author}` : pr.title}>
              <span className="wd-start-title">{pr.title}</span> <span className="wd-start-repo">{pr.repoAlias}</span>
              {!pr.isMine && pr.author && <span className="wd-start-author">· by @{pr.author}</span>}
            </span>
            <span className={`wd-start-state wd-start-state-${state.tone}`}>{state.text}</span>
            <span className="wd-start-action">
              {existing(sessionForPr(pr, sessions, membersOf)) ?? (
                <>
                  {onWork && !pr.isMine && (
                    <button
                      type="button"
                      className="wd-btn-secondary"
                      onClick={() => onWork(pr)}
                      disabled={pr.fork}
                      title={
                        pr.fork
                          ? "It comes from a fork: its branch isn't on origin, so a session couldn't push to it"
                          : `Work on it on ${pr.author ? `@${pr.author}'s` : 'their'} branch: what you push lands in their PR`
                      }
                    >
                      Work on it
                    </button>
                  )}
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
                </>
              )}
            </span>
          </li>
        );
      })}
    </ul>
  );
}
