import { json, tx, withDb, type Db } from '../platform/db.js';
import type { WorkConfig } from '../platform/config.js';
import { worklogTime } from '../conversations/work-time-view.js';

/**
 * Writing a session's worked time (work-time.ts) to its Jira issue as a
 * worklog — `acli` has no worklog command, so this talks to Jira's REST API
 * with an API token from config `jiraWorklog` (the token from an environment
 * variable by default; it never leaves the server). What was logged per day
 * is kept (state.db `worklogs`, gone with the session), so asking again logs
 * only what was added since, and never the same time twice.
 */

export interface WorklogSettings {
  /** The Jira site: `acme.atlassian.net` (https only). */
  site: string;
  email: string;
  token: string;
}

/** The settings, when complete: `jiraWorklog: { site, email, tokenEnv? (default JIRA_API_TOKEN) | token? }`. */
export function worklogSettings(config: WorkConfig | null, env: NodeJS.ProcessEnv = process.env): WorklogSettings | null {
  const w = config?.jiraWorklog;
  if (!w?.site || !w.email) return null;
  const site = w.site.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  if (!/^[a-z0-9.-]+$/i.test(site)) return null;
  const token = w.token ?? env[w.tokenEnv ?? 'JIRA_API_TOKEN'];
  return token ? { site, email: w.email, token } : null;
}

/** A Jira issue key (`PAY-12`); the URL path is built from it, so nothing else passes. Pure. */
export const isIssueKey = (k: string): boolean => /^[A-Z][A-Z0-9_]+-\d+$/.test(k);

/** Jira's `started`: local time with its offset ("2026-10-01T09:00:00.000+0200"). Pure. */
export function jiraStarted(d: Date): string {
  const pad = (n: number, w = 2) => String(Math.abs(n)).padStart(w, '0');
  const off = -d.getTimezoneOffset();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.000${off >= 0 ? '+' : '-'}${pad(Math.floor(Math.abs(off) / 60))}${pad(Math.abs(off) % 60)}`;
}

/** Rounded up to a quarter of an hour, in seconds (what worklogTime says). Pure. */
export const quarterSeconds = (ms: number): number => Math.max(1, Math.ceil(ms / (15 * 60_000))) * 15 * 60;

export interface LoggedDay {
  issueKey: string;
  seconds: number;
  ids: string[];
  at: string;
  /** A call is posting this day to Jira until then (the claim, logWorkDay). */
  postingUntil?: string;
}

/** How long a claim holds: past it, a call that died mid-post no longer blocks the day. */
const CLAIM_MS = 2 * 60_000;

function readDay(db: Db, sessionId: string, day: string): LoggedDay | null {
  const r = db.prepare('SELECT data FROM worklogs WHERE session_id = ? AND day = ?').get(sessionId, day) as { data: string } | undefined;
  const v = r ? (json.parse(r.data) as LoggedDay | null) : null;
  return v && typeof v.seconds === 'number' && typeof v.issueKey === 'string' && Array.isArray(v.ids) ? v : null;
}

function writeDay(db: Db, sessionId: string, day: string, v: LoggedDay): void {
  db.prepare('INSERT OR REPLACE INTO worklogs (session_id, day, data) VALUES (?, ?, ?)').run(sessionId, day, JSON.stringify(v));
}

export function loggedDays(sessionId: string): Record<string, LoggedDay> {
  const rows = withDb((d) => d.prepare('SELECT day, data FROM worklogs WHERE session_id = ?').all(sessionId) as Array<{ day: string; data: string }>);
  const out: Record<string, LoggedDay> = {};
  for (const r of rows) {
    const v = json.parse(r.data) as LoggedDay | null;
    if (v && typeof v.seconds === 'number' && typeof v.issueKey === 'string') out[r.day] = v;
  }
  return out;
}

export type WorklogResult = { ok: true; logged: number; total: number; text: string } | { ok: false; status: 400 | 409 | 502; error: string };

/**
 * Log a day's work (`ms`, from work-time) to `issueKey`: what isn't logged
 * yet for that day, rounded up to a quarter hour. `post` sends one worklog
 * (Jira's REST API), returning its id.
 */
export async function logWorkDay(
  sessionId: string,
  issueKey: string,
  day: string,
  ms: number,
  post: (issueKey: string, body: { timeSpentSeconds: number; started: string; comment: unknown }) => Promise<string>,
  now = new Date(),
): Promise<WorklogResult> {
  if (!isIssueKey(issueKey)) return { ok: false, status: 400, error: `not a Jira issue key: ${issueKey}` };
  if (ms < 60_000) return { ok: false, status: 409, error: 'no work that day to log' };
  const total = quarterSeconds(ms);
  // Claim the day before posting (a tx can't span the await): a second call
  // — another tab, `work time --log` beside the dashboard — sees the claim
  // and refuses instead of posting the same time to Jira again.
  const claim = tx((db) => {
    const prev = readDay(db, sessionId, day);
    if (prev?.postingUntil && Date.parse(prev.postingUntil) > now.getTime()) return { busy: true as const };
    const already = prev && prev.issueKey === issueKey ? prev.seconds : 0;
    const more = total - already;
    if (more <= 0) return { already, more };
    const held: LoggedDay = { ...(prev ?? { issueKey, seconds: 0, ids: [], at: now.toISOString() }), postingUntil: new Date(now.getTime() + CLAIM_MS).toISOString() };
    writeDay(db, sessionId, day, held);
    return { prev, already, more };
  });
  if ('busy' in claim) return { ok: false, status: 409, error: `already being logged for ${day}` };
  const { already, more } = claim;
  if (more <= 0) return { ok: false, status: 409, error: `already logged (${worklogTime(already * 1000)} on ${day})` };
  const prev = claim.prev;
  const [y, m, d] = day.split('-').map(Number);
  const started = new Date(y, m - 1, d, 9, 0, 0);
  let id: string;
  try {
    id = await post(issueKey, {
      timeSpentSeconds: more,
      started: jiraStarted(started),
      comment: { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Logged from work (Claude Code session time)' }] }] },
    });
  } catch (err) {
    // Let go of the claim: the day is as it was.
    tx((db) => {
      if (prev) writeDay(db, sessionId, day, prev);
      else db.prepare('DELETE FROM worklogs WHERE session_id = ? AND day = ?').run(sessionId, day);
    });
    return { ok: false, status: 502, error: `Jira refused it: ${(err as Error).message}` };
  }
  tx((db) => writeDay(db, sessionId, day, { issueKey, seconds: already + more, ids: [...(prev?.issueKey === issueKey ? prev.ids : []), id], at: now.toISOString() }));
  return { ok: true, logged: more, total: already + more, text: `${worklogTime(more * 1000)} logged on ${issueKey} for ${day}` };
}

/** Jira's REST call for one worklog (fetch; https; basic auth with the API token). */
export function jiraWorklogPoster(s: WorklogSettings, fetchImpl: typeof fetch = fetch) {
  return async (issueKey: string, body: unknown): Promise<string> => {
    if (!isIssueKey(issueKey)) throw new Error(`not a Jira issue key: ${issueKey}`);
    const res = await fetchImpl(`https://${s.site}/rest/api/3/issue/${issueKey}/worklog`, {
      method: 'POST',
      headers: { Authorization: `Basic ${Buffer.from(`${s.email}:${s.token}`).toString('base64')}`, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`${res.status} ${(await res.text().catch(() => '')).slice(0, 200)}`);
    const out = (await res.json().catch(() => ({}))) as { id?: unknown };
    return typeof out.id === 'string' ? out.id : '';
  };
}
