import type { SessionSummary } from '../../api/client.js';
import type { PrInfo } from '../../api/panes.js';
import {
  CHECKS_GLYPH,
  DISPLAY_LABEL,
  displayStatus,
  formatDiffStat,
} from '../../state/session-display.js';
import { relativeTime } from '../../utils/time.js';

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

/** "Needs your input · 4m — Claude needs your permission to use Bash". */
export function StatusLine({ session }: { session: SessionSummary }) {
  const kind = displayStatus(session);
  const a = session.attention;
  const since = a ? relativeTime(a.since) : relativeTime(session.lastAccessedAt);
  return (
    <span className={`wd-status-line wd-status-line-${kind}`}>
      <span className={`wd-rail-dot wd-rail-dot-${kind}`} aria-hidden />
      <span className="wd-status-label">{DISPLAY_LABEL[kind]}</span>
      {since && <span className="wd-status-since"> · {since}</span>}
      {a?.stale && <span className="wd-status-since" title="No activity for 15 minutes"> (quiet)</span>}
      {a?.summary && <span className="wd-status-summary"> — {a.summary}</span>}
    </span>
  );
}
