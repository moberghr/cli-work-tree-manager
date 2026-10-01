import { useState } from 'react';
import { sendPromptToSession, updateFromMain, type SessionSummary, type UpdateFromMainResult } from '../../api/client.js';

/** Fewer commits behind than this, and only a conflict is worth a word. */
export const BEHIND_SHOWN_AT = 10;

/** "↓ 34 behind origin/main" — for tooltips. Null when it isn't worth saying. */
export function behindText(s: SessionSummary): string | null {
  const b = s.behind;
  if (!b || (b.commits < BEHIND_SHOWN_AT && !b.conflicts)) return null;
  return `↓ ${b.commits} behind ${b.base}${b.conflicts ? ' · conflicts' : ''}`;
}

/** What Claude is told when updating hit conflicts. */
export function resolvePrompt(base: string): string {
  return `Bring this branch up to date with ${base}: fetch, then rebase on it if the branch was never pushed, or merge it in if it was. Resolve the conflicts, run the tests, and commit. If a conflict needs a decision from me, start a line with DECISION NEEDED: and ask.`;
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
        setOutcome(describe(results));
      },
      (err: Error) => {
        setBusy(false);
        setOutcome({ text: err.message, error: true });
      },
    );
  };
  const ask = (base: string) =>
    void sendPromptToSession(session.id, resolvePrompt(base)).then(
      () => setOutcome({ text: 'Asked its Claude to update and resolve the conflicts.' }),
      (err: Error) => setOutcome({ text: err.message, error: true }),
    );
  return (
    <span className={'wd-behind' + (session.behind?.conflicts ? ' wd-behind-conflicts' : '')}>
      {text && (
        <span className="wd-behind-text" title={`As of the last fetch. ${session.behind?.conflicts ? 'Merging it would conflict.' : ''}`}>
          {session.behind?.conflicts ? '⚠ ' : ''}
          {text}
        </span>
      )}
      {text && (
        <button type="button" className="wd-session-detail-btn" disabled={busy} onClick={run} title="Fetch, then rebase (a branch never pushed) or merge main in (a pushed one). Conflicts are aborted, not left in the worktree.">
          {busy ? 'Updating…' : 'Update from main'}
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

function describe(results: UpdateFromMainResult[]): { text: string; conflictBase?: string; error?: boolean } {
  const conflict = results.find((r) => !r.ok && r.conflicts);
  if (conflict && !conflict.ok) return { text: `${conflict.repo}: ${conflict.reason} — nothing was changed.`, conflictBase: conflict.base, error: true };
  const failed = results.find((r) => !r.ok);
  if (failed && !failed.ok) return { text: `${failed.repo}: ${failed.reason}`, error: true };
  const done = results.filter((r): r is Extract<UpdateFromMainResult, { ok: true }> => r.ok && r.how !== 'nothing');
  if (done.length === 0) return { text: 'Already up to date.' };
  return { text: done.map((r) => `${r.repo}: ${r.how === 'rebase' ? 'rebased on' : 'merged'} ${r.base} (${r.commits} commit${r.commits === 1 ? '' : 's'})`).join('; ') + '.' };
}
