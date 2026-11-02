import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { UsageWindow } from '../../usage/usage.js';

// What Claude Code's status line says about its plan limits, and whose they are. Light on purpose: the status-line hook imports it on every refresh.

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

const clampPercent = (n: number) => Math.round(Math.min(100, Math.max(0, n)) * 10) / 10;

/** Epoch seconds below 1e12, milliseconds above; a string is parsed as a date. */
function resetIso(v: unknown): string | null {
  let ms: number;
  if (typeof v === 'number' && Number.isFinite(v)) ms = v < 1e12 ? v * 1000 : v;
  else if (typeof v === 'string' && v.trim() !== '') ms = Date.parse(v);
  else return null;
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

const capitalise = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

function labelOf(key: string): string {
  if (key === 'five_hour') return '5-hour limit';
  if (key === 'seven_day') return 'Weekly limit';
  const named = /^seven_day_(.+)$/.exec(key);
  if (named) return `Weekly ${capitalise(named[1]!.replace(/_/g, ' '))} limit`;
  const span = /^(\d+)_(hour|day)$/.exec(key);
  if (span) return `${span[1]}-${span[2]} limit`;
  return `${capitalise(key.replace(/_/g, ' '))} limit`;
}

const rank = (key: string) => (key === 'five_hour' ? 0 : key === 'seven_day' ? 1 : 2);

/** Claude Code's status-line `rate_limits`; whatever doesn't fit is skipped. */
export function parseClaudeRateLimits(raw: unknown): UsageWindow[] {
  if (!isRecord(raw)) return [];
  const windows: UsageWindow[] = [];
  const keys = Object.keys(raw)
    .filter((k) => k !== 'spend_limit')
    .sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
  for (const key of keys) {
    const w = raw[key];
    if (!isRecord(w) || typeof w.used_percentage !== 'number' || !Number.isFinite(w.used_percentage)) continue;
    windows.push({ id: key, label: labelOf(key), usedPercent: clampPercent(w.used_percentage), resetsAt: resetIso(w.resets_at) });
  }
  const spend = raw.spend_limit;
  if (isRecord(spend)) {
    const { used_percentage: pct, used_usd: used, limit_usd: limit } = spend;
    let percent: number | null = null;
    if (typeof pct === 'number' && Number.isFinite(pct)) percent = pct;
    else if (typeof used === 'number' && typeof limit === 'number' && Number.isFinite(used) && Number.isFinite(limit) && limit > 0)
      percent = (used / limit) * 100;
    if (percent !== null) {
      windows.push({ id: 'spend_limit', label: 'Spend limit', usedPercent: clampPercent(percent), resetsAt: resetIso(spend.resets_at) });
    }
  }
  return windows;
}

/** The account a Claude runs as: `default` for its normal config folder (~/.claude), else a short stable name for its CLAUDE_CONFIG_DIR. */
export function accountOf(configDir: string | undefined): string {
  if (!configDir) return 'default';
  const norm = (p: string) => (process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p));
  const resolved = norm(configDir);
  // CLAUDE_CONFIG_DIR set to the folder Claude uses anyway is the same account.
  if (resolved === norm(path.join(os.homedir(), '.claude'))) return 'default';
  const hash = createHash('sha1').update(resolved).digest('hex');
  return `cfg-${hash.slice(0, 8)}`;
}
