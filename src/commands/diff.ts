import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import chalk from 'chalk';
import spawn from 'cross-spawn';
import { confirm } from '@inquirer/prompts';
import type { CommandModule } from 'yargs';
import { git } from '../core/git.js';
import { loadHistory, type WorktreeSession } from '../core/history.js';
import { augmentDiffHtml } from '../core/diff-render.js';
import { openUrl } from '../utils/platform.js';

function isDiff2HtmlInstalled(): boolean {
  const result = spawn.sync('diff2html', ['--version'], { stdio: 'ignore' });
  return result.status === 0;
}

async function installDiff2Html(): Promise<boolean> {
  console.log(chalk.yellow('diff2html-cli is not installed.'));
  console.log(chalk.gray('This is a one-time install. We will run:'));
  console.log(chalk.gray('  npm install -g diff2html-cli'));
  console.log('');

  const ok = await confirm({
    message: 'Install diff2html-cli globally now?',
    default: true,
  });
  if (!ok) return false;

  const result = spawn.sync('npm', ['install', '-g', 'diff2html-cli'], {
    stdio: 'inherit',
  });
  if (result.status !== 0) {
    console.error(chalk.red('Failed to install diff2html-cli.'));
    return false;
  }
  console.log(chalk.green('diff2html-cli installed.'));
  return true;
}

/** Normalize a path for case-insensitive (Windows) comparison. */
function normPath(p: string): string {
  return path.resolve(p).replace(/\\/g, '/').toLowerCase();
}

/** Find a session whose worktree path matches the given directory. */
function findSessionForCwd(cwd: string): WorktreeSession | undefined {
  const target = normPath(cwd);
  const sessions = loadHistory();
  return sessions.find((s) => s.paths.some((p) => normPath(p) === target));
}

/**
 * Pick the most likely "parent" branch by finding the branch with the most
 * recent merge-base with HEAD (excluding HEAD's own branch). This handles
 * cases where multiple candidate branches exist (e.g. local main + dev).
 */
function detectParentBranch(cwd: string): string | null {
  const currentResult = git(['rev-parse', '--abbrev-ref', 'HEAD'], cwd);
  const currentBranch = currentResult.exitCode === 0 ? currentResult.stdout : '';

  const candidates = ['main', 'master', 'dev', 'develop'].flatMap((name) => [
    name,
    `origin/${name}`,
  ]);

  let best: { ref: string; sha: string; time: number } | null = null;

  for (const ref of candidates) {
    if (ref === currentBranch) continue;
    const exists = git(['rev-parse', '--verify', '--quiet', ref], cwd);
    if (exists.exitCode !== 0 || !exists.stdout) continue;

    const mb = git(['merge-base', ref, 'HEAD'], cwd);
    if (mb.exitCode !== 0 || !mb.stdout) continue;

    const headSha = git(['rev-parse', 'HEAD'], cwd).stdout;
    if (mb.stdout === headSha) continue;

    const timeResult = git(['show', '-s', '--format=%ct', mb.stdout], cwd);
    if (timeResult.exitCode !== 0) continue;
    const time = Number(timeResult.stdout);
    if (!Number.isFinite(time)) continue;

    if (!best || time > best.time) {
      best = { ref, sha: mb.stdout, time };
    }
  }

  return best?.ref ?? null;
}

export const diffCommand: CommandModule = {
  command: 'diff [base]',
  describe:
    'Open a GitHub-PR-style diff overview in your browser (via diff2html)',
  builder: (yargs) =>
    yargs
      .positional('base', {
        describe:
          'Base ref to compare against. Default: HEAD (uncommitted only). Use --branch for a full PR-style diff vs the parent branch.',
        type: 'string',
      })
      .option('branch', {
        type: 'boolean',
        default: false,
        describe:
          'PR-style diff vs the branch this worktree was forked from (stored when known, otherwise auto-detected).',
      })
      .option('side', {
        type: 'boolean',
        default: true,
        describe: 'Side-by-side layout (default). Use --no-side for unified.',
      })
      .option('theme', {
        type: 'string',
        choices: ['light', 'dark', 'auto'] as const,
        default: 'light',
        describe: 'Color scheme.',
      }),
  handler: async (argv) => {
    const cwd = process.cwd();
    const toplevel = git(['rev-parse', '--show-toplevel'], cwd);

    if (toplevel.exitCode !== 0 || !toplevel.stdout) {
      console.error(chalk.red('Not inside a git repository.'));
      process.exit(1);
    }
    const root = toplevel.stdout;

    const explicitBase = argv.base as string | undefined;
    const branchMode = argv.branch as boolean;

    let base: string | null = explicitBase ?? null;
    let baseSource = explicitBase ? 'arg' : '';

    if (!base && branchMode) {
      const session = findSessionForCwd(root);
      if (session?.baseBranch) {
        base = session.baseBranch;
        baseSource = 'session';
      } else {
        base = detectParentBranch(root);
        if (base) baseSource = 'auto-detected';
      }
      if (!base) {
        console.error(
          chalk.red('Could not determine a parent branch for this worktree.'),
        );
        console.error(chalk.gray('Pass one explicitly: diff <ref>'));
        process.exit(1);
      }
    }

    if (!base) {
      base = 'HEAD';
      baseSource = 'default';
    }

    let diffArg = base;
    if (base !== 'HEAD') {
      const mb = git(['merge-base', base, 'HEAD'], root);
      if (mb.exitCode === 0 && mb.stdout) {
        diffArg = mb.stdout;
        console.log(
          chalk.gray(
            `Showing diff vs ${base} [${baseSource}] (merge-base ${mb.stdout.slice(0, 8)}), including uncommitted changes.`,
          ),
        );
      } else {
        console.log(chalk.gray(`Showing diff vs ${base} [${baseSource}].`));
      }
    } else {
      console.log(chalk.gray('Showing uncommitted changes vs HEAD.'));
    }

    if (!isDiff2HtmlInstalled()) {
      const ok = await installDiff2Html();
      if (!ok) {
        console.log(chalk.gray('Skipping. Run again once installed.'));
        return;
      }
    }

    // Untracked files are invisible to `git diff`. Mark them intent-to-add
    // so they show up as new files in the diff, then revert that index
    // change after we capture the diff so we don't disturb the user's state.
    const untrackedResult = git(
      ['ls-files', '--others', '--exclude-standard'],
      root,
    );
    const untrackedFiles =
      untrackedResult.exitCode === 0 && untrackedResult.stdout
        ? untrackedResult.stdout.split('\n').filter(Boolean)
        : [];
    if (untrackedFiles.length > 0) {
      git(['add', '--intent-to-add', '--', ...untrackedFiles], root);
    }

    const args = [
      '-o',
      'stdout',
      '--style',
      argv.side ? 'side' : 'line',
      '--colorScheme',
      argv.theme as string,
      '--',
      diffArg,
    ];
    let result: ReturnType<typeof spawn.sync>;
    try {
      result = spawn.sync('diff2html', args, {
        cwd: root,
        encoding: 'utf-8',
        maxBuffer: 200 * 1024 * 1024,
      });
    } finally {
      if (untrackedFiles.length > 0) {
        git(['reset', '--quiet', '--', ...untrackedFiles], root);
      }
    }
    if (result.status !== 0) {
      if (result.stderr) console.error(result.stderr);
      process.exit(result.status ?? 1);
    }

    const augmented = augmentDiffHtml(
      result.stdout,
      argv.theme as 'light' | 'dark' | 'auto',
    );
    const outPath = path.join(
      os.tmpdir(),
      `wd-diff-${process.pid}-${Date.now()}.html`,
    );
    fs.writeFileSync(outPath, augmented, 'utf-8');
    console.log(chalk.gray(`Opening ${outPath}`));
    openUrl(`file:///${outPath.replace(/\\/g, '/')}`);
  },
};
