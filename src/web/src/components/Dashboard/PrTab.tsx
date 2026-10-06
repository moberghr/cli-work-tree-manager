import { useCallback, useEffect, useMemo, useState } from 'react';
import { askClaudeToFixCi, fetchSessionCi, sendPromptToSession, type SessionCi, type SessionSummary } from '../../api/client.js';
import type { PrInfo } from '../../api/panes.js';
import { useSse } from '../../api/events.js';
import { stagePhrase, stageTone } from '../../../../core/pr/pr-stage.js';
import { DEFAULT_PROMPTS } from '../../../../core/sessions/saved-prompts.js';
import { orderedSections, prName, prSections, type PrSection } from '../../state/pr-tab.js';
import { askableThreads, askToReplyAllPrompt, ReplyList, useReplies } from './ReplyDrafts.js';
import { relativeTime } from '../../utils/time.js';
import type { OpenReviewThread, PrReply } from '../../../../core/api-types.js';

const POLL_MS = 60_000;

/** The session's PR checks and review threads from the PR watch, kept fresh (`ci-changed`, and a minute's poll). */
function useSessionCi(sessionId: string) {
  const [ci, setCi] = useState<SessionCi | null>(null);
  const load = useCallback(() => {
    fetchSessionCi(sessionId).then(setCi, () => {});
  }, [sessionId]);
  useEffect(() => {
    setCi(null);
    load();
    const t = setInterval(load, POLL_MS);
    return () => clearInterval(t);
  }, [load]);
  useSse('/events', {
    events: {
      'ci-changed': (d) => {
        if ((d as { sessionId?: string } | null)?.sessionId === sessionId) load();
      },
    },
  });
  return ci;
}

/**
 * The session's PR tab: everything about its pull requests in one place, one
 * section per PR (a group has one per repo; a branch can have two). What
 * wants you comes first and open; merged and quiet ones are folded. On top,
 * one action for every thread with no reply across them; in each, its stage,
 * checks (failing ones linked, with Ask Claude to fix), and its review
 * threads and drafts. Ship… opens the Ship panel (every repo's merge).
 */
export function PrTab({ session, prs, onShip }: { session: SessionSummary; prs: PrInfo[]; onShip: () => void }) {
  const ci = useSessionCi(session.id);
  const { replies, waiting, load } = useReplies(session.id);
  const sections = useMemo(() => orderedSections(prSections(ci, prs), waiting, replies), [ci, prs, waiting, replies]);
  const isGroup = session.isGroup;
  // The threads no section claims (a PR the watch no longer lists): still shown, below.
  const claimed = new Set(sections.flatMap((s) => [...s.waiting.map((t) => t.threadId), ...s.replies.map((r) => r.threadId)]));
  const strayWaiting = waiting.filter((t) => !claimed.has(t.threadId));
  const strayReplies = replies.filter((r) => !claimed.has(r.threadId));
  const wants = sections.reduce((n, s) => n + s.wants, 0) + strayWaiting.length;

  if (ci === null && sections.length === 0) return <div className="wd-pr-tab wd-web-muted">Loading its pull requests…</div>;
  if (sections.length === 0 && waiting.length === 0 && replies.length === 0) return <NoPr session={session} />;

  return (
    <div className="wd-pr-tab">
      <AllThreads sessionId={session.id} waiting={waiting} wants={wants} prs={sections.length} />
      {sections.map((s) => (
        <PrSectionView
          key={s.section.key}
          sessionId={session.id}
          s={s.section}
          isGroup={isGroup}
          wants={s.wants}
          waiting={s.waiting}
          replies={s.replies}
          onRepliesChanged={load}
          onShip={onShip}
        />
      ))}
      {(strayWaiting.length > 0 || strayReplies.some((r) => r.status === 'draft')) && (
        <section className="wd-pr-section">
          <h3 className="wd-pr-section-title">Other review threads</h3>
          <ReplyList sessionId={session.id} replies={strayReplies} waiting={strayWaiting} onDone={load} />
        </section>
      )}
    </div>
  );
}

/** On top: how much wants you, and one Ask for every thread with no reply, across the PRs. */
function AllThreads({ sessionId, waiting, wants, prs }: { sessionId: string; waiting: OpenReviewThread[]; wants: number; prs: number }) {
  const [asked, setAsked] = useState<ReadonlySet<string>>(new Set());
  const [asking, setAsking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const askable = askableThreads(waiting, asked);
  const trusted = waiting.filter((t) => t.trusted === true).length;
  return (
    <div className="wd-pr-summary">
      <span className={wants ? 'wd-pr-summary-wants' : 'wd-web-muted'}>
        {wants ? `${wants} thing${wants === 1 ? '' : 's'} want${wants === 1 ? 's' : ''} you` : 'Nothing waits on you'}
        {prs > 1 ? ` across ${prs} PRs` : ''}
      </span>
      {trusted > 0 && (
        <button
          type="button"
          className="wd-btn-primary"
          disabled={asking || askable.length === 0}
          title="One note to its Claude: plan a change and draft a reply for each thread — it changes, pushes and posts nothing until you say yes"
          onClick={() => {
            setAsking(true);
            setError(null);
            sendPromptToSession(sessionId, askToReplyAllPrompt(askable))
              .then(
                () => setAsked((prev) => new Set([...prev, ...askable.map((t) => t.threadId)])),
                (e: Error) => setError(e.message),
              )
              .finally(() => setAsking(false));
          }}
        >
          {asking
            ? 'Asking…'
            : askable.length === 0
              ? 'Asked — the drafts will show here'
              : `Ask Claude about ${askable.length === trusted ? 'all ' : ''}${askable.length} thread${askable.length === 1 ? '' : 's'}`}
        </button>
      )}
      {error && (
        <span className="wd-tab-error" role="alert">
          {error}
        </span>
      )}
    </div>
  );
}

function PrSectionView({
  sessionId,
  s,
  isGroup,
  wants,
  waiting,
  replies,
  onRepliesChanged,
  onShip,
}: {
  sessionId: string;
  s: PrSection;
  isGroup: boolean;
  wants: number;
  waiting: OpenReviewThread[];
  replies: PrReply[];
  onRepliesChanged: () => void;
  onShip: () => void;
}) {
  const open = s.state === 'OPEN';
  const [unfolded, setUnfolded] = useState(open || wants > 0);
  return (
    <section className={'wd-pr-section' + (wants ? ' wd-pr-section-wants' : '')} aria-label={`Pull request ${prName(s, isGroup)}`}>
      <div className="wd-pr-section-head">
        <button type="button" className="wd-pr-fold" aria-expanded={unfolded} onClick={() => setUnfolded((u) => !u)}>
          {unfolded ? '▾' : '▸'}
        </button>
        <strong className="wd-pr-name">{prName(s, isGroup)}</strong>
        {s.title && <span className="wd-pr-title">{s.title}</span>}
        <span className={`wd-pr-stage wd-pr-stage-${stageTone(s.kind)}`}>
          {stagePhrase(s.kind)}
          {s.state === 'MERGED' && s.mergedAt ? ` ${relativeTime(s.mergedAt)} ago` : ''}
        </span>
        {wants > 0 && <span className="wd-session-subtab-badge">{wants}</span>}
        <a className="wd-pr-link" href={s.url} target="_blank" rel="noopener noreferrer" title="Open it on GitHub">
          ↗
        </a>
      </div>
      {unfolded && (
        <div className="wd-pr-section-body">
          {open && <Checks sessionId={sessionId} s={s} />}
          {open && !s.fromListOnly && (
            <div className="wd-pr-actions">
              <button type="button" className="wd-btn-secondary" onClick={onShip} title="Push, open or merge — every repo of the session">
                Ship…
              </button>
            </div>
          )}
          <ReplyList sessionId={sessionId} replies={replies} waiting={waiting} onDone={onRepliesChanged} />
        </div>
      )}
    </section>
  );
}

/** Its checks in a line: passing, running, or failing by name (linked), with Ask Claude to fix. */
function Checks({ sessionId, s }: { sessionId: string; s: PrSection }) {
  const [state, setState] = useState<'idle' | 'sending' | 'sent'>('idle');
  const [error, setError] = useState<string | null>(null);
  if (s.checks === 'none') return null;
  if (s.checks !== 'fail')
    return <p className="wd-pr-checks wd-web-muted">{s.checks === 'pass' ? '✓ Checks passing' : '● Checks running'}</p>;
  return (
    <p className="wd-pr-checks wd-pr-checks-fail" role="status">
      <span aria-hidden="true">✗</span> Checks failing
      {s.failing.length ? ': ' : ''}
      {s.failing.map((f, i) => (
        <span key={f.name + i}>
          {i > 0 && ', '}
          {f.url ? (
            <a href={f.url} target="_blank" rel="noopener noreferrer">
              {f.name}
            </a>
          ) : (
            f.name
          )}
        </span>
      ))}{' '}
      {!s.fromListOnly &&
        (state === 'sent' ? (
          <span className="wd-web-muted">Sent to Claude ✓</span>
        ) : (
          <button
            type="button"
            className="wd-btn-secondary"
            disabled={state === 'sending'}
            onClick={() => {
              setState('sending');
              setError(null);
              askClaudeToFixCi(sessionId).then(
                () => setState('sent'),
                (e: Error) => {
                  setError(e.message);
                  setState('idle');
                },
              );
            }}
          >
            {state === 'sending' ? 'Sending…' : 'Ask Claude to fix'}
          </button>
        ))}
      {error && (
        <span className="wd-tab-error" role="alert">
          {' '}
          {error}
        </span>
      )}
    </p>
  );
}

/** No pull request yet: say so, and offer Claude's "Open a pull request". */
function NoPr({ session }: { session: SessionSummary }) {
  const [state, setState] = useState<'idle' | 'sending' | 'sent'>('idle');
  const [error, setError] = useState<string | null>(null);
  const prompt = DEFAULT_PROMPTS.find((p) => p.label === 'Open a pull request')?.prompt;
  return (
    <div className="wd-pr-tab wd-pr-none">
      <p>No pull request yet.</p>
      {prompt && (
        <button
          type="button"
          className="wd-btn-secondary"
          disabled={state !== 'idle'}
          onClick={() => {
            setState('sending');
            setError(null);
            sendPromptToSession(session.id, prompt).then(
              () => setState('sent'),
              (e: Error) => {
                setError(e.message);
                setState('idle');
              },
            );
          }}
          title="Ask its Claude to push the branch and open a PR, written from your conversation"
        >
          {state === 'sending' ? 'Asking…' : state === 'sent' ? 'Asked — it will show here' : 'Open a pull request'}
        </button>
      )}
      {error && (
        <p className="wd-tab-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
