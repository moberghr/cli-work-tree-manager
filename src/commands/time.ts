import chalk from 'chalk';
import type { CommandModule } from 'yargs';
import { loadConfig } from '../core/config.js';
import { loadHistory } from '../core/history.js';
import { jiraWorklogPoster, loggedDays, logWorkDay, worklogSettings } from '../core/jira-worklog.js';
import { sessionIdFor } from '../core/session-id.js';
import { sessionWorkTime } from '../core/work-time-source.js';
import { dayKey, formatWorked, worklogTime } from '../core/work-time-view.js';
import { sessionFromArgs, sessionPositionals } from './shared/session-arg.js';

/**
 * `work time` — how long a session's Claude worked (work-time.ts), per day;
 * `--all` this week (or `--days N`) across every session; `--log` writes a
 * day of it to the session's Jira issue as a worklog (jira-worklog.ts).
 */
export const timeCommand: CommandModule = {
  command: 'time [target] [branch]',
  describe: "How long sessions' Claude worked: one session per day, or --all (a weekly report); --log writes it to Jira",
  builder: (yargs) =>
    sessionPositionals(yargs)
      .option('all', { type: 'boolean', describe: 'Every session, the last --days days (default 7)' })
      .option('days', { type: 'number', default: 7, describe: 'With --all: how many days back' })
      .option('log', { type: 'boolean', describe: "Write a day's work to the session's Jira issue as a worklog (what isn't logged yet)" })
      .option('day', { type: 'string', describe: 'With --log: which day (YYYY-MM-DD; default: the latest it worked)' })
      .conflicts('all', 'log'),
  handler: async (argv) => {
    if (argv.all) {
      const days = Math.max(1, Math.min(31, Number(argv.days) || 7));
      const since = dayKey(Date.now() - (days - 1) * 86_400_000);
      const rows: Array<{ name: string; ms: number; jira?: string }> = [];
      for (const s of loadHistory()) {
        const t = await sessionWorkTime(s);
        const ms = t.byDay.filter((d) => d.day >= since).reduce((n, d) => n + d.ms, 0);
        if (ms >= 60_000) rows.push({ name: `${s.target} · ${s.title ? s.title : s.branch}`, ms, ...(s.jiraKey ? { jira: s.jiraKey } : {}) });
      }
      rows.sort((a, b) => b.ms - a.ms);
      if (rows.length === 0) console.log(chalk.gray(`No Claude work in the last ${days} days.`));
      for (const r of rows) console.log(`${formatWorked(r.ms).padStart(7)}  ${r.name}${r.jira ? chalk.gray(`  ${r.jira}`) : ''}`);
      if (rows.length) console.log(chalk.bold(`${formatWorked(rows.reduce((n, r) => n + r.ms, 0)).padStart(7)}  in all (since ${since})`));
      return;
    }
    const s = sessionFromArgs(argv);
    if (!s) return;
    const id = sessionIdFor(s);
    const time = await sessionWorkTime(s);
    if (argv.log) {
      const settings = worklogSettings(loadConfig());
      if (!settings) {
        console.error(chalk.red('Jira worklogs are not set up: add jiraWorklog { site, email } to ~/.work/config.json and put an API token in JIRA_API_TOKEN.'));
        process.exitCode = 1;
        return;
      }
      if (!s.jiraKey) {
        console.error(chalk.red('This session has no Jira issue (work tree … --jira-key KEY).'));
        process.exitCode = 1;
        return;
      }
      const day = typeof argv.day === 'string' ? time.byDay.find((d) => d.day === argv.day) : time.byDay[0];
      if (!day) {
        console.error(chalk.red('No work that day to log.'));
        process.exitCode = 1;
        return;
      }
      const r = await logWorkDay(id, s.jiraKey, day.day, day.ms, jiraWorklogPoster(settings));
      if (!r.ok) {
        console.error(chalk.red(r.error));
        process.exitCode = 1;
        return;
      }
      console.log(chalk.green(r.text));
      return;
    }
    const logged = loggedDays(id);
    console.log(chalk.bold(`${s.target} · ${s.branch}: about ${formatWorked(time.workedMs)} of Claude work over ${time.prompts} prompt${time.prompts === 1 ? '' : 's'}`));
    for (const d of time.byDay) {
      const l = logged[d.day];
      console.log(`  ${d.day}  ${formatWorked(d.ms).padStart(7)}${l ? chalk.gray(`  logged ${worklogTime(l.seconds * 1000)} on ${l.issueKey}`) : ''}`);
    }
    console.log(chalk.gray('  (the time between its steps, at most 15 minutes each: your reading and typing is not counted)'));
  },
};
