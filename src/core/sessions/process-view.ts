/**
 * A session's processes in words (session-processes.ts): sizes, ages and the one-line summary. Pure and free of
 * imports: the dashboard uses it too.
 */

/** Something other than the agent, running this long, is likely forgotten. */
export const LEFTOVER_AFTER_MS = 24 * 3_600_000;

/** "1.4 GB", "312 MB", "0 MB". */
export function formatBytes(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${Math.round(mb)} MB`;
}

/** "2d", "5h", "12m": how long something has run. */
export function formatAge(ms: number): string {
  const mins = Math.max(0, Math.floor(ms / 60_000));
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  return hours < 48 ? `${hours}h` : `${Math.floor(hours / 24)}d`;
}

/** "1.4 GB in 6 processes · 2 left running for over a day"; "Nothing of it is running." */
export function processesLine(w: { totalBytes: number; leftovers: number; processes: readonly unknown[] }): string {
  const n = w.processes.length;
  if (n === 0) return 'Nothing of it is running.';
  return (
    `${formatBytes(w.totalBytes)} in ${n} process${n === 1 ? '' : 'es'}` +
    (w.leftovers ? ` · ${w.leftovers} left running for over a day` : '')
  );
}
