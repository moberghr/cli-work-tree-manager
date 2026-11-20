import chalk from 'chalk';
import type { CommandModule } from 'yargs';
import { RAIL_COLORS, RAIL_COLOR_LABEL, type RailColor } from '../core/rail/rail-layout.js';
import { placeSession, readRailLayout } from '../core/rail/rail-store.js';
import { sessionIdFor } from '../core/sessions/session-id.js';
import { sessionFromArgs, sessionPositionals } from './shared/session-arg.js';

/**
 * `work color` — mark a session with one of the rail's colors (rail-layout.ts:
 * a bar on its rail row, a square in the dashboard's lists), take it off with
 * `--off`, or print it with neither.
 */
export const colorCommand: CommandModule = {
  command: 'color [target] [branch]',
  describe: "Mark a session with a color on the dashboard's rail (default: the session for this folder)",
  builder: (yargs) =>
    sessionPositionals(yargs)
      .option('set', { type: 'string', choices: RAIL_COLORS, describe: 'The color' })
      .option('off', { type: 'boolean', describe: 'Take its color off' })
      .conflicts('set', 'off'),
  handler: (argv) => {
    const s = sessionFromArgs(argv);
    if (!s) return;
    const id = sessionIdFor(s);
    const name = `${s.target} · ${s.branch}`;
    if (!argv.set && !argv.off) {
      const color = readRailLayout().places[id]?.color;
      console.log(color ? RAIL_COLOR_LABEL[color] : chalk.gray(`No color: \`work color --set <${RAIL_COLORS.join('|')}>\` gives it one.`));
      return;
    }
    const color = argv.off ? null : (argv.set as RailColor);
    const r = placeSession(id, { color });
    if (!r.ok) {
      console.error(chalk.red(r.error));
      process.exitCode = 1;
      return;
    }
    console.log(chalk.green(color ? `Colored ${name} ${color}.` : `Took the color off ${name}.`));
  },
};
