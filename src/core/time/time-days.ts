import type { WorktreeSession } from '../sessions/session-types.js';
import { sessionIdFor } from '../sessions/session-id.js';
import type { TimeCommitEvidence, TimeDaysWire, TimeDayWire, TimeEvidence, TimeJiraEvidence } from '../api-types.js';
import { issueKeys } from './allocate.js';
import { applyPlacement, classifyPrompt, parsePlacement, placementOf, unplacedHash, unplacedItems } from './classify.js';
import { readDay, readDays, saveBuilt } from './time-store.js';
import { activityOf, dayWireOf, daysWireOf, sessionTicket, type TimeConfig, type TimeDayRecord } from './time-view.js';

/**
 * The Time tab's days, gathered and stored: what was worked on each day
 * (evidence). The I/O is passed in (time-deps.ts has the real one):
 * sessions and their Claude minutes that day, your commits, the issues you
 * moved in Jira, and issue titles. How a day is shown is time-view.ts.
 */

export interface TimeDeps {
  /** Every session, archived ones too (they worked on days gone by). */
  sessions: () => WorktreeSession[];
  /** A session's Claude minutes on a day. */
  minutesOn: (s: WorktreeSession, day: string) => Promise<number>;
  /** Your commits that day (keys left for buildDay to fill). */
  commits: (day: string) => Promise<Array<Omit<TimeCommitEvidence, 'keys'>>>;
  /** Issues you moved in Jira that day. */
  jiraMoved: (day: string) => Promise<TimeJiraEvidence[]>;
  /** Titles of these issue keys (the ones it can find). */
  titles: (keys: string[]) => Promise<Record<string, string>>;
  settings: () => TimeConfig;
  /** Outlook meetings that day (Graph; absent or failing: none). */
  meetings?: (day: string) => Promise<TimeEvidence['meetings']>;
  /** Teams chats you wrote in that day. */
  chats?: (day: string) => Promise<TimeEvidence['chats']>;
  /** Tickets the AI step may place things on, besides the day's own (your assigned issues). */
  candidates?: () => Promise<Array<{ key: string; title: string }>>;
  /** The AI step (runInternal): the answer, or null when it can't run. */
  classify?: (prompt: string) => Promise<string | null>;
  /** A Jira issue's numeric id (Tempo wants it), cached. */
  issueId?: (key: string) => Promise<number | null>;
  now?: () => number;
}

/**
 * Gather a day's evidence and store it (your edits and day off kept). A
 * source that fails this time (acli, Outlook, git) keeps what the day had
 * from it: a passing failure must not move the hours.
 */
export async function buildDay(day: string, deps: TimeDeps): Promise<TimeDayRecord> {
  const settings = deps.settings();
  const prev = readDay(day);
  const had = prev?.builtAt ? prev.evidence : undefined;
  const all = deps.sessions();
  const sessions: TimeEvidence['sessions'] = [];
  for (const s of all) {
    const minutes = Math.round(await deps.minutesOn(s, day).catch(() => 0));
    if (minutes <= 0) continue;
    sessions.push({ sessionId: sessionIdFor(s), label: `${s.target} · ${s.title?.trim() || s.branch}`, key: sessionTicket(s), minutes });
  }
  const jira = await deps.jiraMoved(day).catch(() => had?.jira ?? []);
  // Keys in commit subjects count only for projects you work in (`UTF-8` isn't an issue).
  const projects = new Set(
    settings.projects ??
      [...all.map(sessionTicket), ...jira.map((j) => j.key), settings.gapTicket, settings.timeOffTicket]
        .filter((k): k is string => !!k)
        .map((k) => k.split('-')[0]),
  );
  const commits = (await deps.commits(day).catch(() => had?.commits ?? [])).map(({ repo, sha, subject }) => ({
    repo,
    sha,
    subject,
    keys: issueKeys(subject, projects),
  }));
  // undefined: not signed in (none); a failure: what the day had.
  const meetings = deps.meetings ? await deps.meetings(day).catch(() => had?.meetings) : undefined;
  const chats = deps.chats ? await deps.chats(day).catch(() => had?.chats) : undefined;
  let evidence: TimeEvidence = {
    sessions: sessions.sort((a, b) => b.minutes - a.minutes),
    commits,
    jira,
    ...(meetings ? { meetings } : {}),
    ...(chats ? { chats } : {}),
  };
  const titles: Record<string, string> = { ...(prev?.titles ?? {}) };
  for (const j of jira) titles[j.key] = j.summary;
  const wanted = [...new Set([...activityOf(evidence).map((a) => a.key), settings.gapTicket, settings.timeOffTicket])].filter(
    (k): k is string => !!k && !titles[k],
  );
  if (wanted.length) Object.assign(titles, await deps.titles(wanted).catch(() => ({})));
  evidence = await placeTheRest(evidence, prev?.evidence, titles, settings, deps);
  return saveBuilt({ day, evidence, titles, builtAt: new Date(deps.now?.() ?? Date.now()).toISOString() });
}

/**
 * The AI step (classify.ts) over what the day couldn't place by itself — asked
 * only when that changed since the last ask; the earlier answer is kept otherwise.
 */
async function placeTheRest(
  ev: TimeEvidence,
  prev: TimeEvidence | undefined,
  titles: Record<string, string>,
  settings: TimeConfig,
  deps: TimeDeps,
): Promise<TimeEvidence> {
  if (!deps.classify) return ev;
  const items = unplacedItems(ev);
  if (!items.length) return ev;
  const extra = deps.candidates ? await deps.candidates().catch(() => []) : [];
  for (const c of extra) titles[c.key] ??= c.title;
  const keys = [
    ...new Set(
      [...activityOf(ev).map((a) => a.key), ...extra.map((c) => c.key), settings.gapTicket, settings.timeOffTicket].filter(
        (k): k is string => !!k,
      ),
    ),
  ];
  const hash = unplacedHash(items, keys);
  if (prev?.classifiedFor === hash) return applyPlacement(ev, placementOf(prev), hash);
  const answer = await deps
    .classify(
      classifyPrompt(
        items,
        keys.map((key) => ({ key, title: titles[key] ?? '' })),
        settings.gapTicket,
      ),
    )
    .catch(() => null);
  if (answer === null) return ev; // it couldn't run: asked again next time
  return applyPlacement(
    ev,
    parsePlacement(
      answer,
      items.map((i) => i.id),
      keys,
    ),
    hash,
  );
}

/** A stored day as the tab shows it. */
export function dayWire(day: string, settings: TimeConfig): TimeDayWire {
  return dayWireOf(day, settings, readDay(day));
}

/** The stored days from `from` to `to`, newest first. */
export function daysWire(from: string, to: string, settings: TimeConfig): TimeDaysWire {
  return daysWireOf(from, to, settings, readDays(from, to));
}
