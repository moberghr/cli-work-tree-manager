import fs from 'node:fs';
import os from 'node:os';
import { findOnPath } from '../../platform/find-on-path.js';
import { launchFor } from '../../platform/batch-launch.js';
import spawn from '../../platform/spawn.js';
import { READ_ONLY_MIN_VERSION } from './internal.js';

/**
 * Which Claude Code is installed, for the read-only review run (internal.ts, `internalClaudeReadOnlySpawn`): its
 * isolation rests on flags measured on one version — `--restricted`, `--setting-sources user`,
 * CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD. An older Claude Code may not know them, or not keep them as measured,
 * so below that version (or one that can't be told) the checkout run is skipped and the Reviews AI step reads the diff
 * alone (review-queue.ts says why in Activity).
 */

/** How long `claude --version` may take. */
export const VERSION_TIMEOUT_MS = 10_000;

/** `2.1.317 (Claude Code)` → [2, 1, 317]; null when there's no version in it. Pure. */
export function parseClaudeVersion(text: string): [number, number, number] | null {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(text);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** a ≥ b, part by part. Pure. */
export function atLeast(a: [number, number, number], b: [number, number, number]): boolean {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return true;
}

export interface VersionIo {
  /** The file `claude` runs (null: not on PATH). */
  find: () => string | null;
  /** Its modification time (null: can't be read). */
  mtime: (file: string) => number | null;
  /** `claude --version`'s output (null: it failed or timed out). */
  version: (file: string) => Promise<string | null>;
}

/** `<file> --version`, with a timeout: what it printed, or null. */
export function runVersion(file: string): Promise<string | null> {
  return new Promise((resolve) => {
    const launch = launchFor(file, ['--version']);
    if ('refused' in launch) return resolve(null);
    let out = '';
    let settled = false;
    const done = (v: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(v);
    };
    const child = spawn(launch.cmd, launch.args, { cwd: os.tmpdir(), windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    const timer = setTimeout(() => {
      child.kill();
      done(null);
    }, VERSION_TIMEOUT_MS);
    child.stdout?.on('data', (d: Buffer) => (out += d.toString()));
    child.on('error', () => done(null));
    child.on('close', (code) => done(code === 0 ? out : null));
  });
}

const realIo: VersionIo = {
  find: () => findOnPath('claude'),
  mtime: (file) => {
    try {
      return fs.statSync(file).mtimeMs;
    } catch {
      return null;
    }
  },
  version: runVersion,
};

/** Asked once per binary (path + mtime): an update of Claude Code is a new file, asked again. */
const cache = new Map<string, Promise<{ ok: boolean; why?: string }>>();

/**
 * Whether the installed Claude Code may run the read-only review: at least READ_ONLY_MIN_VERSION. Unknown — not on
 * PATH, `--version` failing or saying nothing parseable — is no.
 */
export function claudeReadOnlyAvailable(io: VersionIo = realIo): Promise<{ ok: boolean; why?: string }> {
  const file = io.find();
  if (!file) return Promise.resolve({ ok: false, why: "Claude Code's version can't be told (claude isn't on PATH)" });
  const key = `${file}|${io.mtime(file) ?? 'unknown'}`;
  const known = cache.get(key);
  if (known) return known;
  const asked = io.version(file).then((text): { ok: boolean; why?: string } => {
    const v = text ? parseClaudeVersion(text) : null;
    if (!v) return { ok: false, why: "Claude Code's version can't be told (claude --version gave none)" };
    const min = parseClaudeVersion(READ_ONLY_MIN_VERSION)!;
    return atLeast(v, min)
      ? { ok: true }
      : {
          ok: false,
          why: `Claude Code ${v.join('.')} is older than ${READ_ONLY_MIN_VERSION}, the version its read-only flags were measured on`,
        };
  });
  // A failure to ask isn't remembered for good: the next review asks again (the binary may be fine a moment later).
  cache.set(key, asked);
  void asked.then((r) => {
    if (!r.ok && r.why?.includes("can't be told")) cache.delete(key);
  });
  return asked;
}

/** For tests: forget what was asked. */
export function forgetClaudeVersions(): void {
  cache.clear();
}
