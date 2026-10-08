import { useState } from 'react';
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

/** The repos the PRs are in, with how many each, most first. Pure. */
export function repoCounts(prs: PrInfo[]): Array<{ repo: string; count: number }> {
  const n = new Map<string, number>();
  for (const p of prs) n.set(p.repoAlias, (n.get(p.repoAlias) ?? 0) + 1);
  return [...n].map(([repo, count]) => ({ repo, count })).sort((a, b) => b.count - a.count || a.repo.localeCompare(b.repo));
}

/** Only the PRs in the chosen repos; none chosen (or none of them there any more) is all. Pure. */
export function inRepos(prs: PrInfo[], chosen: readonly string[]): PrInfo[] {
  const live = chosen.filter((r) => prs.some((p) => p.repoAlias === r));
  return live.length ? prs.filter((p) => live.includes(p.repoAlias)) : prs;
}

/** The repos chosen on Start, remembered per browser (a convenience: gone in a private window, that's fine). */
const REPOS_KEY = 'work:start-repos';
function storedRepos(): string[] {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(REPOS_KEY) ?? '[]');
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}
function storeRepos(repos: string[]): void {
  try {
    localStorage.setItem(REPOS_KEY, JSON.stringify(repos));
  } catch {
    /* storage unavailable: the choice lasts this visit */
  }
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
  const allMine = (prs ?? []).filter((p) => p.isMine);
  const allToReview = (prs ?? []).filter(waitsForYourReview);
  // Quick filter by repo, over both lists: a chip per repo, several at once; none is all.
  const counts = repoCounts([...allMine, ...allToReview]);
  const [chosenRepos, setChosenRepos] = useState<string[]>(storedRepos);
  const active = chosenRepos.filter((r) => counts.some((c) => c.repo === r));
  const choose = (next: string[]) => {
    setChosenRepos(next);
    storeRepos(next);
  };
  const toggle = (repo: string) => choose(active.includes(repo) ? active.filter((r) => r !== repo) : [...active, repo]);
  const mine = inRepos(allMine, active);
  const toReview = inRepos(allToReview, active);

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

      {counts.length > 1 && (
        <div className="wd-start-filter" role="group" aria-label="Show pull requests in">
          <button type="button" className="wd-start-chip" aria-pressed={active.length === 0} onClick={() => choose([])}>
            All
          </button>
          {counts.map((c) => (
            <button
              key={c.repo}
              type="button"
              className="wd-start-chip"
              aria-pressed={active.includes(c.repo)}
              onClick={() => toggle(c.repo)}
              title={
                active.includes(c.repo)
                  ? `Stop showing only ${c.repo}`
                  : `Show ${c.repo}'s pull requests${active.length ? ' too' : ' only'}`
              }
            >
              {c.repo} <span className="wd-start-chip-count">{c.count}</span>
            </button>
          ))}
        </div>
      )}

      <section className="wd-start-section" aria-label="Your pull requests">
        <h2 className="wd-start-title">Your pull requests · GitHub</h2>
        {prNote && <p className="wd-start-note">{prNote}</p>}
        {!prNote && prs === null && <p className="wd-start-note">Loading…</p>}
        {!prNote && prs !== null && mine.length === 0 && (
          <p className="wd-start-note">
            {active.length ? `No open pull requests of yours in ${active.join(', ')}.` : 'No open pull requests of yours.'}
          </p>
        )}
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
          <li key={`${pr.repoAlias}#${pr.number}`} className="wd-start-row wd-start-row-pr">
            <a className="wd-start-key wd-start-key-pr" href={pr.url} target="_blank" rel="noreferrer" title="Open on GitHub">
              #{pr.number}
            </a>
            <span className="wd-start-what" title={!pr.isMine && pr.author ? `${pr.title} — by @${pr.author}` : pr.title}>
              <span className="wd-start-pr-title">{pr.title}</span>
              {!pr.isMine && pr.author && <span className="wd-start-author">· by @{pr.author}</span>}
            </span>
            <span className="wd-start-repo" title={pr.repoAlias}>
              {pr.repoAlias}
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
