import { loadConfig } from '../platform/config.js';
import { loadHistory } from '../sessions/history.js';
import { sessionWorkTime } from '../conversations/work-time-source.js';
import { runGitAsync } from '../diff/git-tree-snapshot.js';
import { fetchMyIssues, issueIdOf, searchIssues } from '../jira/jira.js';
import { runInternal } from '../diff/checkpoint-summary.js';
import { chatsOn, graphApp, graphToken, meetingsOn } from './graph.js';
import { readIssueIds, rememberIssueId } from './time-store.js';
import { ISSUE_KEY } from './allocate.js';
import type { TimeDeps } from './time-days.js';
import { timeSettings } from './time-view.js';

/**
 * The Time tab's real I/O: the sessions in state.db and their transcripts,
 * `git log` in every enrolled repo (your commits, by each repo's
 * `user.email`), and Jira through `acli` (what you moved; titles).
 */
async function graphTokenNow(): Promise<string | null> {
  const app = graphApp(loadConfig()?.time?.graph, process.env);
  return 'why' in app ? null : graphToken(app);
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
        const log = await runGitAsync(repo, {
          args: [
            'log',
            '--all',
            '--no-merges',
            `--since=${day} 00:00:00`,
            `--until=${day} 23:59:59`,
            `--author=${email}`,
            '--format=%H%x09%s',
          ],
        });
        if (log.status !== 0) continue;
        const alias = Object.entries(loadConfig()?.repos ?? {}).find(([, p]) => p === repo)?.[0] ?? repo;
        for (const line of log.stdout.split('\n').filter(Boolean)) {
          const [sha, ...rest] = line.split('\t');
          if (seen.has(sha)) continue;
          seen.add(sha);
          out.push({ repo: alias, sha, subject: rest.join('\t') });
        }
      }
      return out;
    },
    jiraMoved: async (day) => {
      const d = day.replace(/-/g, '/');
      const issues = await searchIssues(`status CHANGED BY currentUser() DURING ("${d} 00:00", "${d} 23:59")`);
      return issues.map((i) => ({ key: i.key, summary: i.summary, what: `moved (now ${i.status || 'changed'})` }));
    },
    titles: async (keys) => {
      // Only well-formed keys: one bad key fails the whole JQL.
      const valid = keys.filter((k) => new RegExp(`^${ISSUE_KEY.source}$`).test(k));
      if (!valid.length) return {};
      const issues = await searchIssues(`key in (${valid.join(', ')})`, valid.length);
      return Object.fromEntries(issues.map((i) => [i.key, i.summary]));
    },
    settings: () => timeSettings(loadConfig()?.time),
    // Outlook and Teams only once you signed in (the Time tab's Connect): none otherwise.
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
