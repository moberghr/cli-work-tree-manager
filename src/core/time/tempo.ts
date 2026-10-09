/**
 * Posting a day to Tempo Cloud (REST v4, `api.tempo.io/4/worklogs`), as the
 * timesheet tool did: one worklog per ticket, by Jira issue id, start times
 * one after another from 09:00, no description. Unlike it, the day as Tempo
 * has it is read first (`GET /4/worklogs/user/{account}`), so:
 *   - what work posted before and you still want stays (no call),
 *   - what work posted and you took out (or changed) goes,
 *   - a worklog you made by hand is never touched — and when it already
 *     covers a row (same issue, same time), that row isn't posted again;
 *   - only the rest is posted.
 * The plan is pure (`planDay`); the calls are passed in. The token never
 * leaves the server (env `TEMPO_API_TOKEN`, or the variable `time.tempo.tokenEnv` names).
 */

export const TEMPO_URL = 'https://api.tempo.io/4/worklogs';
export const DAY_START_SECONDS = 9 * 3600;

/** A worklog as Tempo lists it (the fields this reads). */
export interface TempoWorklog {
  tempoWorklogId: number;
  issueId: number;
  timeSpentSeconds: number;
  startDate: string;
  startTime: string;
}

/** A worklog work posted (kept with the day, time-store.ts). */
export interface PostedWorklog {
  tempoWorklogId: number;
  key: string;
  issueId: number;
  seconds: number;
  startTime: string;
}

export interface DayRow {
  key: string;
  issueId: number;
  seconds: number;
}

export interface DayPlan {
  /** Posted by work before, still wanted as they are. */
  keep: PostedWorklog[];
  /** Posted by work before, no longer wanted (taken out, or changed). */
  remove: PostedWorklog[];
  /** Rows a worklog you made by hand already covers (same issue and time): not posted again. */
  coveredByHand: Array<DayRow & { tempoWorklogId: number }>;
  /** Rows on an issue you logged by hand for another time: not posted (Tempo would have the issue twice) — yours to settle. */
  differsByHand: Array<DayRow & { handSeconds: number }>;
  /** To post, with their start times. */
  add: Array<DayRow & { startTime: string }>;
  /** Your own worklogs that day that no row matches: left alone, and said. */
  otherByHand: TempoWorklog[];
}

const hhmmss = (s: number) =>
  `${String(Math.floor(s / 3600)).padStart(2, '0')}:${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;

const DAY_SECONDS = 24 * 3600;

/** A start time `HH:MM[:SS]` in seconds; none (or unreadable): 09:00, where work starts its rows. */
const secondsOf = (t: string) => {
  const m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(t);
  return m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3] ?? 0) : DAY_START_SECONDS;
};

/** What to do to make Tempo's day the rows wanted. Pure. */
export function planDay(rows: readonly DayRow[], inTempo: readonly TempoWorklog[], ours: readonly PostedWorklog[]): DayPlan {
  // Ours as Tempo has them now: gone (deleted there) is forgotten; changed there by hand (its time or issue) is
  // yours from then on — never kept as if unchanged, never deleted.
  const live = new Map(inTempo.map((w) => [w.tempoWorklogId, w]));
  const mine = ours.filter((o) => {
    const w = live.get(o.tempoWorklogId);
    return !!w && w.timeSpentSeconds === o.seconds && w.issueId === o.issueId;
  });
  const ourIds = new Set(mine.map((o) => o.tempoWorklogId));
  const byHand = inTempo.filter((w) => !ourIds.has(w.tempoWorklogId));
  const keep: PostedWorklog[] = [];
  const coveredByHand: DayPlan['coveredByHand'] = [];
  const differsByHand: DayPlan['differsByHand'] = [];
  const usedHand = new Set<number>();
  const todo: DayRow[] = [];
  const left = [...mine];
  for (const r of rows) {
    const i = left.findIndex((o) => o.issueId === r.issueId && o.seconds === r.seconds);
    if (i >= 0) {
      keep.push(left[i]);
      left.splice(i, 1);
      continue;
    }
    const h = byHand.find((w) => !usedHand.has(w.tempoWorklogId) && w.issueId === r.issueId && w.timeSpentSeconds === r.seconds);
    if (h) {
      usedHand.add(h.tempoWorklogId);
      coveredByHand.push({ ...r, tempoWorklogId: h.tempoWorklogId });
      continue;
    }
    const other = byHand.filter((w) => !usedHand.has(w.tempoWorklogId) && w.issueId === r.issueId);
    if (other.length) {
      for (const w of other) usedHand.add(w.tempoWorklogId);
      differsByHand.push({ ...r, handSeconds: other.reduce((n, w) => n + w.timeSpentSeconds, 0) });
      continue;
    }
    todo.push(r);
  }
  // New rows start where everything that stays has ended (by its real start time), one after another, from 09:00;
  // never past midnight (Tempo refuses a start of 24:00 or later): a late one ends at 24:00 instead.
  // Where each one that stays is now (a worklog of ours you moved in Tempo is where you put it, not where we did).
  const ends = [
    ...keep.map((k) => secondsOf(live.get(k.tempoWorklogId)?.startTime ?? k.startTime) + k.seconds),
    ...byHand.map((w) => secondsOf(w.startTime) + w.timeSpentSeconds),
  ];
  let at = Math.max(DAY_START_SECONDS, ...ends);
  const add = todo.map((r) => {
    const start = Math.max(0, Math.min(at, DAY_SECONDS - r.seconds));
    at = start + r.seconds;
    return { ...r, startTime: hhmmss(start) };
  });
  return { keep, remove: left, coveredByHand, differsByHand, add, otherByHand: byHand.filter((w) => !usedHand.has(w.tempoWorklogId)) };
}

/** The calls (tempoClient has the real ones). */
export interface TempoApi {
  list: (accountId: string, day: string) => Promise<TempoWorklog[]>;
  create: (body: {
    issueId: number;
    timeSpentSeconds: number;
    startDate: string;
    startTime: string;
    authorAccountId: string;
  }) => Promise<number>;
  remove: (tempoWorklogId: number) => Promise<void>;
}

/** Tempo over HTTP with a bearer token. */
export function tempoClient(token: string, fetchImpl: typeof fetch = fetch): TempoApi {
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const fail = async (what: string, res: Response) => {
    const text = (await res.text().catch(() => '')).slice(0, 300);
    throw new Error(`Tempo ${what}: ${res.status}${text ? ` ${text}` : ''}`);
  };
  return {
    list: async (accountId, day) => {
      const out: TempoWorklog[] = [];
      let url: string | null = `${TEMPO_URL}/user/${encodeURIComponent(accountId)}?from=${day}&to=${day}&limit=1000`;
      while (url) {
        const res: Response = await fetchImpl(url, { headers, signal: AbortSignal.timeout(30_000) });
        if (!res.ok) await fail('list', res);
        const j = (await res.json()) as {
          results?: Array<{
            tempoWorklogId?: number;
            issue?: { id?: number };
            timeSpentSeconds?: number;
            startDate?: string;
            startTime?: string;
          }>;
          metadata?: { next?: string };
        };
        for (const w of j.results ?? []) {
          if (typeof w.tempoWorklogId !== 'number' || typeof w.issue?.id !== 'number' || typeof w.timeSpentSeconds !== 'number') continue;
          out.push({
            tempoWorklogId: w.tempoWorklogId,
            issueId: w.issue.id,
            timeSpentSeconds: w.timeSpentSeconds,
            startDate: w.startDate ?? day,
            startTime: w.startTime ?? '',
          });
        }
        url = j.metadata?.next ?? null;
      }
      return out;
    },
    create: async (body) => {
      const res = await fetchImpl(TEMPO_URL, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(30_000) });
      if (!res.ok) await fail('post', res);
      const j = (await res.json()) as { tempoWorklogId?: number };
      if (typeof j.tempoWorklogId !== 'number') throw new Error('Tempo post: no worklog id in the answer');
      return j.tempoWorklogId;
    },
    remove: async (id) => {
      const res = await fetchImpl(`${TEMPO_URL}/${id}`, { method: 'DELETE', headers, signal: AbortSignal.timeout(30_000) });
      if (!res.ok && res.status !== 404) await fail('delete', res);
    },
  };
}

/** Where posting stands: ready, or why not (said in the tab). Pure over config and env. */
export function tempoSetup(
  cfg: { tokenEnv?: string; accountId?: string } | undefined,
  env: Record<string, string | undefined>,
): { ready: true; token: string; accountId: string } | { ready: false; why: string } {
  const tokenEnv = cfg?.tokenEnv ?? 'TEMPO_API_TOKEN';
  const token = env[tokenEnv]?.trim();
  const accountId = cfg?.accountId?.trim() || env.JIRA_ACCOUNT_ID?.trim();
  if (!token) return { ready: false, why: `No Tempo token: set ${tokenEnv} (a Tempo API token with "Worklogs — Manage") for work web.` };
  if (!accountId) return { ready: false, why: 'No Jira account id: set time.tempo.accountId in config.json (or JIRA_ACCOUNT_ID).' };
  return { ready: true, token, accountId };
}

export interface PostResult {
  posted: number;
  removed: number;
  kept: number;
  coveredByHand: number;
  otherByHand: number;
  /** Rows not posted, and why (an issue id that couldn't be found, a call that failed). */
  failed: Array<{ key: string; error: string }>;
  /** What work posted for the day now (to store). */
  ours: PostedWorklog[];
  /** Worklogs of ours that should have gone and couldn't: still in Tempo. */
  stuck: PostedWorklog[];
}

/** Make Tempo's day the rows wanted: remove, then post, recording each as it goes. */
export async function postDay(
  day: string,
  entries: ReadonlyArray<{ key: string; hours: number }>,
  ours: readonly PostedWorklog[],
  deps: { api: TempoApi; accountId: string; issueId: (key: string) => Promise<number | null> },
): Promise<PostResult> {
  const failed: PostResult['failed'] = [];
  const rows: DayRow[] = [];
  for (const e of entries) {
    // The id work posted it under before, when Jira can't say now: a row left out would read as "not wanted", and
    // its worklog would be deleted.
    const issueId = (await deps.issueId(e.key).catch(() => null)) ?? ours.find((o) => o.key === e.key)?.issueId ?? null;
    if (issueId === null) failed.push({ key: e.key, error: 'no such issue in Jira (or acli could not say)' });
    else rows.push({ key: e.key, issueId, seconds: Math.round(e.hours * 3600) });
  }
  const plan = planDay(rows, await deps.api.list(deps.accountId, day), ours);
  const hours = (sec: number) => `${Math.round((sec / 3600) * 100) / 100} h`;
  for (const d of plan.differsByHand)
    failed.push({
      key: d.key,
      error: `you logged ${hours(d.handSeconds)} on it by hand in Tempo (this row: ${hours(d.seconds)}): change one of them`,
    });
  const now: PostedWorklog[] = [...plan.keep];
  const stuck: PostedWorklog[] = [];
  let removed = 0;
  for (const r of plan.remove) {
    try {
      await deps.api.remove(r.tempoWorklogId);
      removed++;
    } catch (err) {
      now.push(r); // still there: still ours
      stuck.push(r);
      failed.push({ key: r.key, error: (err as Error).message });
    }
  }
  // An issue whose old worklog is still there gets no new one: Tempo would have both.
  const blocked = new Set(stuck.map((r) => r.issueId));
  let posted = 0;
  for (const a of plan.add) {
    if (blocked.has(a.issueId)) {
      if (!failed.some((f) => f.key === a.key)) failed.push({ key: a.key, error: 'its earlier worklog could not be removed' });
      continue;
    }
    try {
      const id = await deps.api.create({
        issueId: a.issueId,
        timeSpentSeconds: a.seconds,
        startDate: day,
        startTime: a.startTime,
        authorAccountId: deps.accountId,
      });
      now.push({ tempoWorklogId: id, key: a.key, issueId: a.issueId, seconds: a.seconds, startTime: a.startTime });
      posted++;
    } catch (err) {
      failed.push({ key: a.key, error: (err as Error).message });
    }
  }
  return {
    posted,
    removed,
    kept: plan.keep.length,
    coveredByHand: plan.coveredByHand.length,
    otherByHand: plan.otherByHand.length,
    failed,
    ours: now,
    stuck,
  };
}
