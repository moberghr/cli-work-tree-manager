import type { CommandModule } from 'yargs';
import { createDigestSource } from '../core/conversations/digest-source.js';
import { digestMarkdown, windowStart, WINDOW_LABEL, type DigestWindow } from '../core/conversations/digest-view.js';
import { askWorkWeb } from '../core/platform/web-discovery.js';
import type { DigestResponse } from '../core/api-types.js';

/** `today` / `yesterday` / `week`, or a date/time → [start, title]. */
export function parseSince(v: string | undefined, now = new Date()): { since: Date; title: string } {
  const w = (v ?? 'today') as DigestWindow;
  if (w in WINDOW_LABEL) return { since: windowStart(w, now), title: WINDOW_LABEL[w] };
  const t = Date.parse(v!);
  if (!Number.isFinite(t)) throw new Error(`--since: use today, yesterday, week, or a date (got "${v}")`);
  return { since: new Date(t), title: `Since ${new Date(t).toLocaleString()}` };
}

export const digestCommand: CommandModule = {
  command: 'digest',
  describe: 'What each session did: the prompts you gave, turns, status, PRs (Markdown for a standup; --json)',
  builder: (yargs) =>
    yargs
      .option('since', { type: 'string', default: 'today', describe: 'today | yesterday | week | a date or time' })
      .option('json', { type: 'boolean', default: false, describe: 'The digest as JSON (the /api/digest shape)' }),
  handler: async (argv) => {
    const { since, title } = parseSince(argv.since as string);
    // A running work web knows more (PR states, diff stats): ask it; else
    // build it here from disk, without those.
    const d =
      (await askWorkWeb<DigestResponse>(`api/digest?since=${encodeURIComponent(since.toISOString())}`, 10_000)) ??
      (await createDigestSource().collect(since.getTime()));
    process.stdout.write(argv.json ? JSON.stringify(d, null, 2) + '\n' : digestMarkdown(d, title));
  },
};
