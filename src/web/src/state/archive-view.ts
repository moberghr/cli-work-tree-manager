import type { ArchivedBy, SessionArchiveInfo } from '../../../core/api-types.js';

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
  if (!s.archivedAt) return '';
  const when = archivedWhen(s.archivedAt);
  const by = s.archive?.by ? ARCHIVED_BY_LONG[s.archive.by] : null;
  return `Archived ${when}${by ? ` — ${by}` : ''}.`;
}
