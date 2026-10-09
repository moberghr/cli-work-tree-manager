import fs from 'node:fs';
import path from 'node:path';
import { getConfigDir } from '../platform/config.js';
import type { TimeChatEvidence, TimeMeetingEvidence } from '../api-types.js';

/**
 * Outlook meetings and Teams chats for the Time tab, from Microsoft Graph
 * as you (delegated): the device-code sign-in the timesheet tool uses — a
 * code you enter at microsoft.com — with its app registration (config
 * `time.graph.clientId` / `tenantId`, else GRAPH_CLIENT_ID / GRAPH_TENANT_ID).
 * The refresh token is kept in ~/.work/graph-token.json (only your user can
 * read it) and never reaches the browser. Read only: Calendars.Read,
 * Chat.Read. Chats are your own messages that day, shortened: what the
 * Time tab's AI step reads to place them on a ticket (classify.ts).
 */

export const GRAPH_SCOPES = 'offline_access User.Read Calendars.Read Chat.Read';
const GRAPH = 'https://graph.microsoft.com/v1.0';
const loginUrl = (tenant: string, what: string) => `https://login.microsoftonline.com/${encodeURIComponent(tenant)}/oauth2/v2.0/${what}`;

export interface GraphApp {
  clientId: string;
  tenantId: string;
}

/** The app registration to sign in with, or why there's none. Pure over config and env. */
export function graphApp(
  cfg: { clientId?: string; tenantId?: string } | undefined,
  env: Record<string, string | undefined>,
): GraphApp | { why: string } {
  const clientId = cfg?.clientId?.trim() || env.GRAPH_CLIENT_ID?.trim();
  if (!clientId) return { why: 'No app to sign in to Microsoft with: set time.graph.clientId (and tenantId) in config.json.' };
  return { clientId, tenantId: cfg?.tenantId?.trim() || env.GRAPH_TENANT_ID?.trim() || 'organizations' };
}

interface TokenFile {
  refreshToken: string;
  accessToken: string;
  expiresAt: number;
  account: string;
  clientId: string;
  /** Why the sign-in stopped working (a refused refresh): connect again. */
  problem?: string;
}

const tokenPath = () => path.join(getConfigDir(), 'graph-token.json');

function readTokens(): TokenFile | null {
  try {
    const v = JSON.parse(fs.readFileSync(tokenPath(), 'utf8')) as Partial<TokenFile>;
    return typeof v.refreshToken === 'string' && typeof v.accessToken === 'string' && typeof v.expiresAt === 'number'
      ? {
          refreshToken: v.refreshToken,
          accessToken: v.accessToken,
          expiresAt: v.expiresAt,
          account: v.account ?? '',
          clientId: v.clientId ?? '',
          ...(typeof v.problem === 'string' ? { problem: v.problem } : {}),
        }
      : null;
  } catch {
    return null;
  }
}

function writeTokens(t: TokenFile): void {
  fs.mkdirSync(path.dirname(tokenPath()), { recursive: true });
  const tmp = `${tokenPath()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(t), { mode: 0o600 });
  fs.renameSync(tmp, tokenPath());
}

/** Signed in as whom, if at all. */
export function graphAccount(): string | null {
  return readTokens()?.account || null;
}

export const EXPIRED = 'The Microsoft sign-in stopped working (expired or revoked): connect again.';
export const OTHER_APP = 'Signed in with another app registration than time.graph names now: connect again.';

/** Signed in, but it no longer works, and why (a refused refresh, another app registration); null when fine or not signed in. */
export function graphProblem(app: GraphApp | { why: string }): string | null {
  const t = readTokens();
  if (!t) return null;
  if (t.problem) return t.problem;
  if (!('why' in app) && t.clientId && t.clientId !== app.clientId) return OTHER_APP;
  return null;
}

export function signOutGraph(): void {
  fs.rmSync(tokenPath(), { force: true });
}

type Fetch = typeof fetch;

/** The code to enter at microsoft.com, and what to poll with. */
export interface DeviceLogin {
  userCode: string;
  verificationUri: string;
  deviceCode: string;
  expiresAt: number;
  intervalMs: number;
}

export async function startDeviceLogin(app: GraphApp, fetchImpl: Fetch = fetch, now = Date.now()): Promise<DeviceLogin> {
  const res = await fetchImpl(loginUrl(app.tenantId, 'devicecode'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: app.clientId, scope: GRAPH_SCOPES }).toString(),
  });
  const j = (await res.json().catch(() => ({}))) as {
    user_code?: string;
    device_code?: string;
    verification_uri?: string;
    expires_in?: number;
    interval?: number;
    error_description?: string;
  };
  if (!res.ok || !j.user_code || !j.device_code) throw new Error(`Microsoft sign-in: ${j.error_description?.split('\n')[0] ?? res.status}`);
  return {
    userCode: j.user_code,
    verificationUri: j.verification_uri ?? 'https://microsoft.com/devicelogin',
    deviceCode: j.device_code,
    expiresAt: now + (j.expires_in ?? 900) * 1000,
    intervalMs: (j.interval ?? 5) * 1000,
  };
}

export const CANCELLED = 'The sign-in was cancelled.';

/** Wait for the code to be entered (polling as Microsoft asks); keeps the tokens. Resolves with the account, or throws why not. */
export async function finishDeviceLogin(
  app: GraphApp,
  login: DeviceLogin,
  opts: { fetchImpl?: Fetch; sleep?: (ms: number) => Promise<void>; now?: () => number; cancelled?: () => boolean } = {},
): Promise<string> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const sleep = opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const now = opts.now ?? (() => Date.now());
  let interval = login.intervalMs;
  while (now() < login.expiresAt) {
    await sleep(interval);
    // Disconnected, or another sign-in started: this one keeps nothing.
    if (opts.cancelled?.()) throw new Error(CANCELLED);
    const res = await fetchImpl(loginUrl(app.tenantId, 'token'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        client_id: app.clientId,
        device_code: login.deviceCode,
      }).toString(),
    });
    const j = (await res.json().catch(() => ({}))) as TokenAnswer & { error?: string; error_description?: string };
    if (res.ok && j.access_token) {
      if (opts.cancelled?.()) throw new Error(CANCELLED);
      return keep(app, j, now(), fetchImpl);
    }
    if (j.error === 'authorization_pending') continue;
    if (j.error === 'slow_down') {
      interval += 5000;
      continue;
    }
    throw new Error(
      j.error === 'expired_token'
        ? 'The sign-in code expired: connect again.'
        : `Microsoft sign-in: ${j.error_description?.split('\n')[0] ?? j.error ?? res.status}`,
    );
  }
  throw new Error('The sign-in code expired: connect again.');
}

interface TokenAnswer {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
}

async function keep(app: GraphApp, j: TokenAnswer, now: number, fetchImpl: Fetch): Promise<string> {
  const me = await fetchImpl(`${GRAPH}/me?$select=userPrincipalName,id`, { headers: { Authorization: `Bearer ${j.access_token}` } });
  const who = (await me.json().catch(() => ({}))) as { userPrincipalName?: string };
  writeTokens({
    refreshToken: j.refresh_token ?? readTokens()?.refreshToken ?? '',
    accessToken: j.access_token!,
    expiresAt: now + ((j.expires_in ?? 3600) - 60) * 1000,
    account: who.userPrincipalName ?? readTokens()?.account ?? '',
    clientId: app.clientId,
  });
  return who.userPrincipalName ?? '';
}

/**
 * An access token, refreshed when it ran out; null when not signed in.
 * Signed in but not working (a refused refresh — recorded, so the tab says
 * "connect again" —, another app registration, no network) throws: the day
 * then keeps the meetings and chats it had, rather than losing them.
 */
export async function graphToken(app: GraphApp, fetchImpl: Fetch = fetch, now = Date.now()): Promise<string | null> {
  const t = readTokens();
  if (!t) return null;
  if (t.problem) throw new Error(t.problem);
  if (t.clientId && t.clientId !== app.clientId) throw new Error(OTHER_APP);
  if (t.expiresAt > now) return t.accessToken;
  const res = await fetchImpl(loginUrl(app.tenantId, 'token'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: app.clientId,
      refresh_token: t.refreshToken,
      scope: GRAPH_SCOPES,
    }).toString(),
  });
  const j = (await res.json().catch(() => ({}))) as TokenAnswer;
  if (!res.ok || !j.access_token) {
    // Refused (expired, revoked, a changed password): said until you connect again. A server error may pass.
    const refused = res.status >= 400 && res.status < 500;
    if (refused) writeTokens({ ...t, problem: EXPIRED });
    throw new Error(refused ? EXPIRED : `Microsoft sign-in: ${res.status}`);
  }
  await keep(app, j, now, fetchImpl);
  return j.access_token;
}

async function getJson<T>(url: string, token: string, fetchImpl: Fetch, headers: Record<string, string> = {}): Promise<T> {
  const res = await fetchImpl(url, { headers: { Authorization: `Bearer ${token}`, ...headers }, signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`Microsoft Graph: ${res.status} ${(await res.text().catch(() => '')).slice(0, 200)}`);
  return (await res.json()) as T;
}

/** A local day's bounds as instants. */
const dayBounds = (day: string) => {
  const from = new Date(`${day}T00:00:00`);
  const to = new Date(from);
  to.setDate(to.getDate() + 1);
  return { from, to };
};

/** Meetings you had that day: not cancelled, not declined, not free, not all day. */
export async function meetingsOn(day: string, token: string, fetchImpl: Fetch = fetch): Promise<TimeMeetingEvidence[]> {
  const { from, to } = dayBounds(day);
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const url =
    `${GRAPH}/me/calendarView?startDateTime=${from.toISOString()}&endDateTime=${to.toISOString()}` +
    '&$select=subject,start,end,isAllDay,isCancelled,showAs,responseStatus&$top=100';
  const j = await getJson<{
    value?: Array<{
      subject?: string;
      start?: { dateTime?: string };
      end?: { dateTime?: string };
      isAllDay?: boolean;
      isCancelled?: boolean;
      showAs?: string;
      responseStatus?: { response?: string };
    }>;
  }>(url, token, fetchImpl, { Prefer: `outlook.timezone="${tz}"` });
  const out: TimeMeetingEvidence[] = [];
  for (const e of j.value ?? []) {
    if (e.isAllDay || e.isCancelled || e.showAs === 'free' || e.responseStatus?.response === 'declined') continue;
    const start = e.start?.dateTime ?? '';
    const end = e.end?.dateTime ?? '';
    const minutes = Math.round((Date.parse(end) - Date.parse(start)) / 60_000);
    if (!(minutes > 0)) continue;
    out.push({ subject: e.subject?.trim() || '(no subject)', start: start.slice(11, 16), end: end.slice(11, 16), minutes });
  }
  return out.sort((a, b) => a.start.localeCompare(b.start));
}

/** How many pages of chats, and of one chat's messages, are read at most (50 each). */
export const MAX_PAGES = 10;

type Paged<T> = { value?: T[]; '@odata.nextLink'?: string };
type Chat = { id?: string; topic?: string | null; chatType?: string; lastMessagePreview?: { createdDateTime?: string } | null };
type Msg = { createdDateTime?: string; from?: { user?: { id?: string } } | null; body?: { content?: string } };

/** The earliest of these times (none: -Infinity, so no further page). */
const oldestAt = (times: Array<string | undefined>) => {
  const ms = times.map((t) => Date.parse(t ?? '')).filter((n) => !Number.isNaN(n));
  return ms.length ? Math.min(...ms) : -Infinity;
};

/** Teams chats where you wrote that day: who with, how many messages, a few of yours, shortened. */
export async function chatsOn(day: string, token: string, fetchImpl: Fetch = fetch): Promise<TimeChatEvidence[]> {
  const { from, to } = dayBounds(day);
  const me = await getJson<{ id?: string }>(`${GRAPH}/me?$select=id`, token, fetchImpl);
  // Chats come newest message first: every one with a message since the day began, page by page.
  const active: Chat[] = [];
  let next: string | undefined = `${GRAPH}/me/chats?$top=50&$expand=lastMessagePreview&$orderby=lastMessagePreview/createdDateTime desc`;
  for (let page = 0; next && page < MAX_PAGES; page++) {
    const j: Paged<Chat> = await getJson(next, token, fetchImpl);
    const value = j.value ?? [];
    active.push(...value.filter((c) => Date.parse(c.lastMessagePreview?.createdDateTime ?? '') >= from.getTime()));
    next = oldestAt(value.map((c) => c.lastMessagePreview?.createdDateTime)) >= from.getTime() ? j['@odata.nextLink'] : undefined;
  }
  const out: TimeChatEvidence[] = [];
  for (const c of active) {
    if (!c.id) continue;
    // Messages come newest first: back page by page to the day's start (a busy chat, or a day gone by, has more than a page since).
    const msgs: Msg[] = [];
    let more: string | undefined = `${GRAPH}/me/chats/${encodeURIComponent(c.id)}/messages?$top=50`;
    for (let page = 0; more && page < MAX_PAGES; page++) {
      const j: Paged<Msg> = await getJson(more, token, fetchImpl);
      const value = j.value ?? [];
      msgs.push(...value);
      more = oldestAt(value.map((m) => m.createdDateTime)) >= from.getTime() ? j['@odata.nextLink'] : undefined;
    }
    const mine = msgs.filter((m) => {
      const at = Date.parse(m.createdDateTime ?? '');
      return at >= from.getTime() && at < to.getTime() && m.from?.user?.id === me.id;
    });
    if (!mine.length) continue;
    out.push({
      chat: c.topic?.trim() || (c.chatType === 'oneOnOne' ? 'a one-on-one chat' : 'a group chat'),
      messages: mine.length,
      sample: mine.slice(0, 5).map((m) => plain(m.body?.content ?? '').slice(0, 200)),
    });
    if (out.length >= 20) break;
  }
  return out;
}

/** A message's HTML as plain text. */
export function plain(html: string): string {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}
