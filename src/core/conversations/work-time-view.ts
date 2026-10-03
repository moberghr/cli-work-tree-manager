/**
 * PURE — shared by the SPA, the CLI's digest and the demo; keep it import-free.
 *
 * How long a session's Claude worked (work-time.ts measures it), in words.
 */

/** "<1m", "45m", "1h 05m", "12h 30m". */
export function formatWorked(ms: number): string {
  const min = Math.round(ms / 60_000);
  if (min < 1) return '<1m';
  if (min < 60) return `${min}m`;
  return `${Math.floor(min / 60)}h ${String(min % 60).padStart(2, '0')}m`;
}

/** Jira's worklog notation, rounded up to a quarter of an hour: "1h 15m", "30m". */
export function worklogTime(ms: number): string {
  const quarters = Math.max(1, Math.ceil(ms / (15 * 60_000)));
  const h = Math.floor(quarters / 4);
  const m = (quarters % 4) * 15;
  return [h ? `${h}h` : '', m ? `${m}m` : ''].filter(Boolean).join(' ');
}

/** A local calendar day as `YYYY-MM-DD` (the time's own timezone). */
export function dayKey(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
