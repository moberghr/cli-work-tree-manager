import path from 'node:path';
import chalk from 'chalk';
import type { CommandModule } from 'yargs';
import type { SessionShownWire } from '../core/api-types.js';
import { callWorkWeb } from '../core/platform/web-discovery.js';
import { findSessionForCwd } from '../core/comments/pending-delivery.js';
import { loadHistory } from '../core/sessions/history.js';
import { sessionIdFor } from '../core/sessions/session-id.js';

/**
 * `work show <file>` — show a file of this session beside its terminal in the dashboard (a spec you are asked to
 * approve, a plan, a screenshot, an artifact's HTML from the agent's scratch folder); `work show --diff` / `--review` /
 * `--code [file[:line]]` the session's own views there; `work show --close` closes the pane. Meant for an agent to run
 * when it wants you to read something: it reads the file's path only, and changes nothing.
 */
/** `src/a.ts:12` → the file and the line; a name with no line, or a Windows drive's colon, is the file alone. Pure. */
export function splitFileLine(arg: string): { file: string; line?: number } {
  const m = /^(.+?):(\d+)(?::\d+)?$/.exec(arg);
  if (!m || /^[A-Za-z]$/.test(m[1]!)) return { file: arg };
  return { file: m[1]!, line: Number(m[2]) };
}

/** What `work show` asks work web for, from its arguments; a string is what's wrong with them. Pure. */
export function showBody(
  argv: { file?: unknown; close?: unknown; diff?: unknown; review?: unknown; code?: unknown },
  cwd: string,
): Record<string, unknown> | string {
  const file = typeof argv.file === 'string' && argv.file ? argv.file : undefined;
  const views = (['diff', 'review', 'code'] as const).filter((v) => argv[v] === true);
  if (views.length + (argv.close === true ? 1 : 0) > 1) return 'Pick one of --diff, --review, --code and --close.';
  if (argv.close === true) return { close: true };
  if (views[0] === 'code') {
    if (!file) return { view: 'code' };
    const { file: f, line } = splitFileLine(file);
    return { view: 'code', file: path.resolve(cwd, f), ...(line ? { line } : {}) };
  }
  if (views[0]) return file ? `--${views[0]} takes no file.` : { view: views[0] };
  if (!file) return 'Usage: work show <file>   (or --diff, --review, --code [file[:line]], --close)';
  return { file: path.resolve(cwd, file) };
}

const VIEW_NAMES: Record<string, string> = { diff: 'the Diff', code: 'the Code view', review: 'the Review', file: 'the file' };

export const showCommand: CommandModule = {
  command: 'show [file]',
  describe: "Show a file, or the Diff / Review / Code, beside this session's terminal in the dashboard (--close: close it)",
  builder: (yargs) =>
    yargs
      .positional('file', {
        type: 'string',
        describe:
          "The file to show: in this session's folders, or its agent's scratch folder (Markdown rendered, HTML drawn sandboxed, an image drawn, the rest as text). With --code: where to open, file[:line]",
      })
      .option('diff', { type: 'boolean', describe: "Show the session's Diff beside the terminal" })
      .option('review', { type: 'boolean', describe: "Show the session's Review beside the terminal" })
      .option('code', { type: 'boolean', describe: 'Show the Code view beside the terminal (at file[:line] when one is given)' })
      .option('close', { type: 'boolean', describe: 'Close the pane beside the terminal' }),
  handler: async (argv) => {
    const fail = (message: string) => {
      console.error(chalk.red(message));
      process.exitCode = 1;
    };
    const body = showBody(argv as Parameters<typeof showBody>[0], process.cwd());
    if (typeof body === 'string') return fail(body);
    const s = findSessionForCwd(process.cwd(), loadHistory());
    if (!s) return fail('This folder is not inside a work session.');
    const url = `/api/sessions/${sessionIdFor(s)}/show`;
    const r = await callWorkWeb<SessionShownWire>('POST', url, body, 15_000);
    if (!r.ok) return fail(r.status === 0 ? 'work web is not running: open the app, then run this again.' : r.error);
    const where = `beside the terminal of ${s.target} · ${s.branch}`;
    const pane = r.body.pane;
    if (pane && pane.tab !== 'file') {
      const at = pane.place ? ` at ${pane.place.path}${pane.place.line ? `:${pane.place.line}` : ''}` : '';
      console.log(chalk.green(`Showing ${VIEW_NAMES[pane.tab]}${at} ${where}.`));
    } else
      console.log(
        r.body.shown
          ? chalk.green(`Showing ${r.body.shown.path} ${where}.`)
          : chalk.gray(`${s.target} · ${s.branch} shows nothing beside its terminal now.`),
      );
  },
};
