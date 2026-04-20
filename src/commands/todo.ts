import chalk from 'chalk';
import type { CommandModule } from 'yargs';
import { getTasks, addTask, completeTask, uncompleteTask, removeTask, editTask } from '../core/tasks.js';

export const todoCommand: CommandModule = {
  command: 'todo [action]',
  describe: 'Manage tasks',
  builder: (yargs) =>
    yargs
      .positional('action', {
        describe: 'Action: add, done, undo, rm, edit (omit to list)',
        type: 'string',
      })
      .option('all', {
        describe: 'Show completed tasks too',
        type: 'boolean',
        default: false,
        alias: 'a',
      })
      .strict(false),
  handler: async (argv) => {
    const action = argv.action as string | undefined;
    const rest = (argv._ as string[]).slice(1);

    if (!action || action === 'list') {
      const showAll = argv.all as boolean;
      const tasks = getTasks();
      const filtered = showAll ? tasks : tasks.filter((t) => !t.done);
      if (filtered.length === 0) {
        console.log(chalk.gray(showAll ? 'No tasks.' : 'No open tasks. Use --all to show completed.'));
        return;
      }
      for (const t of filtered) {
        const check = t.done ? chalk.green('✓') : chalk.gray('○');
        const text = t.done ? chalk.strikethrough.gray(t.text) : t.text;
        const link = t.link ? chalk.blue(` [${t.link}]`) : '';
        console.log(`  ${check} ${chalk.gray(`#${t.id}`)} ${text}${link}`);
      }
      return;
    }

    if (action === 'add') {
      const text = rest.join(' ');
      if (!text) {
        console.error('Usage: work todo add <text>');
        process.exitCode = 1;
        return;
      }
      const task = await addTask(text);
      console.log(chalk.green(`Added #${task.id}: ${task.text}`));
      return;
    }

    if (action === 'done') {
      const id = parseInt(rest[0], 10);
      if (isNaN(id)) {
        console.error('Usage: work todo done <id>');
        process.exitCode = 1;
        return;
      }
      const task = await completeTask(id);
      if (!task) {
        console.error(`Task #${id} not found`);
        process.exitCode = 1;
      } else {
        console.log(chalk.green(`✓ #${id}: ${task.text}`));
      }
      return;
    }

    if (action === 'undo') {
      const id = parseInt(rest[0], 10);
      if (isNaN(id)) {
        console.error('Usage: work todo undo <id>');
        process.exitCode = 1;
        return;
      }
      const task = await uncompleteTask(id);
      if (!task) {
        console.error(`Task #${id} not found`);
        process.exitCode = 1;
      } else {
        console.log(chalk.yellow(`○ #${id}: ${task.text}`));
      }
      return;
    }

    if (action === 'rm') {
      const id = parseInt(rest[0], 10);
      if (isNaN(id)) {
        console.error('Usage: work todo rm <id>');
        process.exitCode = 1;
        return;
      }
      const task = await removeTask(id);
      if (!task) {
        console.error(`Task #${id} not found`);
        process.exitCode = 1;
      } else {
        console.log(chalk.red(`Removed #${id}: ${task.text}`));
      }
      return;
    }

    if (action === 'edit') {
      const id = parseInt(rest[0], 10);
      const text = rest.slice(1).join(' ');
      if (isNaN(id) || !text) {
        console.error('Usage: work todo edit <id> <new text>');
        process.exitCode = 1;
        return;
      }
      const task = await editTask(id, text);
      if (!task) {
        console.error(`Task #${id} not found`);
        process.exitCode = 1;
      } else {
        console.log(chalk.cyan(`Updated #${id}: ${task.text}`));
      }
      return;
    }

    console.error(`Unknown action: ${action}`);
    console.log(chalk.yellow('Actions: add, done, undo, rm, edit'));
    process.exitCode = 1;
  },
};
