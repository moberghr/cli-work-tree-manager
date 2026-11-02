import chalk from 'chalk';
import type { CommandModule } from 'yargs';
import { loadHistory } from '../core/sessions/history.js';
import { sessionWire, lastActiveMs } from '../core/sessions/session-wire.js';
import {
  AGE_LABEL,
  DISPLAY_LABEL,
  OWED_LONG,
  ageBucket,
  displayStatus,
  waitingOnOthers,
  type AgeBucket,
  type DisplayKind,
} from '../core/sessions/session-view.js';
import { owedToYou } from '../core/status/attention.js';
import { scanChanges } from '../core/diff/overlap-scan.js';
import { timeAgo } from '../core/platform/format.js';
import { livePtys } from './shared/live-ptys.js';
import { statusFromOutput } from '../core/pty/output-status.js';
import type { SessionWire } from '../core/api-types.js';

/** A `work sessions --json` row: the dashboard's row, plus what it shows
 *  derived from it: what its agent is doing (status, label), what waits on
 *  you about it (`needsYou`, the dashboard's badge: replies to post, review
 *  threads, a PR to merge or fix), whether its PR waits on others, its age
 *  section and when it was last active. */
export interface SessionRow extends SessionWire {
  view: { status: DisplayKind; label: string; needsYou: string[]; inReview: boolean; age: AgeBucket; lastActive: string };
}

export function sessionRows(wires: SessionWire[], now = Date.now()): SessionRow[] {
  return wires
    .map((w) => {
      const status = displayStatus(w, now);
      return {
        ...w,
        view: {
          status,
          label: DISPLAY_LABEL[status],
          needsYou: owedToYou(w).map((o) => OWED_LONG[o.kind](o.count)),
          inReview: waitingOnOthers(w),
          age: ageBucket(w, now),
          lastActive: new Date(lastActiveMs(w)).toISOString(),
        },
      };
    })
    .sort((a, b) => b.view.lastActive.localeCompare(a.view.lastActive));
}

const COLOR: Partial<Record<DisplayKind, (s: string) => string>> = {
  needs_input: chalk.red,
  done: chalk.blue,
  working: chalk.green,
  background: chalk.cyan,
  active: chalk.green,
};

export const sessionsCommand: CommandModule = {
  command: 'sessions [target]',
  describe: 'Every session with its status, as the dashboard shows it (--json for scripts and Claude)',
  builder: (yargs) =>
    yargs
      .positional('target', { type: 'string', describe: 'Only this repo alias or group' })
      .option('json', { type: 'boolean', default: false, describe: 'Machine-readable rows (the dashboard API shape plus a `view` block)' })
      .option('all', { type: 'boolean', default: false, describe: 'Include sessions older than a week, and archived ones' })
      .option('changes', { type: 'boolean', default: false, describe: 'Also compute +N −M and same-file overlaps (runs git per session)' }),
  handler: async (argv) => {
    const target = argv.target as string | undefined;
    const all = argv.all as boolean;
    const history = loadHistory().filter((s) => !target || s.target === target);
    const live = await livePtys();
    const now = Date.now();
    const changes = argv.changes ? await scanChanges(history) : null;
    const wires = history.map((s) => {
      const w = sessionWire(s, {
        ...(live
          ? {
              ptyLive: (id: string) => live.has(id),
              outputStatusFor: (id: string) => {
                const p = live.get(id);
                return p ? statusFromOutput(p, now) : null;
              },
            }
          : {}),
        ...(changes ? { diffStatFor: (id: string) => changes.stats.get(id) ?? null } : {}),
      });
      const o = changes?.overlaps.get(w.id);
      return o ? { ...w, overlaps: o } : w;
    });
    const rows = sessionRows(wires).filter((r) => all || (!r.archivedAt && r.view.age !== 'older'));

    if (argv.json) {
      process.stdout.write(JSON.stringify(rows, null, 2) + '\n');
      return;
    }
    if (rows.length === 0) {
      console.log(chalk.gray(all ? 'No sessions.' : 'No session used in the last week (--all shows every one).'));
      return;
    }
    for (const age of ['now', 'week', 'older'] as AgeBucket[]) {
      const group = rows.filter((r) => r.view.age === age);
      if (group.length === 0) continue;
      console.log(chalk.bold(`${AGE_LABEL[age]} (${group.length})`));
      for (const r of group) {
        const label = (COLOR[r.view.status] ?? chalk.gray)(r.view.label.padEnd(16));
        const name = `${chalk.gray(r.target)} ${r.branch}`;
        const bits = [
          chalk.gray(timeAgo(r.view.lastActive).padStart(8)),
          r.context ? chalk.gray(`ctx ${Math.round((r.context.used / r.context.window) * 100)}%`) : '',
          r.diffStat?.files ? `${chalk.green(`+${r.diffStat.added}`)} ${chalk.red(`−${r.diffStat.deleted}`)}` : '',
          r.overlaps?.length ? chalk.yellow(`⚠ same files as ${r.overlaps.map((o) => o.branch).join(', ')}`) : '',
          r.view.needsYou.length ? chalk.magenta(`needs you: ${r.view.needsYou.join(', ')}`) : '',
          r.view.inReview ? chalk.gray('in review') : '',
          r.archivedAt ? chalk.gray('archived') : '',
        ].filter(Boolean);
        console.log(`  ${label} ${name}  ${bits.join('  ')}`);
        if (r.attention?.summary) console.log(chalk.gray(`  ${''.padEnd(16)} ${r.attention.summary}`));
      }
      console.log('');
    }
  },
};
