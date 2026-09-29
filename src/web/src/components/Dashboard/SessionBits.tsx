import type { SessionSummary } from '../../api/client.js';
import type { PrInfo } from '../../api/panes.js';
import {
  CHECKS_GLYPH,
  DISPLAY_LABEL,
  displayStatus,
  formatDiffStat,
} from '../../state/session-display.js';
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
        const label = `#${p.number}${CHECKS_GLYPH[p.checksStatus] ? ` ${CHECKS_GLYPH[p.checksStatus]}` : ''}`;
        const title = `${p.repoAlias} #${p.number}${p.isDraft ? ' (draft)' : ''} — ${p.title}`;
        const cls = `wd-pr-chip wd-pr-chip-${p.checksStatus.toLowerCase()}${p.isDraft ? ' wd-pr-chip-draft' : ''}`;
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
          <span key={`${p.repoAlias}#${p.number}`} className={cls} title={title}>
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
      <span className="wd-diffstat-add">+{d.added}</span>{' '}
      <span className="wd-diffstat-del">−{d.deleted}</span>
    </span>
  );
}

/** 124000 → "124k". */
export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
  if (n >= 1000) return `${Math.round(n / 1000)}k`;
  return String(n);
}

/** Where a conversation's fill level starts to matter. */
export const CONTEXT_WARN = 0.7;
export const CONTEXT_FULL = 0.9;

/**
 * "Context 62%" with a small bar: how full the session's Claude
 * conversation is. Near the window Claude compacts it (and answers get
 * vaguer before that), so past 70% it's worth wrapping up and starting a
 * fresh conversation for the next task.
 */
export function ContextChip({ session }: { session: SessionSummary }) {
  const c = session.context;
  if (!c || c.window <= 0) return null;
  const ratio = Math.min(1, c.used / c.window);
  const pct = Math.round(ratio * 100);
  const level = ratio >= CONTEXT_FULL ? 'full' : ratio >= CONTEXT_WARN ? 'warn' : 'ok';
  const advice =
    level === 'ok'
      ? ''
      : '\nNearly full: Claude will compact it soon. For the next task, start fresh (work tree … --fresh, or /clear).';
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
  return (session.overlaps ?? [])
    .map((o) => {
      const more = o.count > o.files.length ? `, and ${o.count - o.files.length} more` : '';
      return `Also changed by ${o.target} · ${o.branch}:\n  ${o.files.map((f) => `${f.repo}/${f.path}`).join('\n  ')}${more}`;
    })
    .join('\n\n') + '\n\nThese will conflict when both merge.';
}

/**
 * "⚠ Same files as chore/deps-update": another live session changes some
 * of the same files, so the second of the two to merge will conflict.
 * With `onOpen` (the session header) each name opens that session; in
 * rows (which are buttons themselves) it's plain text with the list on hover.
 */
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
      <span className="wd-overlap-count"> ({files} file{files === 1 ? '' : 's'})</span>
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
      <span className={`wd-rail-dot wd-rail-dot-${kind}`} aria-hidden />
      <span className="wd-status-label">{DISPLAY_LABEL[kind]}</span>
      {since && <span className="wd-status-since"> · {since}</span>}
      {a?.stale && <span className="wd-status-since" title="No activity for 15 minutes"> (quiet)</span>}
      {a?.summary && <span className="wd-status-summary"> — {a.summary}</span>}
    </span>
  );
}
