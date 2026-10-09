import chalk from 'chalk';
import type { CommandModule } from 'yargs';
import type { TimeDayWire, TimePostWire } from '../core/api-types.js';
import { loadConfig } from '../core/platform/config.js';
import { callWorkWeb } from '../core/platform/web-discovery.js';
import { buildDay, dayWire } from '../core/time/time-days.js';
import { defaultTimeDeps } from '../core/time/time-deps.js';
import { updateDay } from '../core/time/time-store.js';
import { postStoredDay } from '../core/time/time-actions.js';
import { tempoClient, tempoSetup } from '../core/time/tempo.js';
import { dayArg, parseEntries, parseRowArgs } from '../core/time/time-view.js';
import type { TimeEntry } from '../core/time/allocate.js';

/**
 * `work timesheet` — the Time tab from a terminal (and for the Ctrl+K
 * assistant): `show` a day's rows and why (read only); `set` its rows,
 * `reset` it to the suggestion, mark it `off`, `gather` its evidence again,
 * `post` it to Tempo. A change goes through a running work web (the tab
 * updates at once), else it's made here. Posting is the user's: never
 * pre-allowed for the assistant.
 */

function print(w: TimeDayWire): void {
  console.log(chalk.bold(`${w.day}  ${w.status}`) + chalk.gray(`  ${w.total} / ${w.settings.dayHours} h`));
  for (const e of w.entries) console.log(`  ${e.key.padEnd(12)} ${String(e.hours).padStart(5)} h  ${chalk.gray(w.titles[e.key] ?? '')}`);
  if (w.edited) console.log(chalk.gray(`  suggested: ${w.suggested.map((e) => `${e.key} ${e.hours} h`).join(', ') || 'nothing'}`));
  if (w.unallocated) console.log(chalk.yellow(`  ${w.unallocated} h unallocated (set time.gapTicket)`));
  const ev = w.evidence;
  for (const s of ev.sessions)
    console.log(chalk.gray(`  · ${s.label}: ${s.minutes} min of Claude → ${s.key ?? 'no ticket'}${s.guessed ? ' (AI)' : ''}`));
  for (const c of ev.commits) console.log(chalk.gray(`  · ${c.repo}: ${c.subject} → ${c.keys.join(', ') || 'no ticket'}`));
  for (const j of ev.jira) console.log(chalk.gray(`  · ${j.key} ${j.summary}: ${j.what}`));
  for (const m of ev.meetings ?? []) console.log(chalk.gray(`  · ${m.start}–${m.end} ${m.subject} → ${m.key ?? 'gap ticket'}`));
  for (const c of ev.chats ?? []) console.log(chalk.gray(`  · Teams ${c.chat}: ${c.messages} messages → ${c.key ?? 'no ticket'}`));
  if (w.posted) console.log(chalk.gray(`  posted to Tempo ${w.posted.at}${w.status === 'changed' ? ' (changed since)' : ''}`));
}

function fail(message: string): never {
  console.error(chalk.red(message));
  process.exit(1);
}

/** The day from an argument, or exit saying how to give one. */
function theDay(arg: unknown): string {
  const d = dayArg(typeof arg === 'string' ? arg : 'today');
  return d ?? fail(`Not a day: ${String(arg)} (today, yesterday or YYYY-MM-DD)`);
}

/** A change through work web when it runs; else here. */
async function change(day: string, body: { entries?: TimeEntry[] | null; dayOff?: boolean }): Promise<TimeDayWire> {
  const r = await callWorkWeb<TimeDayWire>('PUT', `/api/time/${day}`, body);
  if (r.ok) return r.body;
  if (r.status !== 0) fail(r.error);
  updateDay(day, {
    ...(body.entries !== undefined ? { edited: body.entries } : {}),
    ...(body.dayOff !== undefined ? { dayOff: body.dayOff } : {}),
  });
  return dayWire(day, defaultTimeDeps().settings());
}

export const timesheetCommand: CommandModule = {
  command: 'timesheet <action>',
  describe: "The Time tab's days: show, set, reset, off, gather, post (to Tempo)",
  builder: (y) =>
    y
      .command(
        'show [day]',
        "A day's rows and why (today by default)",
        (b) => b.positional('day', { type: 'string' }).option('json', { type: 'boolean' }),
        (argv) => {
          const w = dayWire(theDay(argv.day), defaultTimeDeps().settings());
          if (argv.json) console.log(JSON.stringify(w, null, 2));
          else print(w);
        },
      )
      .command(
        'set <day> <rows..>',
        "Set all of a day's rows: KEY=HOURS …",
        (b) => b.positional('day', { type: 'string' }).positional('rows', { type: 'string', array: true }),
        async (argv) => {
          const day = theDay(argv.day);
          const rows = parseRowArgs((argv.rows as string[]) ?? []);
          const entries = rows && parseEntries(rows, defaultTimeDeps().settings().stepHours);
          if (!entries)
            fail(
              `Rows: KEY=HOURS with hours in steps of ${defaultTimeDeps().settings().stepHours}, each key once (e.g. APP-1=2.5 APP-434=5)`,
            );
          print(await change(day, { entries }));
        },
      )
      .command(
        'reset <day>',
        'Back to the suggestion',
        (b) => b.positional('day', { type: 'string' }),
        async (argv) => print(await change(theDay(argv.day), { entries: null })),
      )
      .command(
        'off <day>',
        'A day off (--undo: not)',
        (b) => b.positional('day', { type: 'string' }).option('undo', { type: 'boolean' }),
        async (argv) => print(await change(theDay(argv.day), { dayOff: !argv.undo })),
      )
      .command(
        'gather <day>',
        "Gather a day's evidence again",
        (b) => b.positional('day', { type: 'string' }),
        async (argv) => {
          const day = theDay(argv.day);
          const r = await callWorkWeb<TimeDayWire>('POST', `/api/time/${day}/rebuild`, {}, 120_000);
          if (r.ok) return print(r.body);
          if (r.status !== 0) fail(r.error);
          const deps = defaultTimeDeps();
          await buildDay(day, deps);
          print(dayWire(day, deps.settings()));
        },
      )
      .command(
        'post <day>',
        'Post the day to Tempo as it shows (worklogs you made by hand are left alone)',
        (b) => b.positional('day', { type: 'string' }),
        async (argv) => {
          const day = theDay(argv.day);
          const r = await callWorkWeb<TimePostWire>('POST', `/api/time/${day}/post`, {}, 120_000);
          let out: Omit<TimePostWire, 'day'>;
          if (r.ok) out = r.body;
          else if (r.status !== 0) fail(r.error);
          else {
            const s = tempoSetup(loadConfig()?.time?.tempo, process.env);
            if (!s.ready) fail(s.why);
            out = await postStoredDay(day, defaultTimeDeps(), { api: tempoClient(s.token), accountId: s.accountId }).catch((err: Error) =>
              fail(err.message),
            );
          }
          console.log(
            `Tempo: ${out.posted} posted, ${out.removed} removed, ${out.kept} already there` +
              (out.coveredByHand ? `, ${out.coveredByHand} you had logged by hand` : '') +
              (out.otherByHand ? `; ${out.otherByHand} other worklogs of yours left alone` : ''),
          );
          for (const f of out.failed) console.log(chalk.yellow(`  not posted: ${f.key} (${f.error})`));
          if (out.failed.length) process.exitCode = 1;
        },
      )
      .demandCommand(1),
  handler: () => {},
};
