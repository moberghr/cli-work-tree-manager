/**
 * Compact relative-time formatter. Returns short strings like "12m", "3h",
 * "2d", "5w", "4mo", "2y". Tuned for narrow UI like sidebar rows where
 * "12 minutes ago" is too long.
 */
export function relativeTime(iso: string, nowMs: number = Date.now()): string {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return '';
  const delta = Math.max(0, nowMs - t);

  const sec = Math.floor(delta / 1000);
  if (sec < 30) return 'just now';
  if (sec < 60) return `${sec}s`;

  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m`;

  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h`;

  const day = Math.floor(hr / 24);
  if (day < 7) return `${day}d`;

  const wk = Math.floor(day / 7);
  if (day < 30) return `${wk}w`;

  const mo = Math.floor(day / 30);
  if (day < 365) return `${mo}mo`;

  const yr = Math.floor(day / 365);
  return `${yr}y`;
}
