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

/** Live children so a SIGINT (Ctrl-C) can tear the whole fleet down instead
 *  of orphaning subprocesses. Keyed by the ChildProcess itself. */
const liveChildren = new Set<import('node:child_process').ChildProcess>();

function killAllChildren(signal: NodeJS.Signals = 'SIGTERM'): void {
  for (const child of liveChildren) {
    try {
      child.kill(signal);
    } catch {
      /* already gone */
    }
  }
}

/**
 * Run `cmd` in `unit.path`. When `prefix` is set (parallel mode) the child's
 * stdout/stderr are captured and re-emitted line-by-line with a per-worktree
 * tag, so concurrent output stays attributable. Sequential mode passes
 * `stdio: 'inherit'` for a transparent, unprefixed passthrough.
 */
function runInPath(
  unit: RunUnit,
  cmd: string,
  prefix?: string,
): Promise<RunResult> {
  const { bin, args } = shellInvocation(cmd);
  return new Promise((resolve) => {
    const child = spawn(bin, args, {
      cwd: unit.path,
      stdio: prefix ? ['ignore', 'pipe', 'pipe'] : 'inherit',
      shell: false,
    });
    liveChildren.add(child);

    if (prefix) {
      const tag = chalk.cyan(`${prefix} `);
      const pipe = (
        stream: NodeJS.ReadableStream | null,
        sink: NodeJS.WriteStream,
      ) => {
        if (!stream) return;
        let buf = '';
        stream.setEncoding('utf-8');
        stream.on('data', (chunk: string) => {
          buf += chunk;
          let nl: number;
          while ((nl = buf.indexOf('\n')) >= 0) {
            sink.write(tag + buf.slice(0, nl) + '\n');
            buf = buf.slice(nl + 1);
          }
        });
        stream.on('end', () => {
          if (buf.length > 0) sink.write(tag + buf + '\n');
        });
      };
      pipe(child.stdout, process.stdout);
      pipe(child.stderr, process.stderr);
    }

    child.on('close', (code) => {
      liveChildren.delete(child);
      resolve({ ...unit, code, ok: code === 0 });
    });
    child.on('error', () => {
      liveChildren.delete(child);
      resolve({ ...unit, code: null, ok: false });
    });
  });
}

/**
 * Run `units` concurrently with at most `limit` in flight at any time. Order
 * of the returned results matches `units`. A worker-pool rather than a single
 * `Promise.all` so a large fleet doesn't fork every subprocess at once.
 */
async function runPool(
  units: RunUnit[],
  cmd: string,
  limit: number,
): Promise<RunResult[]> {
  const results: RunResult[] = new Array(units.length);
  let next = 0;
  async function worker(): Promise<void> {
    while (true) {
      const idx = next++;
      if (idx >= units.length) return;
      const u = units[idx];
      const prefix = `[${u.session.target}/${u.session.branch}]`;
      results[idx] = await runInPath(u, cmd, prefix);
    }
  }
  const workers = Array.from(
    { length: Math.min(limit, units.length) },
    () => worker(),
  );
  await Promise.all(workers);
  return results;
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

/** Default cap on concurrent worktrees under `--parallel`. Bounded so a large
 *  fleet doesn't fork hundreds of subprocesses at once. */
const DEFAULT_JOBS = 4;

/** Our own fleet options. Everything else after the first bare token is the
 *  user's command and is captured verbatim. Booleans take no value; the rest
 *  consume the following token as their value. */
const BOOLEAN_FLAGS = new Set(['--parallel', '--halt-on-error']);
const VALUE_FLAGS = new Set(['--target', '--branch', '--jobs', '-j']);

/** Drop the leading `run` command token(s). Under our parser config yargs
 *  reports `argv._` as `['run', 'run', ...userArgs]` — the matched command
 *  name plus a halt-at-non-option artifact — so we always strip exactly the
 *  first two. A user-typed literal `run` (`work run run echo`) survives. */
export function stripRunToken(raw: string[]): string[] {
  let drop = 0;
  while (drop < 2 && raw[drop] === 'run') drop++;
  return raw.slice(drop);
}

export interface ExtractedRun {
  /** Our parsed fleet options (only the ones present). */
  options: {
    target?: string;
    branch?: string;
    parallel?: boolean;
    haltOnError?: boolean;
    jobs?: number;
  };
  /** The user's command argv, captured verbatim (flags included). */
  cmd: string[];
}

/**
 * Split `work run`'s raw arguments into our fleet options and the user's
 * command. yargs cannot do this safely: with the default parser it eats the
 * user command's own flags (`work run git log --oneline` drops `--oneline`;
 * `work run x --parallel` steals our fleet flag). So we parse the leading
 * fleet flags ourselves and treat the first bare token (or anything after a
 * literal `--`) as the start of the user command — capturing the rest,
 * including any flags, verbatim.
 *
 * `args` is everything after the `run` subcommand token.
 */
export function extractRun(args: string[]): ExtractedRun {
  const options: ExtractedRun['options'] = {};
  let i = 0;
  for (; i < args.length; i++) {
    const tok = args[i];
    if (tok === '--') {
      // Explicit separator: everything after is the command, verbatim.
      i++;
      break;
    }
    if (BOOLEAN_FLAGS.has(tok)) {
      if (tok === '--parallel') options.parallel = true;
      else if (tok === '--halt-on-error') options.haltOnError = true;
      continue;
    }
    if (VALUE_FLAGS.has(tok)) {
      const val = args[i + 1];
      if (val === undefined) break;
      if (tok === '--target') options.target = val;
      else if (tok === '--branch') options.branch = val;
      else if (tok === '--jobs' || tok === '-j') options.jobs = Number(val);
      i++;
      continue;
    }
    // First bare token (or unknown flag): start of the user command.
    break;
  }
  return { options, cmd: args.slice(i) };
}

export const runCommand: CommandModule = {
  // `run [cmd..]` keeps yargs happy about the trailing positional while we do
  // the real argument extraction ourselves from the raw process argv.
  command: 'run [cmd..]',
  describe: 'Run a shell command in every worktree (optionally filtered)',
  builder: (yargs) =>
    yargs
      // Keep the user command's own flags out of our parser: unknown flags
      // (`--oneline`, `--fix`) become args instead of errors, and halt-at-non
      // -option stops parsing at the first bare token so a colliding flag
      // (`--parallel`) after the command name is not stolen. We do the real
      // split in `extractRun` from the raw argv.
      .parserConfiguration({
        'halt-at-non-option': true,
        'unknown-options-as-args': true,
      })
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
      .option('jobs', {
        alias: 'j',
        describe: 'Max concurrent worktrees with --parallel (default: 4)',
        type: 'number',
      })
      .option('halt-on-error', {
        describe: 'Stop after the first failure (sequential only)',
        type: 'boolean',
        default: false,
      }),
  handler: async (argv) => {
    // yargs dumps the whole invocation into `_` verbatim under our parser
    // config (`['run', 'run', ...userArgs]` — the command token, doubled by
    // halt-at-non-option). Strip leading `run` tokens, then split off our
    // fleet flags ourselves so the user command (incl. its flags) survives.
    const rawAll = (argv._ as Array<string | number>).map(String);
    const { options, cmd: cmdParts } = extractRun(stripRunToken(rawAll));
    const cmd = cmdParts.join(' ').trim();
    if (!cmd) {
      console.error(chalk.red('No command given. Usage: work run <cmd...>'));
      process.exitCode = 1;
      return;
    }

    const target = options.target;
    const branch = options.branch;
    const parallel = options.parallel ?? false;
    const haltOnError = options.haltOnError ?? false;
    const jobs =
      options.jobs && Number.isFinite(options.jobs) && options.jobs > 0
        ? Math.floor(options.jobs)
        : DEFAULT_JOBS;

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
        `Running in ${units.length} worktree${units.length === 1 ? '' : 's'} (${parallel ? `parallel, up to ${jobs} at a time` : 'sequential'}): `,
      ) + chalk.white(cmd),
    );
    console.log('');

    const results: RunResult[] = [];

    // Tear the whole fleet down on Ctrl-C rather than orphaning children.
    let interrupted = false;
    const onSigint = () => {
      interrupted = true;
      console.error(chalk.yellow('\nInterrupted — terminating child processes…'));
      killAllChildren('SIGTERM');
    };
    process.on('SIGINT', onSigint);

    try {
      if (parallel) {
        const settled = await runPool(units, cmd, jobs);
        results.push(...settled);
        for (const r of settled) console.log(label(r));
      } else {
        for (const unit of units) {
          if (interrupted) break;
          const r = await runInPath(unit, cmd);
          results.push(r);
          console.log(label(r));
          if (!r.ok && haltOnError) {
            console.log(chalk.yellow('Halting on first failure (--halt-on-error).'));
            break;
          }
        }
      }
    } finally {
      process.off('SIGINT', onSigint);
    }

    if (interrupted) {
      console.log('');
      console.log(chalk.yellow('Aborted.'));
      process.exitCode = 130;
      return;
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
