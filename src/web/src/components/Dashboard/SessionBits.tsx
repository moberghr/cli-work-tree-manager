import type { SessionSummary } from '../../api/client.js';
import { StatusIcon } from './StatusIcon.js';
import type { PrInfo } from '../../api/panes.js';
import { DISPLAY_LABEL, displayStatus, formatDiffStat, agentName } from '../../state/session-display.js';
import { relativeTime } from '../../utils/time.js';
import { lastActiveAt, statusHint } from '../../state/session-display.js';

/**
 * Small shared pieces of a session's at-a-glance state, used by the rail,
 * the Sessions table, the Inbox and the session header so they all say
 * the same thing the same way.
 */

export function PrChips({ prs, link = false }: { prs: PrInfo[]; link?: boolean }) {
  if (prs.length === 0) return null;
  return (
    <>
      {prs.map((p) => {
        // A pill says one thing: this PR is open (or a draft). Its checks are
        // not shown here; failing CI has its own strip on the session.
        const label = `#${p.number}`;
        const title = `${p.repoAlias} #${p.number} — ${p.isDraft ? 'draft' : 'open'}: ${p.title}`;
        const cls = `wd-pr-chip${p.isDraft ? ' wd-pr-chip-draft' : ''}`;
        return link ? (
          <a
            key={`${p.repoAlias}#${p.number}`}
            className={cls}
            href={p.url}
            target="_blank"
            rel="noreferrer"
            title={title}
            onClick={(e) => e.stopPropagation()}
          >
            {label}
          </a>
        ) : (
          // Inside a row that is itself a button (the rail, the inbox), where a
          // link isn't allowed: opens the PR without also selecting the row.
          <span
            key={`${p.repoAlias}#${p.number}`}
            className={cls + ' wd-pr-chip-open'}
            title={`${title}\nClick to open on GitHub`}
            role="link"
            onClick={(e) => {
              e.stopPropagation();
              e.preventDefault();
              window.open(p.url, '_blank', 'noopener');
            }}
          >
            {label}
          </span>
        );
      })}
    </>
  );
}

export function DiffStatChip({ session }: { session: SessionSummary }) {
  const text = formatDiffStat(session);
  if (!text) return null;
  const d = session.diffStat!;
  return (
    <span className="wd-diffstat" title={`${d.files} file${d.files === 1 ? '' : 's'} changed`}>
      <span className="wd-diffstat-add">+{d.added}</span> <span className="wd-diffstat-del">−{d.deleted}</span>
    </span>
  );
}

export { formatTokens } from '../../utils/tokens.js';
import { formatTokens } from '../../utils/tokens.js';

/** Where a conversation's fill level starts to matter (shared with the PR watch's notes). */
export { CONTEXT_WARN, CONTEXT_FULL } from '../../state/session-display.js';
import { CONTEXT_FULL, CONTEXT_WARN } from '../../state/session-display.js';

/**
 * "Context 62%" with a small bar: how full the session's Claude
 * conversation is. Near the window Claude compacts it (and answers get
 * vaguer before that), so past 70% it's worth wrapping up and starting a
 * fresh conversation for the next task.
 */
export function ContextChip({ session, quiet = false }: { session: SessionSummary; quiet?: boolean }) {
  const c = session.context;
  if (!c || c.window <= 0) return null;
  const ratio = Math.min(1, c.used / c.window);
  const pct = Math.round(ratio * 100);
  const level = ratio >= CONTEXT_FULL ? 'full' : ratio >= CONTEXT_WARN ? 'warn' : 'ok';
  // Quiet (the session header): only once it's worth acting on.
  if (quiet && level === 'ok') return null;
  const advice =
    level === 'ok'
      ? ''
      : `\nNearly full: ${agentName(session)} will compact it soon. For the next task, start fresh (work tree … --fresh, or /clear).`;
  return (
    <span
      className={`wd-ctx wd-ctx-${level}`}
      title={`${formatTokens(c.used)} of ${formatTokens(c.window)} tokens in this conversation${c.model ? ` (${c.model})` : ''}.${advice}`}
    >
      <span className="wd-ctx-bar" aria-hidden>
        <span className="wd-ctx-fill" style={{ width: `${pct}%` }} />
      </span>
      Context {pct}%
    </span>
  );
}

/** Hover text: which files, shared with which session. */
export function overlapTitle(session: SessionSummary): string {
  return (
    (session.overlaps ?? [])
      .map((o) => {
        const more = o.count > o.files.length ? `, and ${o.count - o.files.length} more` : '';
        return `Also changed by ${o.target} · ${o.branch}:\n  ${o.files.map((f) => `${f.repo}/${f.path}`).join('\n  ')}${more}`;
      })
      .join('\n\n') + '\n\nThese will conflict when both merge.'
  );
}

/**
 * "⚠ Same files as chore/deps-update": another live session changes some
 * of the same files, so the second of the two to merge will conflict.
 * With `onOpen` (the session header) each name opens that session; in
 * rows (which are buttons themselves) it's plain text with the list on hover.
 */
/**
 * Where the session's Claude runs right now — your terminal, or the app —
 * and a warning when two run on one conversation. `compact` for the rail.
 */
export function ClaudesChip({ session, compact, quiet = false }: { session: SessionSummary; compact?: boolean; quiet?: boolean }) {
  const c = session.agents ?? session.claudes;
  if (!c) return null;
  // Quiet (the session header): running in the dashboard is the normal case;
  // say so only for two at once, or one in a terminal outside it.
  if (quiet && !c.duplicate && !c.inTerminal) return null;
  const name = agentName(session);
  const where = [
    c.inTerminal ? `${c.inTerminal > 1 ? `${c.inTerminal}× ` : ''}terminal` : '',
    c.inApp ? `${c.inApp > 1 ? `${c.inApp}× ` : ''}app` : '',
  ]
    .filter(Boolean)
    .join(' + ');
  const title = c.duplicate
    ? `More than one ${name} is running on this conversation. They would both write to it: close all but one (/exit in its terminal tab).`
    : `${name} is running (${c.busy ? 'busy' : 'at its prompt'}) in ${where}.`;
  if (c.duplicate) {
    return (
      <span className="wd-claudes wd-claudes-dup" title={title}>
        <span aria-hidden>⚠</span> {compact ? `2× ${name}` : `Two of ${name} on one conversation (${where})`}
      </span>
    );
  }
  return (
    <span className={'wd-claudes' + (c.busy ? ' wd-claudes-busy' : '')} title={title}>
      {compact ? (c.inTerminal ? '▣ terminal' : '▣ app') : `Running in ${where}`}
    </span>
  );
}

/**
 * Where it sits in a stack (stack.ts): "⤷ on feat/x" — the session it was
 * made from, whose new commits it takes in — and "2 stacked on this".
 */
export function StackChip({ session, onOpen }: { session: SessionSummary; onOpen?: (id: string) => void }) {
  const parent = session.stackedOn;
  const children = session.stackedChildren ?? 0;
  if (!parent && !children) return null;
  return (
    <span
      className="wd-stack"
      title="Stacked sessions: one made from another session's branch builds on it, and takes in its new commits (when idle and clean)."
    >
      {parent && (
        <span>
          <span aria-hidden>⤷</span> on{' '}
          {onOpen ? (
            <button type="button" className="wd-overlap-link" onClick={() => onOpen(parent.id)}>
              {parent.title ?? parent.branch}
            </button>
          ) : (
            <span className="wd-overlap-name">{parent.title ?? parent.branch}</span>
          )}
        </span>
      )}
      {parent && children > 0 && ' · '}
      {children > 0 && <span>{children} stacked on this</span>}
    </span>
  );
}

export function OverlapChip({ session, onOpen }: { session: SessionSummary; onOpen?: (id: string) => void }) {
  const list = session.overlaps ?? [];
  if (list.length === 0) return null;
  const files = list.reduce((n, o) => n + o.count, 0);
  return (
    <span className="wd-overlap" title={overlapTitle(session)}>
      <span aria-hidden>⚠</span> Same files as{' '}
      {list.slice(0, 2).map((o, i) => (
        <span key={o.sessionId}>
          {i > 0 && ', '}
          {onOpen ? (
            <button type="button" className="wd-overlap-link" onClick={() => onOpen(o.sessionId)}>
              {o.branch}
            </button>
          ) : (
            <span className="wd-overlap-name">{o.branch}</span>
          )}
        </span>
      ))}
      {list.length > 2 && ` +${list.length - 2}`}
      <span className="wd-overlap-count">
        {' '}
        ({files} file{files === 1 ? '' : 's'})
      </span>
    </span>
  );
}

/** "Needs your input · 4m — Claude needs your permission to use Bash". */
export function StatusLine({ session }: { session: SessionSummary }) {
  const kind = displayStatus(session);
  const a = session.attention;
  const since = a ? relativeTime(a.since) : relativeTime(lastActiveAt(session));
  return (
    <span className={`wd-status-line wd-status-line-${kind}`} title={statusHint(kind)}>
      <StatusIcon kind={kind} />
      <span className="wd-status-label">{DISPLAY_LABEL[kind]}</span>
      {since && <span className="wd-status-since"> · {since}</span>}
      {a?.stale && (
        <span className="wd-status-since" title="No activity for 15 minutes">
          {' '}
          (quiet)
        </span>
      )}
      {a?.summary && <span className="wd-status-summary"> — {a.summary}</span>}
    </span>
  );
}

/**
 * "on fix/terminal-encryption-key-nexo": the branch its worktree is really on,
 * when that isn't the one the session started on (Claude switched, or you
 * did). Ship and the PR watch follow the real one; this is so you see it too.
 */
export function otherBranchText(session: SessionSummary): string | null {
  const other = session.onOtherBranch ?? [];
  if (other.length === 0) return null;
  const name = (b: string | null) => b ?? 'a detached HEAD';
  return session.isGroup ? other.map((o) => `${o.repo} on ${name(o.branch)}`).join(', ') : `on ${name(other[0].branch)}`;
}

export function OtherBranchChip({ session }: { session: SessionSummary }) {
  const text = otherBranchText(session);
  if (!text) return null;
  return (
    <span
      className="wd-other-branch"
      title={`Started on ${session.branch}; its worktree is ${text} now. Ship, CI and the diffs use the branch that's checked out.`}
    >
      {text}
    </span>
  );
}
