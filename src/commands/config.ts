import fs from 'node:fs';
import path from 'node:path';
import chalk from 'chalk';
import type { ArgumentsCamelCase, CommandModule } from 'yargs';
import {
  loadConfig,
  saveConfig,
  getConfigPath,
  getConfigDir,
  ensureConfig,
} from '../core/config.js';
import { isGitRepo } from '../core/git.js';
import { generateGroupClaudeMd } from '../core/claude-md.js';
import { openInEditor } from '../utils/platform.js';

export const configCommand: CommandModule = {
  command: 'config <action>',
  describe: 'Manage configuration',
  builder: (yargs) =>
    yargs
      .showHelpOnFail(true)
      .positional('action', {
        describe: 'Config action to perform',
        choices: [
          'add',
          'remove',
          'list',
          'group',
          'show',
          'edit',
        ] as const,
        type: 'string',
        demandOption: true,
      })
      .option('args', {
        type: 'array',
        string: true,
        hidden: true,
      })
      .strict(false),
  handler: (argv) => {
    const action = argv.action as string;
    // Collect all extra positional args after the action
    const extra = (argv._ as string[]).slice(1); // slice off 'config'

    switch (action) {
      case 'add':
        handleAdd(extra);
        break;
      case 'remove':
        handleRemove(extra);
        break;
      case 'list':
        handleList();
        break;
      case 'group':
        handleGroup(extra);
        break;
      case 'show':
        handleShow();
        break;
      case 'edit':
        handleEdit();
        break;
      default:
        showConfigHelp();
    }
  },
};

function handleAdd(args: string[]): void {
  const [alias, repoPath] = args;
  if (!alias || !repoPath) {
    console.error('Usage: work2 config add <alias> <path>');
    process.exitCode = 1;
    return;
  }

  if (!fs.existsSync(repoPath)) {
    console.error(`Path does not exist: ${repoPath}`);
    process.exitCode = 1;
    return;
  }

  if (!isGitRepo(repoPath)) {
    console.error(`Path is not a git repository: ${repoPath}`);
    process.exitCode = 1;
    return;
  }

  const config = ensureConfig();
  config.repos[alias] = repoPath;
  saveConfig(config);
  console.log(chalk.green(`Added: ${alias} -> ${repoPath}`));
}

function handleRemove(args: string[]): void {
  const [alias] = args;
  if (!alias) {
    console.error('Usage: work2 config remove <alias>');
    process.exitCode = 1;
    return;
  }

  const config = ensureConfig();

  if (!(alias in config.repos)) {
    console.error(`Repository alias not found: ${alias}`);
    process.exitCode = 1;
    return;
  }

  delete config.repos[alias];
  saveConfig(config);
  console.log(chalk.green(`Removed: ${alias}`));
}

function handleList(): void {
  const config = loadConfig();
  if (!config) {
    console.log(
      chalk.yellow(
        'No configuration found. Run "work2 init" to set up.',
      ),
    );
    return;
  }

  console.log('');
  console.log(chalk.cyan('Work Configuration'));
  console.log(chalk.cyan('=================='));
  console.log(chalk.green(`Worktrees Root: ${config.worktreesRoot}`));
  console.log('');
  console.log(chalk.green('Repositories:'));

  const repoKeys = Object.keys(config.repos);
  if (repoKeys.length === 0) {
    console.log(chalk.gray('  (none configured)'));
  } else {
    for (const key of repoKeys) {
      console.log(`  ${key} -> ${config.repos[key]}`);
    }
  }
  console.log('');

  console.log(chalk.green('Groups:'));
  const groupKeys = Object.keys(config.groups);
  if (groupKeys.length === 0) {
    console.log(chalk.gray('  (none configured)'));
  } else {
    for (const key of groupKeys) {
      const aliases = config.groups[key].join(', ');
      console.log(`  ${key} -> [${aliases}]`);
    }
  }
  console.log('');
}

function handleGroup(args: string[]): void {
  const [subAction, ...rest] = args;
  switch (subAction) {
    case 'add':
      handleAddGroup(rest);
      break;
    case 'remove':
      handleRemoveGroup(rest);
      break;
    case 'regen':
      handleRegenGroup(rest);
      break;
    default:
      showGroupHelp();
  }
}

function handleAddGroup(args: string[]): void {
  const [groupName, ...repoAliases] = args;
  if (!groupName) {
    console.error(
      'Usage: work2 config group add <name> <alias1> <alias2> [alias3...]',
    );
    process.exitCode = 1;
    return;
  }

  if (repoAliases.length < 2) {
    console.error('A group must contain at least 2 repository aliases.');
    console.log(
      chalk.yellow(
        'Usage: work2 config group add <name> <alias1> <alias2> [alias3...]',
      ),
    );
    process.exitCode = 1;
    return;
  }

  const config = ensureConfig();

  // Validate: all aliases exist in repos
  for (const alias of repoAliases) {
    if (!(alias in config.repos)) {
      console.error(`Repository alias not found: ${alias}`);
      console.log(
        chalk.yellow(
          `Available aliases: ${Object.keys(config.repos).join(', ')}`,
        ),
      );
      process.exitCode = 1;
      return;
    }
  }

  // Validate: group name doesn't collide with repo aliases
  if (groupName in config.repos) {
    console.error(
      `Group name '${groupName}' conflicts with an existing repository alias.`,
    );
    process.exitCode = 1;
    return;
  }

  // Validate: group name doesn't collide with repo folder names
  const repoFolderNames = Object.values(config.repos).map((p) =>
    path.basename(p),
  );
  if (repoFolderNames.includes(groupName)) {
    console.error(
      `Group name '${groupName}' conflicts with a repository folder name.`,
    );
    process.exitCode = 1;
    return;
  }

  config.groups[groupName] = repoAliases;
  saveConfig(config);
  console.log(
    chalk.green(
      `Added group: ${groupName} -> [${repoAliases.join(', ')}]`,
    ),
  );

  // Generate combined CLAUDE.md
  generateGroupClaudeMd(groupName, repoAliases, config);
}

function handleRemoveGroup(args: string[]): void {
  const [groupName] = args;
  if (!groupName) {
    console.error('Usage: work2 config group remove <name>');
    process.exitCode = 1;
    return;
  }

  const config = ensureConfig();

  if (!(groupName in config.groups)) {
    console.error(`Group not found: ${groupName}`);
    process.exitCode = 1;
    return;
  }

  delete config.groups[groupName];
  saveConfig(config);

  // Delete the .claude.md file
  const claudeMdPath = path.join(getConfigDir(), `${groupName}.claude.md`);
  if (fs.existsSync(claudeMdPath)) {
    fs.unlinkSync(claudeMdPath);
    console.log(`Deleted: ${claudeMdPath}`);
  }

  console.log(chalk.green(`Removed group: ${groupName}`));
}

function handleRegenGroup(args: string[]): void {
  const [groupName] = args;
  if (!groupName) {
    console.error('Usage: work2 config group regen <name>');
    process.exitCode = 1;
    return;
  }

  const config = ensureConfig();

  if (!(groupName in config.groups)) {
    console.error(`Group not found: ${groupName}`);
    process.exitCode = 1;
    return;
  }

  const repoAliases = config.groups[groupName];
  generateGroupClaudeMd(groupName, repoAliases, config);
}

function handleShow(): void {
  const configPath = getConfigPath();
  if (fs.existsSync(configPath)) {
    console.log(chalk.green(`Config file: ${configPath}`));
    console.log('');
    const content = fs.readFileSync(configPath, 'utf-8');
    console.log(content);
  } else {
    console.log(
      chalk.yellow(
        'No configuration file found. Run "work2 init" to set up.',
      ),
    );
  }
}

function handleEdit(): void {
  const configPath = getConfigPath();
  if (!fs.existsSync(configPath)) {
    console.error(
      'No configuration file found. Run "work2 init" first.',
    );
    process.exitCode = 1;
    return;
  }
  openInEditor(configPath);
}

function showConfigHelp(): void {
  console.log(chalk.yellow('Usage: work2 config <action>'));
  console.log('');
  console.log(chalk.green('Actions:'));
  console.log(
    '  add <alias> <path>                    - Add a repository',
  );
  console.log(
    '  remove <alias>                        - Remove a repository',
  );
  console.log(
    '  list                                  - List all configured repositories and groups',
  );
  console.log(
    '  group <sub>                           - Manage groups (add, remove, regen)',
  );
  console.log(
    '  show                                  - Show configuration file contents',
  );
  console.log(
    '  edit                                  - Open configuration file in editor',
  );
}

function showGroupHelp(): void {
  console.log(chalk.yellow('Usage: work2 config group <action>'));
  console.log('');
  console.log(chalk.green('Actions:'));
  console.log(
    '  add <name> <alias1> <alias2> [...]    - Create a repository group',
  );
  console.log(
    '  remove <name>                         - Remove a repository group',
  );
  console.log(
    '  regen <name>                          - Regenerate group CLAUDE.md',
  );
}
