import fs from 'node:fs';
import path from 'node:path';
import { editSettings, readSettingsFile, type SettingsFile } from '../../platform/settings-editor.js';
import { report } from '../../platform/report.js';
import { setUpAccounts } from './accounts.js';
import { isOurs, readSaved, savedPath } from './statusline-run.js';

// Claude hands its rate limits only to the status line command. work gives the Claudes it starts its own line
// (session-settings.ts, `--settings`), which records the reading and runs the user's (statusline-hook.ts). Before, work web
// wrapped the user's own line in `~/.claude/settings.json` (and each account's), so every Claude ran work's hook; this
// half gives it back (work web's start, `work usage --restore`). Loaded lazily (usage.ts), never by the hook.

// Each account has its own settings and its own saved original: every function takes the account's config folder
// (`configDir`; none = the default account, ~/.claude) and works on its `settings.json` and `statusline[-<account>].json`.

const settingsOf = (configDir?: string) => (configDir ? path.join(configDir, 'settings.json') : undefined);

/** The statusLine entry of Claude's settings as it is now; `unreadable` when the file doesn't parse. */
export function readStatusLineSetting(configDir?: string): { kind: 'ok'; statusLine: unknown } | { kind: 'unreadable' } {
  const s = readSettingsFile(settingsOf(configDir));
  return s ? { kind: 'ok', statusLine: s.statusLine } : { kind: 'unreadable' };
}

/**
 * What unwrapStatusLine did: put the original back, found a status line that isn't work's (left alone), kept work's
 * because the saved original is missing or damaged (putting nothing back would lose the user's), or couldn't edit the settings.
 */
export type UnwrapOutcome = 'restored' | 'not-ours' | 'kept' | 'failed';

/** Give the user's status line back (settings left alone when it isn't ours, or when what was saved can't be read). */
export async function unwrapStatusLine(configDir?: string): Promise<UnwrapOutcome> {
  let outcome = 'failed' as UnwrapOutcome; // the mutate never runs when the settings can't be read (set inside it, hence the cast)
  await editSettings((s: SettingsFile) => {
    if (!isOurs(s.statusLine)) {
      outcome = 'not-ours';
      return;
    }
    const saved = readSaved(configDir);
    if (saved.kind !== 'ok') {
      outcome = 'kept';
      return;
    }
    if (saved.original) s.statusLine = saved.original;
    else delete s.statusLine;
    outcome = 'restored';
  }, settingsOf(configDir));
  if (outcome === 'kept')
    report(
      'warn',
      `[work] ${savedPath(configDir)} (your own status line, saved by work) is missing or damaged: Claude's status line left as it is.`,
    );
  // The saved original goes only once the settings no longer point at work: a failed write must not lose it.
  const now = readStatusLineSetting(configDir);
  if (outcome !== 'kept' && now.kind === 'ok' && !isOurs(now.statusLine)) fs.rmSync(savedPath(configDir), { force: true });
  return outcome;
}

/** Give every account's status line back (a configured account only once its folder exists); the outcome of each, by account name. */
export async function unwrapAllStatusLines(): Promise<Array<{ account: string; outcome: UnwrapOutcome }>> {
  const out: Array<{ account: string; outcome: UnwrapOutcome }> = [];
  for (const a of setUpAccounts()) out.push({ account: a.name, outcome: await unwrapStatusLine(a.dir) });
  return out;
}
