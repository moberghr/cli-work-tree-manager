import chalk from 'chalk';
import type { CommandModule } from 'yargs';
import { buildUsage, realUsageDeps } from '../core/usage/usage-source.js';
import { formatTokens, resetPhrase } from '../core/usage/usage.js';
import type { TokenTotals, UsageWire } from '../core/api-types.js';
import { knownAgents } from '../core/agents/index.js';
import { restoreAgentUsage } from '../core/usage/usage-setup.js';

/**
 * `work usage` — each agent's plan limits (as its status line last reported
 * them) and the tokens work saw in the sessions' transcripts (core/usage/).
 */

const totals = (t: TokenTotals) => `${formatTokens(t.input)} in · ${formatTokens(t.cached)} cached · ${formatTokens(t.output)} out`;

/** The wire as the lines `work usage` prints. */
export function usageLines(w: UsageWire, now = Date.now()): string[] {
  const lines: string[] = [];
  for (const a of w.agents) {
    lines.push(chalk.bold(a.name));
    const readings = a.accounts.filter((acc) => acc.windows.length > 0);
    if (readings.length === 0) lines.push(chalk.gray('  no reading yet — its next session records one'));
    for (const acc of readings) {
      if (a.accounts.length > 1) lines.push(chalk.gray(`  account ${acc.account}`));
      for (const win of acc.windows) {
        const pct = `${Math.round(win.usedPercent)}%`;
        lines.push(`  ${win.label.padEnd(14)} ${pct.padStart(4)}  ${chalk.gray(resetPhrase(win.resetsAt, now))}`);
      }
    }
  }
  if (w.agents.length === 0) lines.push(chalk.gray('No agent reports its usage limits.'));
  lines.push('', chalk.bold('Tokens'), `  today      ${totals(w.tokens.today)}`, `  this week  ${totals(w.tokens.week)}`);
  const isZero = (t: TokenTotals) => t.input + t.cached + t.output === 0;
  for (const m of w.tokens.byModel) {
    // A model unused today shows only its week.
    const parts = [isZero(m.today) ? '' : `${totals(m.today)} today`, isZero(m.week) ? '' : `${totals(m.week)} this week`].filter(Boolean);
    if (parts.length > 0) lines.push(chalk.gray(`    ${m.model}: ${parts.join(' · ')}`));
  }
  if (w.tokens.topSessions.length > 0) {
    lines.push('', chalk.bold('Top sessions this week'));
    for (const s of w.tokens.topSessions) lines.push(`  ${formatTokens(s.week.input + s.week.output).padStart(7)}  ${s.label}`);
  }
  return lines;
}

export const usageCommand: CommandModule = {
  command: 'usage',
  describe: "Plan limits (5-hour, weekly) as the agent's status line last reported them, and the tokens used today and this week",
  builder: (yargs) =>
    yargs
      .option('json', { type: 'boolean', describe: 'Print the same data the dashboard shows, as JSON' })
      .option('restore', {
        type: 'boolean',
        describe:
          'Give each agent back the setting work reads its limits from (Claude Code: its own status line). work web sets it up again unless config usage.statusLine is false',
      })
      // Its first name, from before it covered every agent.
      .option('restore-statusline', { type: 'boolean', hidden: true }),
  handler: async (argv) => {
    if (argv.restore || argv['restore-statusline']) {
      const done = await restoreAgentUsage(knownAgents());
      if (done.length === 0) console.log('No agent has a usage setting to give back.');
      for (const d of done) console.log(`${d.name}: ${d.message}`);
      if (done.some((d) => !d.ok)) process.exitCode = 1;
      return;
    }
    const wire = await buildUsage(realUsageDeps());
    if (argv.json) {
      console.log(JSON.stringify(wire, null, 2));
      return;
    }
    for (const l of usageLines(wire)) console.log(l);
  },
};
