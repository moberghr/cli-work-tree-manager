import type { WorktreeSession } from '../sessions/session-types.js';
import { sessionIdFor } from '../sessions/session-id.js';
import type { TimeCommitEvidence, TimeDaysWire, TimeDayWire, TimeEvidence, TimeJiraEvidence } from '../api-types.js';
import { issueKeys } from './allocate.js';
import { applyPlacement, classifyPrompt, parsePlacement, placementOf, unplacedHash, unplacedItems } from './classify.js';
import { readDay, readDays, saveBuilt } from './time-store.js';
import { hintKey } from './hints.js';
import { activityOf, addDays, dayWireOf, localDay, daysWireOf, sessionTicket, type TimeConfig, type TimeDayRecord } from './time-view.js';

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
  /**
   * Start a run afresh: what was read for earlier days is read again (the
   * keeper's run, a Gather). `local`: only what a turn changes (Claude
   * minutes, commits); Teams and your assigned issues stand (network, and a
   * turn doesn't move them).
   */
  fresh?: (what?: 'all' | 'local') => void;
  /** The AI step (runInternal): the answer, or null when it can't run. */
  classify?: (prompt: string) => Promise<string | null>;
  /** A Jira issue's numeric id (Tempo wants it), cached. */
  issueId?: (key: string) => Promise<number | null>;
  now?: () => number;
}

/** How long Claude Code keeps its transcripts (its `cleanupPeriodDays` default): a day older reads nothing, not "none". */
export const TRANSCRIPTS_KEPT_DAYS = 30;

/** Candidate tickets beyond the day's own that the AI step is shown. */
export const CANDIDATES_SHOWN = 50;

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
export function buildDay(day: string, deps: TimeDeps, opts: { again?: boolean } = {}): Promise<TimeDayRecord> {
  const running = building.get(day);
  // A build under way read before this ask: joined, unless it's to be read again (a Gather) — then after it.
  if (running && !opts.again) return running;
  const p = (running ? running.catch(() => undefined).then(() => buildNow(day, deps)) : buildNow(day, deps)).finally(() => {
    if (building.get(day) === p) building.delete(day);
  });
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
  // Your assigned issues (AI candidates, projects); not readable this time: the ones the day had, so neither moves.
  const assigned = deps.candidates
    ? await deps.candidates().catch(() => (prev?.assigned ?? []).map((key) => ({ key, title: prev?.titles[key] ?? '' })))
    : [];
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
  // Each session's minutes, or null when its read failed.
  const read: Array<number | null> = [];
  for (let i = 0; i < could.length; i += MINUTES_AT_ONCE)
    read.push(...(await Promise.all(could.slice(i, i + MINUTES_AT_ONCE).map((s) => deps.minutesOn(s, day).then(Math.round, () => null)))));
  const unread = new Set(could.filter((_, i) => read[i] === null).map(sessionIdFor));
  for (const [i, s] of could.entries()) {
    const minutes = read[i];
    if (minutes === null || minutes <= 0) continue;
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
      // A session the day had keeps its minutes when they can't be read now: deleted since, its read failed, or
      // the day is past what Claude Code keeps of its transcripts (about 30 days). Read now as nothing — a
      // successful read — it had none: a figure measured too high comes down.
      const ids = new Set(all.map(sessionIdFor));
      const transcriptsGone = day < addDays(localDay(deps.now?.() ?? Date.now()), -(TRANSCRIPTS_KEPT_DAYS - 1));
      const got = new Set(sessions.map((x) => x.sessionId));
      sessions.push(
        ...had.sessions.filter((h) => !got.has(h.sessionId) && (!ids.has(h.sessionId) || unread.has(h.sessionId) || transcriptsGone)),
      );
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
  evidence = await placeTheRest(evidence, prev?.evidence, titles, settings, deps, [...hinted, ...assigned]);
  // A ticket the AI step put something on has its title kept (only those).
  for (const c of [...assigned, ...hinted])
    if (c.title && !titles[c.key] && activityOf(evidence).some((a) => a.key === c.key)) titles[c.key] = c.title;
  return saveBuilt({
    day,
    evidence,
    titles,
    builtAt: new Date(deps.now?.() ?? Date.now()).toISOString(),
    ...(resolved.length ? { resolved } : {}),
    ...(assigned.length ? { assigned: assigned.map((a) => a.key) } : {}),
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
  // Candidates beyond the day's own: at most CANDIDATES_SHOWN of them (the hints, then your most recently updated
  // issues) — a backlog of hundreds would only make the prompt long. Their titles aren't kept with the day.
  const shown = extra.slice(0, CANDIDATES_SHOWN);
  const promptTitles: Record<string, string> = { ...titles };
  for (const c of shown) promptTitles[c.key] ??= c.title;
  const own = [...activityOf(ev).map((a) => a.key), settings.gapTicket, settings.timeOffTicket].filter((k): k is string => !!k);
  const keys = [...new Set([...own, ...shown.map((c) => c.key)])];
  // Asked again when the day's items or its own tickets change — not when an issue is assigned or closed somewhere
  // in your backlog: that would ask again about every day, and move placements on days long done.
  const hash = unplacedHash(items, [...new Set(own)]);
  if (prev?.classifiedFor === hash) return applyPlacement(ev, placementOf(prev), hash);
  const answer = await deps
    .classify(
      classifyPrompt(
        items,
        keys.map((key) => ({ key, title: promptTitles[key] ?? '' })),
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
