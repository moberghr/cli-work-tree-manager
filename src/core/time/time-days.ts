import type { WorktreeSession } from '../sessions/session-types.js';
import { sessionIdFor } from '../sessions/session-id.js';
import type { TimeCommitEvidence, TimeDaysWire, TimeDayWire, TimeEvidence, TimeJiraEvidence } from '../api-types.js';
import { issueKeys } from './allocate.js';
import { applyPlacement, classifyPrompt, parsePlacement, placementOf, unplacedHash, unplacedItems } from './classify.js';
import { readDay, readDays, saveBuilt } from './time-store.js';
import { hintKey } from './hints.js';
import { activityOf, addDays, dayWireOf, daysWireOf, sessionTicket, type TimeConfig, type TimeDayRecord } from './time-view.js';

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
  /** The first day `minutesOn` knows (it reads two weeks): a day before it keeps the sessions it had. */
  minutesFrom?: () => string;
  /** Your commits that day (keys left for buildDay to fill). */
  commits: (day: string) => Promise<Array<Omit<TimeCommitEvidence, 'keys'>>>;
  /** Issues you moved in Jira that day. */
  jiraMoved: (day: string) => Promise<TimeJiraEvidence[]>;
  /** Titles of these issue keys (the ones it can find), and whether Jira has each as done. */
  titles: (keys: string[]) => Promise<Record<string, string | { title: string; done?: boolean }>>;
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

/** Sessions' minutes read at once (each read goes through a session's transcripts). */
const MINUTES_AT_ONCE = 4;

/** Builds under way, per day: a second (Gather again while the keeper builds) gets the first one's answer. */
const building = new Map<string, Promise<TimeDayRecord>>();

/**
 * Gather a day's evidence and store it (your edits and day off kept). A
 * source that fails this time (acli, Outlook, git) keeps what the day had
 * from it: a passing failure must not move the hours. One build of a day
 * at a time.
 */
export function buildDay(day: string, deps: TimeDeps): Promise<TimeDayRecord> {
  const running = building.get(day);
  if (running) return running;
  const p = buildNow(day, deps).finally(() => building.delete(day));
  building.set(day, p);
  return p;
}

/**
 * The Jira projects you work in: `time.projects` when set, else the ones of
 * keys you named (sessions' Jira keys, `time.hints`), moved, were assigned, or set as the
 * gap and time-off tickets. Keys in branch names and commit subjects count
 * only for these (`UTF-8`, `ISO-8601` aren't issues). None known: no filter.
 */
function projectsOf(settings: TimeConfig, keys: Array<string | null | undefined>): Set<string> {
  if (settings.projects?.length) return new Set(settings.projects);
  return new Set([...keys, settings.gapTicket, settings.timeOffTicket].filter((k): k is string => !!k).map((k) => k.split('-')[0]));
}

async function buildNow(day: string, deps: TimeDeps): Promise<TimeDayRecord> {
  const settings = deps.settings();
  const prev = readDay(day);
  const had = prev?.builtAt ? prev.evidence : undefined;
  const all = deps.sessions();
  const jira = await deps.jiraMoved(day).catch(() => had?.jira ?? []);
  const assigned = deps.candidates ? await deps.candidates().catch(() => []) : [];
  const hints = settings.hints;
  const projects = projectsOf(settings, [
    ...all.map((s) => s.jiraKey),
    ...jira.map((j) => j.key),
    ...assigned.map((c) => c.key),
    ...Object.keys(hints ?? {}),
  ]);
  let sessions: TimeEvidence['sessions'] = [];
  // Only sessions that could have worked that day (made by its end, not archived before it began), read a few at a time.
  const start = Date.parse(`${day}T00:00:00`);
  const end = Date.parse(`${addDays(day, 1)}T00:00:00`);
  const could = all.filter((s) => !(Date.parse(s.createdAt) >= end) && !(Date.parse(s.archivedAt ?? '') < start));
  const read: number[] = [];
  for (let i = 0; i < could.length; i += MINUTES_AT_ONCE)
    read.push(...(await Promise.all(could.slice(i, i + MINUTES_AT_ONCE).map((s) => deps.minutesOn(s, day).then(Math.round, () => 0)))));
  for (const [i, s] of could.entries()) {
    const minutes = read[i];
    if (minutes <= 0) continue;
    const label = `${s.target} · ${s.title?.trim() || s.branch}`;
    sessions.push({
      sessionId: sessionIdFor(s),
      label,
      // Its Jira key or a key in its branch or name, else a hint's words in them (`time.hints`).
      key: sessionTicket(s, projects) ?? hintKey([label, s.branch], hints),
      minutes,
    });
  }
  if (had) {
    // Before the reach of the work-time reader nothing can be read again: the day keeps its sessions.
    if (deps.minutesFrom && day < deps.minutesFrom()) sessions = had.sessions;
    else {
      // A session the day had that reads nothing now — deleted since, its transcripts gone (Claude Code keeps
      // them about 30 days), or a read that failed — keeps its minutes: a day's past work doesn't shrink.
      const read = new Set(sessions.map((x) => x.sessionId));
      sessions.push(...had.sessions.filter((h) => !read.has(h.sessionId)));
    }
  }
  const commits = (await deps.commits(day).catch(() => had?.commits ?? [])).map(({ repo, sha, subject }) => {
    const named = issueKeys(subject, projects);
    const hinted = named.length ? null : hintKey([subject], hints);
    return { repo, sha, subject, keys: hinted ? [hinted] : named };
  });
  // undefined: not signed in (none); a failure: what the day had.
  const meetingsRead = deps.meetings ? await deps.meetings(day).catch(() => had?.meetings) : undefined;
  const chatsRead = deps.chats ? await deps.chats(day).catch(() => had?.chats) : undefined;
  // A meeting whose subject names a ticket (or a hint's words) is on it; a chat where a ticket was named that day
  // (by anyone: only keys are read from others' messages) is on the first of yours. Neither needs the AI step.
  const meetings = meetingsRead?.map((m) => {
    if (m.key) return m;
    const key = issueKeys(m.subject, projects)[0] ?? hintKey([m.subject], hints);
    return key ? { ...m, key } : m;
  });
  const chats = chatsRead?.map((c) => {
    if (c.key) return c;
    const named = (c.mentions ?? []).filter((k) => !projects.size || projects.has(k.split('-')[0]));
    const key = named[0] ?? hintKey([c.chat, ...c.sample], hints);
    return key ? { ...c, key } : c;
  });
  let evidence: TimeEvidence = {
    sessions: sessions.sort((a, b) => b.minutes - a.minutes),
    commits,
    jira,
    ...(meetings ? { meetings } : {}),
    ...(chats ? { chats } : {}),
  };
  const titles: Record<string, string> = { ...(prev?.titles ?? {}) };
  for (const j of jira) titles[j.key] = j.summary;
  // The day's tickets, asked every build: titles, and which Jira has as done (said on their rows).
  const hinted = Object.entries(hints ?? {}).map(([key, h]) => ({ key, title: h.summary ?? '' }));
  // Placeholders aren't in Jira (yet): not asked about.
  const keys = [...new Set([...activityOf(evidence).map((a) => a.key), settings.gapTicket, settings.timeOffTicket])].filter(
    (k): k is string => !!k && !hints?.[k]?.placeholder,
  );
  let resolved = prev?.resolved ?? [];
  if (keys.length) {
    const found = await deps.titles(keys).catch(() => null);
    if (found) {
      resolved = [];
      for (const [k, v] of Object.entries(found)) {
        titles[k] = typeof v === 'string' ? v : v.title;
        if (typeof v !== 'string' && v.done) resolved.push(k);
      }
    }
  }
  // A placeholder (to create in Jira) has no title there: the hint's summary.
  for (const h of hinted) if (h.title) titles[h.key] ??= h.title;
  evidence = await placeTheRest(evidence, prev?.evidence, titles, settings, deps, [...assigned, ...hinted]);
  return saveBuilt({
    day,
    evidence,
    titles,
    builtAt: new Date(deps.now?.() ?? Date.now()).toISOString(),
    ...(resolved.length ? { resolved } : {}),
  });
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
  extra: Array<{ key: string; title: string }>,
): Promise<TimeEvidence> {
  if (!deps.classify) return ev;
  const items = unplacedItems(ev);
  if (!items.length) return ev;
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
  // It couldn't run (busy, timed out): the last answer stands, so the hours don't move; asked again next time (its key is the old one).
  if (answer === null) return prev?.classifiedFor ? applyPlacement(ev, placementOf(prev), prev.classifiedFor) : ev;
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
