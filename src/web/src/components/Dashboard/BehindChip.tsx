import { useState } from 'react';
import { retargetSession, sendPromptToSession, updateFromMain, type SessionSummary, type UpdateFromMainResult } from '../../api/client.js';

/** Fewer commits behind than this, and only a conflict is worth a word. */
export const BEHIND_SHOWN_AT = 10;

/** "↓ 34 behind origin/main" — for tooltips. Null when it isn't worth saying. A stacked
 *  session's parent (stack.ts) is worth it from one commit: it's the work it builds on. */
export function behindText(s: SessionSummary): string | null {
  const b = s.behind;
  if (!b || (b.commits < (b.stacked ? 1 : BEHIND_SHOWN_AT) && !b.conflicts)) return null;
  return `↓ ${b.commits} behind ${b.base}${b.conflicts ? ' · conflicts' : ''}`;
}

/** What Claude is told when updating hit conflicts. */
export function resolvePrompt(base: string, stacked = false): string {
  return stacked
    ? `Bring this branch up to date with ${base}, the branch this one is stacked on (a local branch: nothing to fetch): rebase on it if this branch was never pushed, or merge it in if it was. Resolve the conflicts, run the tests, and commit. If a conflict needs a decision from me, start a line with DECISION NEEDED: and ask.`
    : `Bring this branch up to date with ${base}: fetch, then rebase on it if the branch was never pushed, or merge it in if it was. Resolve the conflicts, run the tests, and commit. If a conflict needs a decision from me, start a line with DECISION NEEDED: and ask.`;
}

/**
 * In the session header, when its branch has fallen behind main (or would
 * conflict with it): how far, and "Update from main" (behind-main.ts). A
 * conflict is aborted on the spot; "Ask Claude to resolve" hands it over.
 */
export function BehindChip({ session }: { session: SessionSummary }) {
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<{ text: string; conflictBase?: string; error?: boolean } | null>(null);
  const text = behindText(session);
  if (!text && !outcome) return null;
  const run = () => {
    setBusy(true);
    setOutcome(null);
    updateFromMain(session.id).then(
      (results) => {
        setBusy(false);
        setOutcome(describeUpdate(results));
      },
      (err: Error) => {
        setBusy(false);
        setOutcome({ text: err.message, error: true });
      },
    );
  };
  const stacked = !!session.behind?.stacked;
  const ask = (base: string) =>
    void sendPromptToSession(session.id, resolvePrompt(base, stacked)).then(
      () => setOutcome({ text: 'Asked its Claude to update and resolve the conflicts.' }),
      (err: Error) => setOutcome({ text: err.message, error: true }),
    );
  return (
    <span className={'wd-behind' + (session.behind?.conflicts ? ' wd-behind-conflicts' : '')}>
      {text && (
        <span
          className="wd-behind-text"
          title={`${stacked ? `${session.behind?.base} is the session this one is stacked on.` : 'As of the last fetch.'} ${session.behind?.conflicts ? 'Merging it would conflict.' : ''}`}
        >
          {session.behind?.conflicts ? '⚠ ' : ''}
          {text}
        </span>
      )}
      {text && (
        <button
          type="button"
          className="wd-session-detail-btn"
          disabled={busy}
          onClick={run}
          title={`${stacked ? 'Rebase on it' : 'Fetch, then rebase'} (a branch never pushed) or merge it in (a pushed one). Conflicts are aborted, not left in the worktree.`}
        >
          {busy ? 'Updating…' : stacked ? `Update from ${session.behind?.base}` : 'Update from main'}
        </button>
      )}
      {outcome && (
        <span className={'wd-behind-outcome' + (outcome.error ? ' wd-tab-error' : '')} role="status">
          {outcome.text}
          {outcome.conflictBase && (
            <button type="button" className="wd-link-button" onClick={() => ask(outcome.conflictBase!)}>
              Ask Claude to resolve
            </button>
          )}
        </span>
      )}
    </span>
  );
}

export function describeUpdate(results: UpdateFromMainResult[]): { text: string; conflictBase?: string; error?: boolean } {
  const done = results.filter((r): r is Extract<UpdateFromMainResult, { ok: true }> => r.ok && r.how !== 'nothing');
  const doneText = done
    .map((r) => `${r.repo}: ${r.how === 'rebase' ? 'rebased on' : 'merged'} ${r.base} (${r.commits} commit${r.commits === 1 ? '' : 's'})`)
    .join('; ');
  // A group updates repo by repo: say what did change before what didn't.
  const before = doneText ? `${doneText}. But ` : '';
  const conflict = results.find((r) => !r.ok && (r.conflicts || r.handOff));
  if (conflict && !conflict.ok)
    return { text: `${before}${conflict.repo}: ${conflict.reason} — left as it was.`, conflictBase: conflict.base, error: true };
  const failed = results.find((r) => !r.ok);
  if (failed && !failed.ok) return { text: `${before}${failed.repo}: ${failed.reason}`, error: true };
  if (done.length === 0) return { text: 'Already up to date.' };
  return { text: doneText + '.' };
}

/**
 * A stacked session whose parent merged and is archived (stack-retarget.ts):
 * "was on feat/x — merged" and Move onto main, which replays only its own
 * commits onto main (a pushed branch: main merged in). It happens by itself
 * after its next turn when git says it goes cleanly; this is for now.
 */
export function MergedParentChip({ session }: { session: SessionSummary }) {
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<{ text: string; conflictBase?: string; error?: boolean } | null>(null);
  const merged = session.stackParentMerged;
  if (!merged && !outcome) return null;
  const run = () => {
    setBusy(true);
    setOutcome(null);
    retargetSession(session.id).then(
      (results) => {
        setBusy(false);
        setOutcome(describeUpdate(results));
      },
      (err: Error) => {
        setBusy(false);
        setOutcome({ text: err.message, error: true });
      },
    );
  };
  const ask = (base: string) =>
    void sendPromptToSession(
      session.id,
      `${merged?.branch ?? 'The branch this one was stacked on'} has merged into ${base}. Move this branch onto ${base} keeping only its own commits (git rebase --onto ${base} <where it left ${merged?.branch ?? 'that branch'}>, if it was never pushed; else merge ${base} in). Resolve the conflicts, run the tests, and commit. If a conflict needs a decision from me, start a line with DECISION NEEDED: and ask.`,
    ).then(
      () => setOutcome({ text: 'Asked its Claude to move it onto main and resolve the conflicts.' }),
      (err: Error) => setOutcome({ text: err.message, error: true }),
    );
  return (
    <span className="wd-behind">
      {merged && (
        <span className="wd-behind-text" title={`${merged.branch}, the session this one was stacked on, merged and was archived.`}>
          ⤷ was on {merged.branch} — merged
        </span>
      )}
      {merged && (
        <button
          type="button"
          className="wd-session-detail-btn"
          disabled={busy}
          onClick={run}
          title="Replay only this branch's own commits onto main (a pushed branch: merge main in). Conflicts are aborted, not left in the worktree."
        >
          {busy ? 'Moving…' : 'Move onto main'}
        </button>
      )}
      {outcome && (
        <span className={'wd-behind-outcome' + (outcome.error ? ' wd-tab-error' : '')} role="status">
          {outcome.text}
          {outcome.conflictBase && (
            <button type="button" className="wd-link-button" onClick={() => ask(outcome.conflictBase!)}>
              Ask Claude to resolve
            </button>
          )}
        </span>
      )}
    </span>
  );
}
