import fs from 'node:fs';
import path from 'node:path';
import { atomicWriteFile } from '../../platform/fs-safe.js';
import { editSettings, readSettingsFile, type SettingsFile } from '../../platform/settings-editor.js';
import { report } from '../../platform/report.js';
import { WORK_STATUSLINE, isOurs, isRecord, readSaved, savedPath, type StatusLine } from './statusline-run.js';

// Claude hands its rate limits only to the status line command. work puts itself in front of the user's own: it records
// the reading, then runs theirs and passes its output on (statusline-run.ts, the hook's half). This half installs and
// removes it; work web loads it lazily through the adapter (usage.ts), never the hook.

function save(original: StatusLine | null): void {
  fs.mkdirSync(path.dirname(savedPath()), { recursive: true });
  atomicWriteFile(savedPath(), JSON.stringify({ original }));
}

/**
 * The command work puts in Claude's settings: its hook, then — when the user had a line — theirs as the fallback
 * (`work hook statusline || (<theirs>)`). The hook always exits 0 and runs theirs itself (from statusline.json), so the
 * right side runs only when `work` is gone (uninstalled, not on PATH): the user's status line then still shows.
 */
export function wrapperCommand(original: StatusLine | null): string {
  const cmd = original && typeof original.command === 'string' ? original.command.trim() : '';
  if (!cmd) return WORK_STATUSLINE;
  // A `# comment` in it would swallow the closing parenthesis: the parenthesis goes on a line of its own then.
  return /[#\n]/.test(cmd) ? `${WORK_STATUSLINE} || (${cmd}\n)` : `${WORK_STATUSLINE} || (${cmd})`;
}

/** Put work's status line in front of the user's. The original is saved inside the edit, so a change made meanwhile isn't lost. */
export async function wrapStatusLine(): Promise<void> {
  await editSettings((s: SettingsFile) => {
    if (isOurs(s.statusLine)) {
      // Ours already (perhaps under another path, or from before): the fallback follows the saved original. Nothing
      // readable saved: left as it is — its fallback may be the only copy of the user's line.
      const saved = readSaved();
      if (saved.kind === 'ok') s.statusLine = { ...(s.statusLine as StatusLine), command: wrapperCommand(saved.original) };
      return;
    }
    // Not ours: the user's line, perhaps set again with /statusline since — saved fresh, with a new fallback.
    const original = isRecord(s.statusLine) ? s.statusLine : null;
    save(original);
    const { command: _c, type: _t, ...keep } = original ?? {};
    s.statusLine = { ...keep, type: 'command', command: wrapperCommand(original) };
  });
}

/** The statusLine entry of Claude's settings as it is now; `unreadable` when the file doesn't parse. */
export function readStatusLineSetting(): { kind: 'ok'; statusLine: unknown } | { kind: 'unreadable' } {
  const s = readSettingsFile();
  return s ? { kind: 'ok', statusLine: s.statusLine } : { kind: 'unreadable' };
}

/**
 * What unwrapStatusLine did: put the original back, found a status line that isn't work's (left alone), kept work's
 * because the saved original is missing or damaged (putting nothing back would lose the user's), or couldn't edit the settings.
 */
export type UnwrapOutcome = 'restored' | 'not-ours' | 'kept' | 'failed';

/** Give the user's status line back (settings left alone when it isn't ours, or when what was saved can't be read). */
export async function unwrapStatusLine(): Promise<UnwrapOutcome> {
  let outcome = 'failed' as UnwrapOutcome; // the mutate never runs when the settings can't be read (set inside it, hence the cast)
  await editSettings((s: SettingsFile) => {
    if (!isOurs(s.statusLine)) {
      outcome = 'not-ours';
      return;
    }
    const saved = readSaved();
    if (saved.kind !== 'ok') {
      outcome = 'kept';
      return;
    }
    if (saved.original) s.statusLine = saved.original;
    else delete s.statusLine;
    outcome = 'restored';
  });
  if (outcome === 'kept')
    report(
      'warn',
      `[work] ${savedPath()} (your own status line, saved by work) is missing or damaged: Claude's status line left as it is.`,
    );
  // The saved original goes only once the settings no longer point at work: a failed write must not lose it.
  const now = readStatusLineSetting();
  if (outcome !== 'kept' && now.kind === 'ok' && !isOurs(now.statusLine)) fs.rmSync(savedPath(), { force: true });
  return outcome;
}

/**
 * The choice work web makes at start (a lean `wd` server never touches it): `enabled: false` (config
 * `usage.statusLine: false`) gives the user's status line back, anything else wraps it.
 */
export async function applyStatusLineSetting(o: { enabled: boolean; lean: boolean }): Promise<'wrapped' | 'restored' | 'skipped'> {
  if (o.lean) return 'skipped';
  if (!o.enabled) {
    await unwrapStatusLine();
    return 'restored';
  }
  await wrapStatusLine();
  return 'wrapped';
}
