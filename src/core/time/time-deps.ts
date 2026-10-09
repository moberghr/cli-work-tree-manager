import { loadConfig } from '../platform/config.js';
import { loadHistory } from '../sessions/history.js';
import { sessionWorkTime } from '../conversations/work-time-source.js';
import { runGitAsync } from '../diff/git-tree-snapshot.js';
import { fetchMyIssues, issueIdOf, searchIssues, searchIssuesOrThrow } from '../jira/jira.js';
import { runInternal } from '../diff/checkpoint-summary.js';
import { chatsOn, graphApp, graphToken, meetingsOn } from './graph.js';
import { readIssueIds, rememberIssueId } from './time-store.js';
import { isIssueKey } from './allocate.js';
import type { TimeDeps } from './time-days.js';
import { localDay, timeSettings } from './time-view.js';

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

export function defaultTimeDeps(): TimeDeps {
  return {
    sessions: () => loadHistory(),
    minutesOn: async (s, day) => ((await sessionWorkTime(s)).byDay.find((d) => d.day === day)?.ms ?? 0) / 60_000,
    commits: async (day) => {
      const repos = [...new Set(Object.values(loadConfig()?.repos ?? {}))];
      const seen = new Set<string>();
      const out: Array<{ repo: string; sha: string; subject: string }> = [];
      for (const repo of repos) {
        const email = (await runGitAsync(repo, { args: ['config', 'user.email'] })).stdout.trim();
        if (!email) continue;
        // --since is the committer date, never before the author date: every commit written that day is in, and more.
        const log = await runGitAsync(repo, {
          args: ['log', '--all', '--no-merges', `--since=${day} 00:00:00`, `--author=${email}`, '--format=%H%x09%aI%x09%ce%x09%s'],
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
    jiraMoved: async (day) => {
      const d = day.replace(/-/g, '/');
      // Throws when acli can't answer: the day keeps what it had (time-days.ts), rather than "moved nothing".
      const issues = await searchIssuesOrThrow(`status CHANGED BY currentUser() DURING ("${d} 00:00", "${d} 23:59")`);
      return issues.map((i) => ({ key: i.key, summary: i.summary, what: `moved (now ${i.status || 'changed'})` }));
    },
    titles: async (keys) => {
      // Only well-formed keys: one bad key fails the whole JQL.
      const valid = keys.filter(isIssueKey);
      if (!valid.length) return {};
      const issues = await searchIssues(`key in (${valid.join(', ')})`, valid.length);
      return Object.fromEntries(issues.map((i) => [i.key, i.summary]));
    },
    settings: () => timeSettings(loadConfig()?.time),
    // Outlook and Teams only once you signed in (the Time tab's Connect): none otherwise. A sign-in that stopped
    // working, or no network, throws (graphToken): the day keeps the meetings and chats it had.
    meetings: async (day) => {
      const token = await graphTokenNow();
      return token ? meetingsOn(day, token) : undefined;
    },
    chats: async (day) => {
      const token = await graphTokenNow();
      return token ? chatsOn(day, token) : undefined;
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
