import fs from 'node:fs';
import { loadConfig } from '../platform/config.js';
import type { WorktreeSession } from '../sessions/session-types.js';
import { loadHistory } from '../sessions/history.js';
import { sessionIdFor } from '../sessions/session-id.js';
import { sessionWorkTime } from '../conversations/work-time-source.js';
import { runGitAsync } from '../diff/git-tree-snapshot.js';
import { fetchMyIssuesOrThrow, issueIdOf, myAccountId, searchIssuesOrThrow } from '../jira/jira.js';
import { runInternal } from '../diff/checkpoint-summary.js';
import { chatsOf, chatsSince, graphApp, graphToken, meetingsOn, type ChatsRead } from './graph.js';
import type { TimeJiraEvidence } from '../api-types.js';
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
 * merge: the work is already counted by its own commits), nor a stash's own
 * commits. Pure.
 */
export function commitsWrittenOn(stdout: string, day: string): Array<{ sha: string; subject: string }> {
  const out: Array<{ sha: string; subject: string }> = [];
  for (const line of stdout.split('\n').filter(Boolean)) {
    const [sha, authored, committer, ...rest] = line.split('\t');
    if (committer === 'noreply@github.com') continue;
    // A stash's helper commits, should something other than refs/stash (left out of the log) still reach them.
    if (/^(index|untracked files) on /.test(rest.join('\t'))) continue;
    const at = Date.parse(authored ?? '');
    if (Number.isNaN(at) || localDay(at) !== day) continue;
    out.push({ sha, subject: rest.join('\t') });
  }
  return out;
}

/**
 * How long one read (a session's working time, a repo's commits, the Teams
 * chats, your assigned issues) serves the days after it, at most: a run of the
 * keeper starts fresh (`fresh`), and a catch-up of slow days (the AI step can
 * take a minute) reads each once, not once per day.
 */
const READ_FRESH_MS = 30 * 60_000;

/** Issues one day's Jira search returns at most (the default 50 would cut a sprint's close or a triage short). */
export const JIRA_DAY_LIMIT = 500;

/** What you did in Jira that day: status changes, and anything else you updated (a comment, an edit) — `updatedBy()`, by account id. */
export async function jiraOn(day: string): Promise<TimeJiraEvidence[]> {
  const d = day.replace(/-/g, '/');
  // To the next day's start, not 23:59: a change in a day's last minute would be on no day at all.
  const end = addDays(day, 1).replace(/-/g, '/');
  // Throws when acli can't answer: the day keeps what it had (time-days.ts), rather than "did nothing".
  const moved = await searchIssuesOrThrow(`status CHANGED BY currentUser() DURING ("${d} 00:00", "${end} 00:00")`, JIRA_DAY_LIMIT);
  const out: TimeJiraEvidence[] = moved.map((i) => ({ key: i.key, summary: i.summary, what: `moved (now ${i.status || 'changed'})` }));
  const account = loadConfig()?.time?.tempo?.accountId || process.env.JIRA_ACCOUNT_ID || (await myAccountId());
  if (account && /^[\w:-]+$/.test(account)) {
    // The same bounds, with times (a bare end date may mean the whole of that day, or its start).
    // A failure throws too: half the answer would drop the day's commented-on issues.
    const updated = await searchIssuesOrThrow(`issuekey IN updatedBy("${account}", "${d} 00:00", "${end} 00:00")`, JIRA_DAY_LIMIT);
    for (const i of updated)
      if (!out.some((o) => o.key === i.key)) out.push({ key: i.key, summary: i.summary, what: 'updated by you (a comment or an edit)' });
  }
  return out;
}

/**
 * Titles of these keys and whether each is done, in one search; when that is
 * refused (one key that doesn't exist fails the whole JQL — a branch's
 * `FOO-12`), each key alone, keeping the ones found. Throws when none could be
 * asked about (acli down): the day keeps what it had.
 */
export async function titlesOf(
  keys: string[],
  search: (jql: string, limit: number) => Promise<Array<{ key: string; summary: string; statusCategory?: string }>>,
  now = Date.now(),
): Promise<Record<string, { title: string; done: boolean }>> {
  // Keys Jira said it doesn't have stay out of the search for an hour: one such key would send every rebuild
  // of the day down the one-key-at-a-time path.
  for (const [k, at] of refused) if (now - at > REFUSED_FOR_MS) refused.delete(k);
  const valid = keys.filter((k) => isIssueKey(k) && !refused.has(k));
  if (!valid.length) return {};
  const of = (issues: Array<{ key: string; summary: string; statusCategory?: string }>) =>
    issues.map((i) => [i.key, { title: i.summary, done: i.statusCategory === 'done' }] as const);
  try {
    return Object.fromEntries(of(await search(`key in (${valid.join(', ')})`, valid.length)));
  } catch (err) {
    if (valid.length === 1) throw err;
    // A few at a time (each is an acli process).
    const one: Array<ReturnType<typeof of> | null> = [];
    for (let i = 0; i < valid.length; i += TITLES_AT_ONCE)
      one.push(...(await Promise.all(valid.slice(i, i + TITLES_AT_ONCE).map((k) => search(`key = ${k}`, 1).then(of, () => null)))));
    if (one.every((r) => r === null)) throw err;
    // Asked alone and still refused, while others answered: Jira doesn't have it.
    one.forEach((r, i) => r === null && refused.set(valid[i], now));
    return Object.fromEntries(one.flatMap((r) => r ?? []));
  }
}

const TITLES_AT_ONCE = 3;
const REFUSED_FOR_MS = 60 * 60_000;
const refused = new Map<string, number>();

/** Forget the keys Jira refused (tests). */
export function resetRefusedKeys(): void {
  refused.clear();
}

/** What `defaultTimeDeps` reads with (tests pass their own). */
export interface TimeIo {
  git: (cwd: string, args: string[]) => Promise<{ status: number | null; stdout: string }>;
  workTime: (s: WorktreeSession, now: number, days: number) => Promise<{ byDay: Array<{ day: string; ms: number }> }>;
  /** Enrolled repos: alias → folder. */
  repos: () => Record<string, string>;
  exists: (folder: string) => boolean;
}

const realIo: TimeIo = {
  git: (cwd, args) => runGitAsync(cwd, { args }),
  workTime: (s, now, days) => sessionWorkTime(s, now, days),
  repos: () => loadConfig()?.repos ?? {},
  exists: (folder) => fs.existsSync(folder),
};

/**
 * Your commits in one repo since a day, read once (a catch-up asks day by day,
 * oldest first: one `git log` from the oldest serves the rest).
 * `--exclude=refs/stash` keeps a stash's commits out; `--since` is the
 * committer date, never before the author date, so every commit written
 * since is in (and more, which `commitsWrittenOn` drops); `--fixed-strings`:
 * the email as it is (`jane+work@corp.com` isn't a pattern), whole (`<…>`). No email set:
 * none of yours to find (''). A git that fails throws: the day keeps the
 * commits it had.
 */
async function commitLog(git: TimeIo['git'], repo: string, from: string): Promise<string> {
  const email = (await git(repo, ['config', 'user.email'])).stdout.trim();
  if (!email) return '';
  const log = await git(repo, [
    'log',
    '--exclude=refs/stash',
    '--all',
    '--no-merges',
    '--fixed-strings',
    `--since=${from} 00:00:00`,
    // The address in its angle brackets: --author matches anywhere in "Name <email>", and `an@corp` is in `ivan@corp`.
    `--author=<${email}>`,
    '--format=%H%x09%aI%x09%ce%x09%s',
  ]);
  if (log.status !== 0) throw new Error(`git log failed in ${repo}`);
  return log.stdout;
}

export function defaultTimeDeps(io: TimeIo = realIo): TimeDeps {
  const catchUpDays = () => timeSettings(loadConfig()?.time).catchUpDays ?? DEFAULT_CATCH_UP_DAYS;
  // A session's working time, read once for every day a run builds (each read goes through all its transcripts).
  const workTime = new Map<string, { at: number; byDay: Promise<Map<string, number>> }>();
  const logs = new Map<string, { from: string; at: number; out: Promise<string> }>();
  // One read of the chats serves every day after its first: a 14-day catch-up is one read, not fourteen.
  let chats: { from: string; at: number; read: Promise<ChatsRead> } | null = null;
  let assigned: { at: number; list: Promise<Array<{ key: string; title: string }>> } | null = null;
  // What a turn doesn't move, read once until the next full run: a day's meetings, its Jira, its tickets' titles
  // (network: Graph and acli, every two minutes while Claude works otherwise).
  const slow = new Map<string, { at: number; read: Promise<unknown> }>();
  const once = <T>(key: string, read: () => Promise<T>): Promise<T> => {
    const c = slow.get(key);
    if (c && Date.now() - c.at <= READ_FRESH_MS) return c.read as Promise<T>;
    const p = read();
    slow.set(key, { at: Date.now(), read: p });
    p.catch(() => slow.delete(key)); // a failed read isn't kept
    return p;
  };
  return {
    fresh: (what = 'all') => {
      workTime.clear();
      logs.clear();
      if (what === 'local') return;
      chats = null;
      slow.clear();
      assigned = null;
    },
    sessions: () => loadHistory(),
    minutesOn: async (s, day) => {
      const id = sessionIdFor(s);
      let w = workTime.get(id);
      if (!w || Date.now() - w.at > READ_FRESH_MS) {
        const byDay = io.workTime(s, Date.now(), catchUpDays()).then((t) => new Map(t.byDay.map((d) => [d.day, d.ms])));
        w = { at: Date.now(), byDay };
        workTime.set(id, w);
        byDay.catch(() => workTime.delete(id)); // a failed read isn't kept
      }
      return ((await w.byDay).get(day) ?? 0) / 60_000;
    },
    minutesFrom: () => addDays(localDay(), -(catchUpDays() - 1)),
    commits: async (day) => {
      const repos = io.repos();
      const aliasOf = new Map<string, string>();
      for (const [alias, folder] of Object.entries(repos)) if (!aliasOf.has(folder)) aliasOf.set(folder, alias);
      const seen = new Set<string>();
      const out: Array<{ repo: string; sha: string; subject: string }> = [];
      // Every repo's read started at once (each a git process), then taken in order.
      const reads = [...aliasOf.keys()]
        .filter((repo) => io.exists(repo)) // a folder gone: nothing to read there (not a failure)
        .map((repo) => {
          let l = logs.get(repo);
          if (!l || day < l.from || Date.now() - l.at > READ_FRESH_MS) {
            const read = commitLog(io.git, repo, day);
            l = { from: day, at: Date.now(), out: read };
            logs.set(repo, l);
            read.catch(() => logs.delete(repo)); // a failed read isn't kept
          }
          return { repo, out: l.out };
        });
      for (const { repo, out: log } of reads) {
        for (const c of commitsWrittenOn(await log, day)) {
          if (seen.has(c.sha)) continue;
          seen.add(c.sha);
          out.push({ repo: aliasOf.get(repo) ?? repo, ...c });
        }
      }
      return out;
    },
    jiraMoved: (day) => once(`jira:${day}`, () => jiraOn(day)),
    titles: (keys) => once(`titles:${[...keys].sort().join(',')}`, () => titlesOf(keys, searchIssuesOrThrow)),
    settings: () => timeSettings(loadConfig()?.time),
    // Outlook and Teams only once you signed in (the Time tab's Connect): none otherwise. A sign-in that stopped
    // working, or no network, throws (graphToken): the day keeps the meetings and chats it had.
    meetings: async (day) => {
      const token = await graphTokenNow();
      return token ? once(`meetings:${day}`, () => meetingsOn(day, token)) : undefined;
    },
    chats: async (day) => {
      const token = await graphTokenNow();
      if (!token) return undefined;
      if (!chats || day < chats.from || Date.now() - chats.at > READ_FRESH_MS) {
        const read = chatsSince(day, token);
        chats = { from: day, at: Date.now(), read };
        read.catch(() => (chats = null)); // a failed read isn't kept
      }
      // A chat busier than was read reached back only so far: a day before that isn't known, and keeps what it had.
      return chatsOf(await chats.read, day);
    },
    // Throws when acli can't list them: the day keeps its AI answer and the projects it knew (time-days.ts).
    candidates: () => {
      if (!assigned || Date.now() - assigned.at > READ_FRESH_MS) {
        const list = fetchMyIssuesOrThrow().then((is) => is.map((i) => ({ key: i.key, title: i.summary })));
        assigned = { at: Date.now(), list };
        list.catch(() => (assigned = null)); // a failed read isn't kept
      }
      return assigned.list;
    },
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
