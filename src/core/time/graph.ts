import fs from 'node:fs';
import path from 'node:path';
import { getConfigDir } from '../platform/config.js';
import { atomicWriteFile, ensureFile, withFileLockSync } from '../platform/fs-safe.js';
import { issueKeys } from './allocate.js';
import { localDay } from './time-view.js';
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

/**
 * Under the file's lock, atomically (work web and a `work timesheet` may
 * refresh at once). Only you can read it: the file is made 0600 before
 * anything is in it, and the atomic write keeps the mode it finds.
 */
function writeTokens(t: TokenFile): void {
  const file = tokenPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  ensureFile(file, '{}');
  fs.chmodSync(file, 0o600);
  withFileLockSync(file, () => atomicWriteFile(file, JSON.stringify(t)));
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

/** Every call to Microsoft gives up after this: a hung connection must not hold a day's build (and the keeper) for ever. */
export const TIMEOUT_MS = 30_000;

/** Token-endpoint errors that mean the sign-in itself is gone (expired, revoked, a changed password). Others (throttling, a server error) pass. */
const SIGN_IN_GONE = new Set(['invalid_grant', 'interaction_required', 'invalid_client', 'unauthorized_client', 'consent_required']);

/** A form POST to the sign-in endpoints, with the timeout. */
const postForm = (fetchImpl: Fetch, url: string, form: Record<string, string>) =>
  fetchImpl(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(form).toString(),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

export async function startDeviceLogin(app: GraphApp, fetchImpl: Fetch = fetch, now = Date.now()): Promise<DeviceLogin> {
  const res = await postForm(fetchImpl, loginUrl(app.tenantId, 'devicecode'), { client_id: app.clientId, scope: GRAPH_SCOPES });
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
    const res = await postForm(fetchImpl, loginUrl(app.tenantId, 'token'), {
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      client_id: app.clientId,
      device_code: login.deviceCode,
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
  const me = await fetchImpl(`${GRAPH}/me?$select=userPrincipalName,id`, {
    headers: { Authorization: `Bearer ${j.access_token}` },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
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
  const res = await postForm(fetchImpl, loginUrl(app.tenantId, 'token'), {
    grant_type: 'refresh_token',
    client_id: app.clientId,
    refresh_token: t.refreshToken,
    scope: GRAPH_SCOPES,
  });
  const j = (await res.json().catch(() => ({}))) as TokenAnswer & { error?: string };
  if (!res.ok || !j.access_token) {
    // The sign-in itself refused: said until you connect again. Throttling (429) or a server error may pass: tried again next time.
    const gone = !!j.error && SIGN_IN_GONE.has(j.error);
    if (gone) writeTokens({ ...t, problem: EXPIRED });
    throw new Error(gone ? EXPIRED : `Microsoft sign-in: ${res.status}${j.error ? ` ${j.error}` : ''}`);
  }
  await keep(app, j, now, fetchImpl);
  return j.access_token;
}

async function getJson<T>(url: string, token: string, fetchImpl: Fetch, headers: Record<string, string> = {}): Promise<T> {
  const res = await fetchImpl(url, { headers: { Authorization: `Bearer ${token}`, ...headers }, signal: AbortSignal.timeout(TIMEOUT_MS) });
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
    '&$select=id,subject,start,end,isAllDay,isCancelled,showAs,responseStatus&$top=100';
  const j = await getJson<{
    value?: Array<{
      id?: string;
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
    out.push({
      ...(e.id ? { id: e.id } : {}),
      subject: e.subject?.trim() || '(no subject)',
      start: start.slice(11, 16),
      end: end.slice(11, 16),
      minutes,
    });
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
  return (await chatsSince(day, token, fetchImpl)).get(day) ?? [];
}

/**
 * Every day's Teams chats from `firstDay` to now, read once: the chats with
 * a message since, each paged back to that day (newest first). Per day, the
 * chats you wrote in — how many of your messages, a few of them shortened —
 * and the issue keys anyone there named that day (`mentions`: only the keys
 * are taken from others' messages; their text is neither kept nor given to
 * the AI step). A whole catch-up costs one read, not one per day.
 */
export async function chatsSince(firstDay: string, token: string, fetchImpl: Fetch = fetch): Promise<Map<string, TimeChatEvidence[]>> {
  const from = dayBounds(firstDay).from.getTime();
  const me = await getJson<{ id?: string }>(`${GRAPH}/me?$select=id`, token, fetchImpl);
  const active: Chat[] = [];
  let next: string | undefined = `${GRAPH}/me/chats?$top=50&$expand=lastMessagePreview&$orderby=lastMessagePreview/createdDateTime desc`;
  for (let page = 0; next && page < MAX_PAGES; page++) {
    const j: Paged<Chat> = await getJson(next, token, fetchImpl);
    const value = j.value ?? [];
    active.push(...value.filter((c) => Date.parse(c.lastMessagePreview?.createdDateTime ?? '') >= from));
    next = oldestAt(value.map((c) => c.lastMessagePreview?.createdDateTime)) >= from ? j['@odata.nextLink'] : undefined;
  }
  const out = new Map<string, TimeChatEvidence[]>();
  for (const c of active) {
    if (!c.id) continue;
    const msgs: Msg[] = [];
    let more: string | undefined = `${GRAPH}/me/chats/${encodeURIComponent(c.id)}/messages?$top=50`;
    for (let page = 0; more && page < MAX_PAGES; page++) {
      const j: Paged<Msg> = await getJson(more, token, fetchImpl);
      const value = j.value ?? [];
      msgs.push(...value);
      more = oldestAt(value.map((m) => m.createdDateTime)) >= from ? j['@odata.nextLink'] : undefined;
    }
    const byDay = new Map<string, Msg[]>();
    for (const m of msgs) {
      const at = Date.parse(m.createdDateTime ?? '');
      if (!(at >= from)) continue;
      const d = localDay(at);
      byDay.set(d, [...(byDay.get(d) ?? []), m]);
    }
    for (const [d, dayMsgs] of byDay) {
      const mine = dayMsgs.filter((m) => m.from?.user?.id === me.id);
      if (!mine.length) continue;
      const list = out.get(d) ?? [];
      if (list.length >= 20) continue;
      const mentions = [...new Set(dayMsgs.flatMap((m) => issueKeys(plain(m.body?.content ?? ''))))];
      list.push({
        id: c.id,
        chat: c.topic?.trim() || (c.chatType === 'oneOnOne' ? 'a one-on-one chat' : 'a group chat'),
        messages: mine.length,
        sample: mine.slice(0, 5).map((m) => plain(m.body?.content ?? '').slice(0, 200)),
        ...(mentions.length ? { mentions } : {}),
      });
      out.set(d, list);
    }
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
