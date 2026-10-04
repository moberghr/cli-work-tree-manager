import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { COMMANDS, commandsFor } from '../src/cli.js';

/** The words a command answers to: its `command` string(s)' first word, and its aliases. */
const wordsOf = (c: { command?: string | readonly string[]; aliases?: string | readonly string[] }) => {
  const cmds = typeof c.command === 'string' ? [c.command] : [...(c.command ?? [])];
  const aliases = typeof c.aliases === 'string' ? [c.aliases] : [...(c.aliases ?? [])];
  return [...cmds.map((x) => x.split(' ')[0]), ...aliases].sort();
};

describe('the lazily loaded commands', () => {
  it('each entry loads a command answering to exactly its words', async () => {
    for (const entry of COMMANDS) {
      const cmd = await entry.load();
      expect(wordsOf(cmd as never), entry.names.join('|')).toEqual([...entry.names].sort());
    }
  });

  it('every command module is in the table, and no word is used twice', () => {
    const modules = fs
      .readdirSync(path.join(import.meta.dirname, '..', 'src', 'commands'))
      .filter((f) => f.endsWith('.ts'))
      .map((f) => f.replace(/\.ts$/, ''));
    const words = COMMANDS.flatMap((c) => c.names);
    expect(new Set(words).size).toBe(words.length);
    for (const m of modules) {
      const src = fs.readFileSync(path.join(import.meta.dirname, '..', 'src', 'commands', `${m}.ts`), 'utf8');
      if (!/export const \w+Command\b/.test(src)) continue; // a helper module, not a command
      expect(words, m).toContain(m);
    }
  });

  it('a known verb loads only itself; help and anything else load them all', async () => {
    expect(await commandsFor(['todo', 'add', 'x'])).toHaveLength(1);
    expect(await commandsFor(['t', 'api', 'feat/x'])).toHaveLength(1);
    expect(await commandsFor(['--help'])).toHaveLength(COMMANDS.length);
    expect(await commandsFor(['nonsense'])).toHaveLength(COMMANDS.length);
  });
});
