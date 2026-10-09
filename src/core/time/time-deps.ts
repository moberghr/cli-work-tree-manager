import { loadConfig } from '../platform/config.js';
import { loadHistory } from '../sessions/history.js';
import { sessionIdFor } from '../sessions/session-id.js';
import { sessionWorkTime } from '../conversations/work-time-source.js';
import { runGitAsync } from '../diff/git-tree-snapshot.js';
import { fetchMyIssues, issueIdOf, myAccountId, searchIssuesOrThrow } from '../jira/jira.js';
import { runInternal } from '../diff/checkpoint-summary.js';
import { chatsSince, graphApp, graphToken, meetingsOn } from './graph.js';
import type { TimeChatEvidence, TimeJiraEvidence } from '../api-types.js';
import { readIssueIds, rememberIssueId } from './time-store.js';
import { isIssueKey } from './allocate.js';
import type { TimeDeps } from './time-days.js';
import { addDays, DEFAULT_CATCH_UP_DAYS, localDay, timeSettings } from './time-view.js';

/**
 * The Time tab's real I/O: the sessions in state.db and their transcripts,
 * `git log` in every enrolled repo (your commits, by each repo's
 * `user.email`), and Jira through `acli` (what you moved; titles).
 */
async function graphTokenNow(): Promise<string | null> {
  const app = graphApp(loadConfig()?.time?.graph, process.env);
  return 'why' in app ? null : graphToken(app);
}

/**
 * The commits of a `git log --format=%H%x09%aI%x09%ce%x09%s` written on the
 * day: by author date, so a rebase, an amend or a cherry-pick counts on the
 * day of the work, not of the rewrite; and none GitHub committed (a squash
 * merge: the work is already counted by its own commits). Pure.
 */
export function commitsWrittenOn(stdout: string, day: string): Array<{ sha: string; subject: string }> {
  const out: Array<{ sha: string; subject: string }> = [];
  for (const line of stdout.split('\n').filter(Boolean)) {
    const [sha, authored, committer, ...rest] = line.split('\t');
    if (committer === 'noreply@github.com') continue;
    const at = Date.parse(authored ?? '');
    if (Number.isNaN(at) || localDay(at) !== day) continue;
    out.push({ sha, subject: rest.join('\t') });
  }
  return out;
}

/** How long one read of the Teams chats serves the days after it (a catch-up asks day by day, oldest first). */
const CHATS_FRESH_MS = 10 * 60_000;

/** What you did in Jira that day: status changes, and anything else you updated (a comment, an edit) — `updatedBy()`, by account id. */
export async function jiraOn(day: string): Promise<TimeJiraEvidence[]> {
  const d = day.replace(/-/g, '/');
  // Throws when acli can't answer: the day keeps what it had (time-days.ts), rather than "did nothing".
  const moved = await searchIssuesOrThrow(`status CHANGED BY currentUser() DURING ("${d} 00:00", "${d} 23:59")`);
  const out: TimeJiraEvidence[] = moved.map((i) => ({ key: i.key, summary: i.summary, what: `moved (now ${i.status || 'changed'})` }));
  const account = loadConfig()?.time?.tempo?.accountId || process.env.JIRA_ACCOUNT_ID || (await myAccountId());
  if (account && /^[\w:-]+$/.test(account)) {
    const next = addDays(day, 1).replace(/-/g, '/');
    const updated = await searchIssuesOrThrow(`issuekey IN updatedBy("${account}", "${d}", "${next}")`).catch(() => []);
    for (const i of updated)
      if (!out.some((o) => o.key === i.key)) out.push({ key: i.key, summary: i.summary, what: 'updated by you (a comment or an edit)' });
  }
  return out;
}

/** How long one read of a session's working time serves (a catch-up asks it once per day it builds). */
const WORK_TIME_FRESH_MS = 60_000;

/**
 * Titles of these keys and whether each is done, in one search; when that is
 * refused (one key that doesn't exist fails the whole JQL — a branch's
 * `FOO-12`), each key alone, keeping the ones found. Throws when none could be
 * asked about (acli down): the day keeps what it had.
 */
export async function titlesOf(
  keys: string[],
  search: (jql: string, limit: number) => Promise<Array<{ key: string; summary: string; statusCategory?: string }>>,
): Promise<Record<string, { title: string; done: boolean }>> {
  const valid = keys.filter(isIssueKey);
  if (!valid.length) return {};
  const of = (issues: Array<{ key: string; summary: string; statusCategory?: string }>) =>
    issues.map((i) => [i.key, { title: i.summary, done: i.statusCategory === 'done' }] as const);
  try {
    return Object.fromEntries(of(await search(`key in (${valid.join(', ')})`, valid.length)));
  } catch (err) {
    if (valid.length === 1) throw err;
    const one = await Promise.all(valid.map((k) => search(`key = ${k}`, 1).then(of, () => null)));
    if (one.every((r) => r === null)) throw err;
    return Object.fromEntries(one.flatMap((r) => r ?? []));
  }
}

export function defaultTimeDeps(): TimeDeps {
  const catchUpDays = () => timeSettings(loadConfig()?.time).catchUpDays ?? DEFAULT_CATCH_UP_DAYS;
  // A session's working time, read once for every day a run builds (each read goes through all its transcripts).
  const workTime = new Map<string, { at: number; byDay: Promise<Map<string, number>> }>();
  // One read of the chats serves every day after its first: a 14-day catch-up is one read, not fourteen.
  let chats: { from: string; at: number; byDay: Promise<Map<string, TimeChatEvidence[]>> } | null = null;
  return {
    sessions: () => loadHistory(),
    minutesOn: async (s, day) => {
      const id = sessionIdFor(s);
      let w = workTime.get(id);
      if (!w || Date.now() - w.at > WORK_TIME_FRESH_MS) {
        const byDay = sessionWorkTime(s, Date.now(), catchUpDays()).then((t) => new Map(t.byDay.map((d) => [d.day, d.ms])));
        w = { at: Date.now(), byDay };
        workTime.set(id, w);
        byDay.catch(() => workTime.delete(id)); // a failed read isn't kept
      }
      return ((await w.byDay).get(day) ?? 0) / 60_000;
    },
    minutesFrom: () => addDays(localDay(), -(catchUpDays() - 1)),
    commits: async (day) => {
      const repos = [...new Set(Object.values(loadConfig()?.repos ?? {}))];
      const seen = new Set<string>();
      const out: Array<{ repo: string; sha: string; subject: string }> = [];
      for (const repo of repos) {
        const email = (await runGitAsync(repo, { args: ['config', 'user.email'] })).stdout.trim();
        if (!email) continue;
        // --since is the committer date, never before the author date: every commit written that day is in, and more.
        // --fixed-strings: the email as it is (`jane+work@corp.com` isn't a pattern).
        const log = await runGitAsync(repo, {
          args: [
            'log',
            '--all',
            '--no-merges',
            '--fixed-strings',
            `--since=${day} 00:00:00`,
            `--author=${email}`,
            '--format=%H%x09%aI%x09%ce%x09%s',
          ],
        });
        if (log.status !== 0) continue;
        const alias = Object.entries(loadConfig()?.repos ?? {}).find(([, p]) => p === repo)?.[0] ?? repo;
        for (const c of commitsWrittenOn(log.stdout, day)) {
          if (seen.has(c.sha)) continue;
          seen.add(c.sha);
          out.push({ repo: alias, ...c });
        }
      }
      return out;
    },
    jiraMoved: jiraOn,
    titles: (keys) => titlesOf(keys, searchIssuesOrThrow),
    settings: () => timeSettings(loadConfig()?.time),
    // Outlook and Teams only once you signed in (the Time tab's Connect): none otherwise. A sign-in that stopped
    // working, or no network, throws (graphToken): the day keeps the meetings and chats it had.
    meetings: async (day) => {
      const token = await graphTokenNow();
      return token ? meetingsOn(day, token) : undefined;
    },
    chats: async (day) => {
      const token = await graphTokenNow();
      if (!token) return undefined;
      if (!chats || day < chats.from || Date.now() - chats.at > CHATS_FRESH_MS) {
        const byDay = chatsSince(day, token);
        chats = { from: day, at: Date.now(), byDay };
        byDay.catch(() => (chats = null)); // a failed read isn't kept
      }
      return (await chats.byDay).get(day) ?? [];
    },
    candidates: async () => (await fetchMyIssues()).map((i) => ({ key: i.key, title: i.summary })),
    classify: (prompt) => runInternal(prompt, 60_000, { small: true }),
    issueId: async (key) => {
      const known = readIssueIds()[key];
      if (known !== undefined) return known;
      const id = await issueIdOf(key);
      if (id !== null) rememberIssueId(key, id);
      return id;
    },
  };
}
