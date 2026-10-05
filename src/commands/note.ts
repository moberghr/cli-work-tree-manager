import fs from 'node:fs';
import chalk from 'chalk';
import type { CommandModule } from 'yargs';
import { appendNote, readNote, saveNote, MAX_NOTE_CHARS } from '../core/rail/session-notes.js';
import { sessionIdFor } from '../core/sessions/session-id.js';
import { sessionFromArgs, sessionPositionals } from './shared/session-arg.js';

/** `work note` — your notes on a session (session-notes.ts), the dashboard's 📝 Notes: print, set, add a line, clear. */
export const noteCommand: CommandModule = {
  command: 'note [target] [branch]',
  describe: 'Your notes on a session: print them, --set, --append a line, or --clear (default: the session for this folder)',
  builder: (yargs) =>
    sessionPositionals(yargs)
      .option('set', { type: 'string', describe: 'Replace the notes with this text' })
      .option('set-file', { type: 'string', describe: 'Replace the notes with this file' })
      .option('append', { alias: 'a', type: 'string', describe: 'Add a line at the end' })
      .option('clear', { type: 'boolean', describe: 'Remove them' })
      .conflicts('set', ['append', 'clear', 'set-file'])
      .conflicts('append', ['clear', 'set-file'])
      .conflicts('clear', 'set-file'),
  handler: (argv) => {
    const s = sessionFromArgs(argv);
    if (!s) return;
    const id = sessionIdFor(s);
    const name = `${s.target} · ${s.branch}`;
    let text: string | undefined = typeof argv.set === 'string' ? argv.set : undefined;
    if (typeof argv['set-file'] === 'string') {
      try {
        text = fs.readFileSync(argv['set-file'], 'utf8');
      } catch (err) {
        console.error(chalk.red(`Can't read ${argv['set-file']}: ${(err as Error).message}`));
        process.exitCode = 1;
        return;
      }
    }
    if (text !== undefined && text.length > MAX_NOTE_CHARS) {
      console.error(chalk.red(`At most ${MAX_NOTE_CHARS} characters.`));
      process.exitCode = 1;
      return;
    }
    if (argv.clear) {
      saveNote(id, '');
      console.log(chalk.green(`Cleared the notes on ${name}.`));
    } else if (text !== undefined) {
      saveNote(id, text);
      console.log(chalk.green(`Saved the notes on ${name}.`));
    } else if (typeof argv.append === 'string') {
      if ((readNote(id)?.text.length ?? 0) + argv.append.length + 1 > MAX_NOTE_CHARS) {
        console.error(chalk.red(`At most ${MAX_NOTE_CHARS} characters in all: that would make it longer.`));
        process.exitCode = 1;
        return;
      }
      appendNote(id, argv.append);
      console.log(chalk.green(`Added to the notes on ${name}.`));
    } else {
      const note = readNote(id);
      if (note) console.log(note.text);
      else console.error(chalk.gray(`No notes on ${name} (work note --append "…" adds one).`));
    }
  },
};
