import type { ArchivedBy, SessionArchiveInfo } from '../../../core/api-types.js';
import { WEEK_MS, type AgeBucket } from '../../../core/sessions/session-view.js';
import { relativeTime } from '../utils/time.js';

/** Who archived it, in a word or two: the archived pill. */
export const ARCHIVED_BY_SHORT: Record<ArchivedBy, string> = {
  you: 'by you',
  shipped: 'merged with Ship',
  'pr-merged': 'PR merged',
  cleanup: 'Clean up',
};

/** Who archived it, in a sentence: the tooltips. */
const ARCHIVED_BY_LONG: Record<ArchivedBy, string> = {
  you: 'you archived it',
  shipped: 'Ship merged its pull request and archived it',
  'pr-merged': 'its pull request merged, so work archived it',
  cleanup: 'archived from Clean up',
};

/** When, as a date and a time (in the viewer's zone): "14 Oct 2026, 15:02". */
export function archivedWhen(iso: string): string {
  const t = new Date(iso);
  if (!Number.isFinite(t.getTime())) return '';
  return t.toLocaleString(undefined, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

/** "Archived 14 Oct 2026, 15:02 — its pull request merged, so work archived it." (who only when it was recorded) */
export function archivedLine(s: { archivedAt?: string | null; archive?: Pick<SessionArchiveInfo, 'by'> }): string {
  const when = s.archivedAt ? archivedWhen(s.archivedAt) : '';
  if (!when) return '';
  const by = s.archive?.by ? ARCHIVED_BY_LONG[s.archive.by] : null;
  return `Archived ${when}${by ? ` — ${by}` : ''}.`;
}

/** "Last active 10m ago." — "just now" without an "ago", nothing when it isn't known. */
export function lastActiveLine(iso: string, nowMs = Date.now()): string {
  const rel = relativeTime(iso, nowMs);
  return !rel ? '' : rel === 'just now' ? 'Last active just now.' : `Last active ${rel} ago.`;
}

/**
 * The Sessions list's time: in the Archived view, when each was archived (shown, and what it's sorted by, so the
 * column reads in order); everywhere else, when it was last active — an archived row in All too, under "Active".
 */
export function listTime(s: { archivedAt?: string | null }, lastActive: string, archivedView: boolean): string {
  return archivedView && s.archivedAt ? s.archivedAt : lastActive;
}

/** The Archived view's sections by when each was archived: Now (the last day), This week, Older. */
export function archivedAge(iso: string, now = Date.now()): AgeBucket {
  const age = now - Date.parse(iso);
  if (!(age < WEEK_MS)) return Number.isFinite(age) ? 'older' : 'now';
  return age < 24 * 3_600_000 ? 'now' : 'week';
}
