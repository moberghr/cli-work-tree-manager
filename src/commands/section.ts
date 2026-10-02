import chalk from 'chalk';
import type { CommandModule } from 'yargs';
import { newSectionId } from '../core/rail-layout.js';
import { changeRailSections, placeSession, readRailLayout } from '../core/rail-store.js';
import { sessionIdFor } from '../core/session-id.js';
import { sessionFromArgs, sessionPositionals } from './shared/session-arg.js';

/**
 * `work section` — put a session under one of the rail's sections (made when
 * it doesn't exist yet), take it out with `--none`, or `--list` them.
 */
export const sectionCommand: CommandModule = {
  command: 'section [target] [branch]',
  describe: "Put a session under a section of the dashboard's rail (default: the session for this folder)",
  builder: (yargs) =>
    sessionPositionals(yargs)
      .option('to', { type: 'string', describe: 'The section (made if there is none of that name)' })
      .option('none', { type: 'boolean', describe: 'Take it out of its section' })
      .option('list', { type: 'boolean', describe: 'List the sections' })
      .conflicts('to', 'none'),
  handler: (argv) => {
    if (argv.list) {
      const layout = readRailLayout();
      if (layout.sections.length === 0) console.log(chalk.gray('No sections yet: `work section --to <name>` makes one.'));
      for (const sec of layout.sections) {
        const n = Object.values(layout.places).filter((p) => p.section === sec.id && !p.pinned).length;
        console.log(`${sec.name}  ${chalk.gray(`(${n})`)}`);
      }
      return;
    }
    if (!argv.to && !argv.none) {
      console.error(chalk.red('Give --to <section>, --none, or --list.'));
      process.exitCode = 1;
      return;
    }
    const s = sessionFromArgs(argv);
    if (!s) return;
    const id = sessionIdFor(s);
    if (argv.none) {
      placeSession(id, { section: null });
      console.log(chalk.green(`Took ${s.target} · ${s.branch} out of its section.`));
      return;
    }
    const name = String(argv.to).trim();
    let sec = readRailLayout().sections.find((x) => x.name.toLowerCase() === name.toLowerCase());
    if (!sec) {
      const made = changeRailSections({ op: 'add', id: newSectionId(), name });
      if (!made.ok) {
        console.error(chalk.red(made.error));
        process.exitCode = 1;
        return;
      }
      sec = made.layout.sections.find((x) => x.name === name.slice(0, 40));
    }
    const r = sec ? placeSession(id, { pinned: false, section: sec.id }) : { ok: false as const, error: 'the section could not be made' };
    if (!r.ok) {
      console.error(chalk.red(r.error));
      process.exitCode = 1;
      return;
    }
    console.log(chalk.green(`Moved ${s.target} · ${s.branch} to “${sec!.name}”.`));
  },
};
