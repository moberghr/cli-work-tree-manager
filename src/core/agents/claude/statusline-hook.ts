import fs from 'node:fs';
import { recordReading } from '../../usage/usage-store.js';
import { debugLog } from '../../platform/logger.js';
import { accountOf, parseClaudeRateLimits } from './rate-limits.js';
import { NESTED_ENV, originalStatusLine, runStatusLineCommand } from './statusline-run.js';

/** More than any status-line input: the rest is not read. */
const INPUT_CAP = 1_000_000;

/**
 * Claude's status line command, `work hook statusline` (bin.ts loads this module and nothing else of the CLI;
 * statusline.ts installs it): keep the rate limits it sends, then show what the user's own status line prints.
 * It is Claude's screen, so nothing else is ever written — not even an error (those go to the debug log).
 */
export async function runStatusLineHook(
  o: { stdin?: NodeJS.ReadableStream; stdout?: NodeJS.WritableStream; env?: NodeJS.ProcessEnv } = {},
): Promise<void> {
  const stdin = o.stdin ?? process.stdin;
  const stdout = o.stdout ?? process.stdout;
  const env = o.env ?? process.env;
  // Claude may close the pipe before we write (a refresh replaced this one): EPIPE is nothing to report.
  stdout.on('error', () => {});
  try {
    // Bytes, decoded once: a character can be cut in two between chunks.
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of stdin) {
      const b = typeof chunk === 'string' ? Buffer.from(chunk) : Buffer.from(chunk as Uint8Array);
      chunks.push(b);
      size += b.length;
      if (size > INPUT_CAP) break;
    }
    const raw = Buffer.concat(chunks).toString('utf-8');
    let input: Record<string, unknown> | null = null;
    try {
      const v: unknown = JSON.parse(raw);
      if (typeof v === 'object' && v !== null && !Array.isArray(v)) input = v as Record<string, unknown>;
    } catch {
      /* not JSON: nothing to record, the user's own line still runs */
    }
    if (input) {
      const limits = parseClaudeRateLimits(input.rate_limits);
      const given = input.rate_limits;
      // Limits given in a shape the parser doesn't know (a Claude Code update): say so in the log, once per refresh.
      if (limits.length === 0 && typeof given === 'object' && given !== null && Object.keys(given).length > 0)
        debugLog('WARN', `[statusline] rate_limits not understood; keys: ${Object.keys(given).join(', ')}`);
      recordReading('claude', accountOf(env.CLAUDE_CONFIG_DIR), limits);
    }
    // Run by the user's own command (it calls work's hook itself): running it again would never end.
    if (env[NESTED_ENV]) return;
    const orig = originalStatusLine((why) => debugLog('WARN', `[statusline] saved status line unreadable: ${why}`));
    if (!orig) return;
    const ws = input?.workspace as { current_dir?: unknown } | undefined;
    const dir = [input?.cwd, ws?.current_dir].find((d): d is string => typeof d === 'string' && fs.existsSync(d));
    stdout.write(await runStatusLineCommand(orig.command, raw, { cwd: dir }));
  } catch (e) {
    debugLog('WARN', `[statusline] ${e instanceof Error ? e.message : String(e)}`);
  }
}
