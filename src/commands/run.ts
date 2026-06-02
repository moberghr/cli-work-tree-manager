import chalk from 'chalk';
import spawn from 'cross-spawn';
import type { CommandModule } from 'yargs';
import { loadHistory } from '../core/history.js';
import {
  selectSessions,
  expandRunUnits,
  anyFailed,
  type RunResult,
  type RunUnit,
} from '../core/fleet.js';

/** Build the shell invocation for the current platform. `sh -c <cmd>` on
 *  POSIX, `cmd.exe /c <cmd>` on Windows. We pass cross-spawn an argv array
 *  with shell:false — the user's command string is the intentional payload,
 *  but we never interpolate paths/branches into a shell string ourselves. */
function shellInvocation(cmd: string): { bin: string; args: string[] } {
  if (process.platform === 'win32') {
    return { bin: 'cmd.exe', args: ['/c', cmd] };
  }
  return { bin: 'sh', args: ['-c', cmd] };
}

function runInPath(unit: RunUnit, cmd: string): Promise<RunResult> {
  const { bin, args } = shellInvocation(cmd);
  return new Promise((resolve) => {
    const child = spawn(bin, args, {
      cwd: unit.path,
      stdio: 'inherit',
      shell: false,
    });
    child.on('close', (code) => {
      resolve({ ...unit, code, ok: code === 0 });
    });
    child.on('error', () => {
      resolve({ ...unit, code: null, ok: false });
    });
  });
}

function label(r: RunResult): string {
  const head = chalk.cyan(`[${r.session.target}/${r.session.branch}]`);
  const where = chalk.gray(`(${r.path})`);
  if (r.ok) {
    return `${head} ${where} ${chalk.green('✓')} exit 0`;
  }
  const codeStr = r.code === null ? 'signalled' : `exit ${r.code}`;
  return `${head} ${where} ${chalk.red('✗')} ${codeStr}`;
}

export const runCommand: CommandModule = {
  command: 'run <cmd..>',
  describe: 'Run a shell command in every worktree (optionally filtered)',
  builder: (yargs) =>
    yargs
      .positional('cmd', {
        describe: 'Command to run (everything after `run`)',
        type: 'string',
        array: true,
      })
      .option('target', {
        describe: 'Only run in worktrees for this project/group alias',
        type: 'string',
      })
      .option('branch', {
        describe: 'With --target, only run in this branch',
        type: 'string',
      })
      .option('parallel', {
        describe: 'Run all worktrees concurrently (default: sequential)',
        type: 'boolean',
        default: false,
      })
      .option('halt-on-error', {
        describe: 'Stop after the first failure (sequential only)',
        type: 'boolean',
        default: false,
      }),
  handler: async (argv) => {
    const cmdParts = (argv.cmd as string[] | undefined) ?? [];
    const cmd = cmdParts.join(' ').trim();
    if (!cmd) {
      console.error(chalk.red('No command given. Usage: work run <cmd...>'));
      process.exitCode = 1;
      return;
    }

    const target = argv.target as string | undefined;
    const branch = argv.branch as string | undefined;
    const parallel = argv.parallel as boolean;
    const haltOnError = argv['halt-on-error'] as boolean;

    if (branch && !target) {
      console.error(chalk.red('--branch requires --target.'));
      process.exitCode = 1;
      return;
    }

    const sessions = selectSessions(loadHistory(), { target, branch });
    const units = expandRunUnits(sessions);

    if (units.length === 0) {
      console.log(chalk.yellow('No matching worktrees.'));
      return;
    }

    console.log(
      chalk.cyan(
        `Running in ${units.length} worktree${units.length === 1 ? '' : 's'} (${parallel ? 'parallel' : 'sequential'}): `,
      ) + chalk.white(cmd),
    );
    console.log('');

    const results: RunResult[] = [];

    if (parallel) {
      const settled = await Promise.all(units.map((u) => runInPath(u, cmd)));
      results.push(...settled);
      for (const r of settled) console.log(label(r));
    } else {
      for (const unit of units) {
        const r = await runInPath(unit, cmd);
        results.push(r);
        console.log(label(r));
        if (!r.ok && haltOnError) {
          console.log(chalk.yellow('Halting on first failure (--halt-on-error).'));
          break;
        }
      }
    }

    console.log('');
    const failed = results.filter((r) => !r.ok).length;
    if (anyFailed(results)) {
      console.log(chalk.red(`${failed} of ${results.length} failed.`));
      process.exitCode = 1;
    } else {
      console.log(chalk.green(`All ${results.length} succeeded.`));
    }
  },
};
