import fs from 'node:fs';
import path from 'node:path';
import chalk from 'chalk';
import type { CommandModule } from 'yargs';
import { loadConfig, saveConfig, getConfigPath, getConfigDir, ensureConfig } from '../core/platform/config.js';
import { generateGroupInstructions } from '../core/agents/group-instructions.js';
import { openInEditor } from '../core/platform/launch.js';
import { enrollRepo, RepoAdminError, repoInventory } from '../core/worktree/repo-admin.js';
import { scanForRepos } from '../core/worktree/repo-scan.js';
import { loadHistory } from '../core/sessions/history.js';

export const configCommand: CommandModule = {
  command: 'config <action>',
  describe: 'Manage configuration',
  builder: (yargs) =>
    yargs
      .showHelpOnFail(true)
      .positional('action', {
        describe: 'Config action to perform',
        choices: ['add', 'remove', 'list', 'group', 'scan', 'show', 'edit'] as const,
        type: 'string',
        demandOption: true,
      })
      .option('json', { type: 'boolean', describe: 'scan: the inventory as JSON (the Repos page’s /api/repos)' })
      .option('args', {
        type: 'array',
        string: true,
        hidden: true,
      })
      .strict(false),
  handler: async (argv) => {
    const action = argv.action as string;
    // Collect all extra positional args after the action
    const extra = (argv._ as string[]).slice(1); // slice off 'config'

    switch (action) {
      case 'add':
        await handleAdd(extra);
        break;
      case 'scan':
        handleScan(extra, argv.json === true);
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

async function handleAdd(args: string[]): Promise<void> {
  const [alias, repoPath] = args;
  if (!alias || !repoPath) {
    console.error('Usage: work config add <alias> <path>');
    process.exitCode = 1;
    return;
  }

  if (!fs.existsSync(repoPath)) {
    console.error(`Path does not exist: ${repoPath}`);
    process.exitCode = 1;
    return;
  }

  // The Repos page's rules: a free alias, the repo's own top folder, a folder name no other repo has.
  try {
    await enrollRepo(alias, repoPath);
  } catch (err) {
    if (!(err instanceof RepoAdminError)) throw err;
    console.error(err.message);
    process.exitCode = 1;
    return;
  }
  console.log(chalk.green(`Added: ${alias} -> ${path.resolve(repoPath)}`));
}

/**
 * `work config scan [folder] [--json]`: the git repos in your scanned
 * folders (or in `folder`), enrolled or not — what the Repos page lists.
 */
function handleScan(args: string[], json: boolean): void {
  const config = ensureConfig();
  const [folder] = args;
  const inv = folder
    ? repoInventory(config, loadHistory(), scanForRepos(folder, { skip: [config.worktreesRoot] }))
    : repoInventory(config, loadHistory());
  if (json) {
    console.log(JSON.stringify(inv, null, 2));
    return;
  }
  console.log(chalk.dim(`Scanned: ${inv.roots.length ? (folder ?? inv.roots.join(', ')) : '(no folder: set worktreesRoot, or pass one)'}`));
  const fresh = inv.repos.filter((r) => r.status === 'new');
  console.log(chalk.bold(`\nNot enrolled (${fresh.length})`));
  for (const r of fresh) {
    const how = r.problem ? chalk.yellow(r.problem) : chalk.dim(`work config add ${r.suggestedAlias} "${r.path}"`);
    console.log(`  ${r.folder.padEnd(28)} ${(r.origin ?? '').padEnd(32)} ${how}`);
  }
  const odd = inv.repos.filter((r) => r.status === 'missing' || r.sharedWith?.length);
  if (odd.length) {
    console.log(chalk.bold(`\nTo look at (${odd.length})`));
    for (const r of odd)
      console.log(
        `  ${r.alias!.padEnd(28)} ${r.status === 'missing' ? chalk.red('folder gone: ' + r.path) : chalk.yellow(`same folder as ${r.sharedWith!.join(', ')}`)}`,
      );
  }
  const ignored = inv.repos.filter((r) => r.status === 'ignored').length;
  const enrolled = inv.repos.filter((r) => r.status === 'enrolled').length;
  console.log(chalk.dim(`\n${enrolled} enrolled · ${ignored} ignored · the dashboard's Repos page adds, removes and ignores them.`));
}

function handleRemove(args: string[]): void {
  const [alias] = args;
  if (!alias) {
    console.error('Usage: work config remove <alias>');
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
    console.log(chalk.yellow('No configuration found. Run "work init" to set up.'));
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
    console.error('Usage: work config group add <name> <alias1> <alias2> [alias3...]');
    process.exitCode = 1;
    return;
  }

  if (repoAliases.length < 2) {
    console.error('A group must contain at least 2 repository aliases.');
    console.log(chalk.yellow('Usage: work config group add <name> <alias1> <alias2> [alias3...]'));
    process.exitCode = 1;
    return;
  }

  const config = ensureConfig();

  // Validate: all aliases exist in repos
  for (const alias of repoAliases) {
    if (!(alias in config.repos)) {
      console.error(`Repository alias not found: ${alias}`);
      console.log(chalk.yellow(`Available aliases: ${Object.keys(config.repos).join(', ')}`));
      process.exitCode = 1;
      return;
    }
  }

  // Validate: group name doesn't collide with repo aliases
  if (groupName in config.repos) {
    console.error(`Group name '${groupName}' conflicts with an existing repository alias.`);
    process.exitCode = 1;
    return;
  }

  // Validate: group name doesn't collide with repo folder names
  const repoFolderNames = Object.values(config.repos).map((p) => path.basename(p));
  if (repoFolderNames.includes(groupName)) {
    console.error(`Group name '${groupName}' conflicts with a repository folder name.`);
    process.exitCode = 1;
    return;
  }

  config.groups[groupName] = repoAliases;
  saveConfig(config);
  console.log(chalk.green(`Added group: ${groupName} -> [${repoAliases.join(', ')}]`));

  // Generate combined CLAUDE.md
  generateGroupInstructions(groupName, repoAliases, config);
}

function handleRemoveGroup(args: string[]): void {
  const [groupName] = args;
  if (!groupName) {
    console.error('Usage: work config group remove <name>');
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
    console.error('Usage: work config group regen <name>');
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
  generateGroupInstructions(groupName, repoAliases, config);
}

function handleShow(): void {
  const configPath = getConfigPath();
  if (fs.existsSync(configPath)) {
    console.log(chalk.green(`Config file: ${configPath}`));
    console.log('');
    const content = fs.readFileSync(configPath, 'utf-8');
    console.log(content);
  } else {
    console.log(chalk.yellow('No configuration file found. Run "work init" to set up.'));
  }
}

function handleEdit(): void {
  const configPath = getConfigPath();
  if (!fs.existsSync(configPath)) {
    console.error('No configuration file found. Run "work init" first.');
    process.exitCode = 1;
    return;
  }
  openInEditor(configPath);
}

function showConfigHelp(): void {
  console.log(chalk.yellow('Usage: work config <action>'));
  console.log('');
  console.log(chalk.green('Actions:'));
  console.log('  add <alias> <path>                    - Add a repository');
  console.log('  remove <alias>                        - Remove a repository');
  console.log('  list                                  - List all configured repositories and groups');
  console.log('  group <sub>                           - Manage groups (add, remove, regen)');
  console.log('  show                                  - Show configuration file contents');
  console.log('  edit                                  - Open configuration file in editor');
}

function showGroupHelp(): void {
  console.log(chalk.yellow('Usage: work config group <action>'));
  console.log('');
  console.log(chalk.green('Actions:'));
  console.log('  add <name> <alias1> <alias2> [...]    - Create a repository group');
  console.log('  remove <name>                         - Remove a repository group');
  console.log('  regen <name>                          - Regenerate group CLAUDE.md');
}
