import chalk from 'chalk';
import type { CommandModule } from 'yargs';
import { callWorkWeb } from '../core/platform/web-discovery.js';
import { findSessionById, loadHistory } from '../core/sessions/history.js';
import { sessionIdFor } from '../core/sessions/session-id.js';
import { findSessionForCwd } from '../core/comments/pending-delivery.js';
import { parentOf, reportMessage } from '../core/sessions/session-children.js';
import { sendHowText } from '../core/sessions/session-control.js';
import type { SendWire } from '../core/api-types.js';

/**
 * `work report` — a child session (`work child spawn`) tells the session that started it what it did: a message to
 * that one's agent, typed in when it is idle, marked as the child's words (session-children.ts). Only ever to its own
 * coordinator, so work's session settings allow it without asking.
 */
export const reportCommand: CommandModule = {
  command: 'report',
  describe: 'Tell the session that started this one what it did (a child session started with `work child spawn`)',
  builder: (yargs) =>
    yargs
      .option('message', { alias: 'm', type: 'string', describe: 'The report' })
      // No --file: `work report` runs without asking, and a file read for it would skip the repo's deny rules (no Read call).
      .check((a) => typeof a.message === 'string' || 'Give the report with -m "…"'),
  handler: async (argv) => {
    const fail = (m: string) => {
      console.error(chalk.red(m));
      process.exitCode = 1;
    };
    const me = findSessionForCwd(process.cwd(), loadHistory());
    if (!me) return fail('This folder is not inside a work session.');
    const link = parentOf(sessionIdFor(me));
    const parent = link ? findSessionById(link.parentId) : null;
    if (!link) return fail('This session was not started by another one (`work child spawn`): there is no one to report to.');
    if (!parent) return fail('The session that started this one is gone.');
    if (typeof argv.message !== 'string') return fail('Give the report with -m "…".');
    const text = argv.message;
    if (!text.trim()) return fail('The report is empty.');
    const label = me.title?.trim() || `${me.target} · ${me.branch}`;
    const r = await callWorkWeb<SendWire>('POST', `/api/sessions/${link.parentId}/send`, { text: reportMessage(label, text) });
    if (!r.ok) return fail(r.error);
    console.log(`Reported to ${parent.target} · ${parent.branch}: ${sendHowText(r.body.how)}`);
  },
};
