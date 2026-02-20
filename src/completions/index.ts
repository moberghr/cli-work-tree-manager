import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../core/config.js';
import { parseWorktreeList, getCurrentBranch } from '../core/git.js';
import { resolveProjectTarget } from '../core/resolve.js';

type Done = (completions: string[]) => void;

/**
 * Dynamic completion handler for yargs.
 * Called when the user presses TAB (via --get-yargs-completions).
 *
 * argv._ = ['<scriptName>', '<command>', '<arg1>', ...., '<current>']
 * We skip the script name and the trailing current word to get the "completed" args.
 */
export function completionHandler(
  current: string,
  argv: Record<string, unknown>,
  done: Done,
): void {
  const rawArgs = argv._ as string[];

  // Skip the script name (first element) and the trailing current word (last element)
  const args = rawArgs.slice(1, -1);
  const command = args[0] as string | undefined;

  const config = loadConfig();
  if (!config) {
    done([]);
    return;
  }

  if (!command) {
    done(
      ['tree', 't', 'remove', 'list', 'status', 'recent', 'resume', 'prune', 'init', 'config', 'completion'].filter(
        (c) => c.startsWith(current),
      ),
    );
    return;
  }

  switch (command) {
    case 'config':
      completeConfig(args, current, config, done);
      return;

    case 'tree':
    case 't':
    case 'remove':
    case 'list':
    case 'status':
      completeTreeRemoveList(command, args, current, config, done);
      return;

    default:
      done([]);
  }
}

function completeConfig(
  args: string[],
  current: string,
  config: NonNullable<ReturnType<typeof loadConfig>>,
  done: Done,
): void {
  const subAction = args[1] as string | undefined;

  if (!subAction) {
    const actions = [
      'add',
      'remove',
      'list',
      'group',
      'show',
      'edit',
    ];
    done(actions.filter((a) => a.startsWith(current)));
    return;
  }

  if (subAction === 'remove' && args.length === 2) {
    const aliases = Object.keys(config.repos);
    done(aliases.filter((a) => a.startsWith(current)));
    return;
  }

  if (subAction === 'group') {
    const groupSub = args[2] as string | undefined;

    if (!groupSub) {
      const subs = ['add', 'remove', 'regen'];
      done(subs.filter((s) => s.startsWith(current)));
      return;
    }

    if (
      (groupSub === 'remove' || groupSub === 'regen') &&
      args.length === 3
    ) {
      const groups = Object.keys(config.groups);
      done(groups.filter((g) => g.startsWith(current)));
      return;
    }

    if (groupSub === 'add' && args.length >= 4) {
      const alreadyUsed = args.slice(3);
      const aliases = Object.keys(config.repos).filter(
        (a) => !alreadyUsed.includes(a),
      );
      done(aliases.filter((a) => a.startsWith(current)));
      return;
    }

    done([]);
    return;
  }

  done([]);
}

function completeTreeRemoveList(
  command: string,
  args: string[],
  current: string,
  config: NonNullable<ReturnType<typeof loadConfig>>,
  done: Done,
): void {
  const targetName = args[1] as string | undefined;

  if (!targetName) {
    const names = [
      ...Object.keys(config.repos),
      ...Object.keys(config.groups),
    ];
    done(names.filter((n) => n.startsWith(current)));
    return;
  }

  if (args.length === 2) {
    const target = resolveProjectTarget(targetName, config);
    if (!target) {
      done([]);
      return;
    }

    if (target.isGroup) {
      completeGroupBranches(target.name, target.repoAliases, current, config, done);
    } else {
      completeRepoBranches(targetName, current, config, done);
    }
    return;
  }

  done([]);
}

function completeRepoBranches(
  alias: string,
  current: string,
  config: NonNullable<ReturnType<typeof loadConfig>>,
  done: Done,
): void {
  const repoPath = config.repos[alias];
  if (!repoPath || !fs.existsSync(repoPath)) {
    done([]);
    return;
  }

  const worktrees = parseWorktreeList(repoPath);
  const branches = worktrees
    .map((wt) => wt.branch)
    .filter((b): b is string => !!b && b.startsWith(current));
  done(branches);
}

function completeGroupBranches(
  groupName: string,
  repoAliases: string[],
  current: string,
  config: NonNullable<ReturnType<typeof loadConfig>>,
  done: Done,
): void {
  const groupDir = path.join(config.worktreesRoot, groupName);
  if (!fs.existsSync(groupDir)) {
    done([]);
    return;
  }

  try {
    const branchDirs = fs
      .readdirSync(groupDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => {
        const bdPath = path.join(groupDir, d.name);
        for (const alias of repoAliases) {
          const repoPath = config.repos[alias];
          if (!repoPath) continue;
          const subPath = path.join(bdPath, path.basename(repoPath));
          if (fs.existsSync(subPath)) {
            const branch = getCurrentBranch(subPath);
            if (branch) return branch;
          }
        }
        return d.name;
      });

    done(branchDirs.filter((b) => b.startsWith(current)));
  } catch {
    done([]);
  }
}
