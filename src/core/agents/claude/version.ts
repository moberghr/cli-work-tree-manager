import fs from 'node:fs';
import os from 'node:os';
import { findOnPath } from '../../platform/find-on-path.js';
import { launchFor } from '../../platform/batch-launch.js';
import spawn from '../../platform/spawn.js';
import { killTreeAsync } from '../../platform/process.js';
import { installTime } from '../../pty/agent-restart.js';
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

/** How long an answer is kept even when nothing about the binary seems to have changed: a backstop for an update the
 *  stamp can't see. */
export const VERSION_TTL_MS = 10 * 60_000;

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
  /** What identifies the installed binary (`binaryStamp`; null: can't be read — then nothing is remembered). */
  stamp: (file: string) => string | null;
  /** `claude --version`'s output (null: it failed or timed out). */
  version: (file: string) => Promise<string | null>;
  /** The clock (for the TTL). */
  now?: () => number;
}

/**
 * The file `claude` really runs (links followed: `~/.local/bin/claude` → `versions/2.1.296`), when it was installed
 * (`installTime`: npm unpacks every file dated 1985, so its mtime alone never moves on an npm update) and its size:
 * an update changes at least one. Null when it can't be read.
 */
export function binaryStamp(file: string): string | null {
  try {
    const real = fs.realpathSync(file);
    const st = fs.statSync(real);
    return `${real}|${installTime(st)}|${st.size}`;
  } catch {
    return null;
  }
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
      // A .cmd shim runs under cmd.exe: the tree goes, not only the shell.
      if (child.pid) void killTreeAsync(child.pid);
      else child.kill();
      done(null);
    }, VERSION_TIMEOUT_MS);
    child.stdout?.on('data', (d: Buffer) => (out += d.toString()));
    child.on('error', () => done(null));
    child.on('close', (code) => done(code === 0 ? out : null));
  });
}

const realIo: VersionIo = {
  find: () => findOnPath('claude'),
  stamp: binaryStamp,
  version: runVersion,
};

/** Asked once per binary (its stamp), for at most VERSION_TTL_MS: an update of Claude Code is asked again. */
const cache = new Map<string, { at: number; answer: Promise<{ ok: boolean; why?: string }> }>();

/**
 * Whether the installed Claude Code may run the read-only review: at least READ_ONLY_MIN_VERSION. Unknown — not on
 * PATH, `--version` failing or saying nothing parseable — is no.
 */
export function claudeReadOnlyAvailable(io: VersionIo = realIo): Promise<{ ok: boolean; why?: string }> {
  const file = io.find();
  if (!file) return Promise.resolve({ ok: false, why: "Claude Code's version can't be told (claude isn't on PATH)" });
  const stamp = io.stamp(file);
  const now = io.now ?? Date.now;
  const key = stamp ? `${file}|${stamp}` : null;
  const known = key ? cache.get(key) : undefined;
  if (known && now() - known.at < VERSION_TTL_MS) return known.answer;
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
  // A binary that can't be identified isn't remembered at all, and a failure to ask not for good: the next review
  // asks again (the binary may be fine a moment later).
  if (!key) return asked;
  const entry = { at: now(), answer: asked };
  cache.set(key, entry);
  void asked.then((r) => {
    if (!r.ok && r.why?.includes("can't be told") && cache.get(key) === entry) cache.delete(key);
  });
  return asked;
}

/** For tests: forget what was asked. */
export function forgetClaudeVersions(): void {
  cache.clear();
}
