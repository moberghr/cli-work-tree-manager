import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { configDirPath } from '../../platform/config-dir.js';
import { gitDirs, branchFromHead } from '../../git/git-head.js';

/**
 * work's own status line, for whoever chose it over theirs (config `claudeStatusLine: "work"`; the Settings page and
 * the dashboard's one-time question): the model with how full its context is, the Claude account, the folder and the
 * branch. Drawn inside the status-line hook (statusline-hook.ts) from what Claude Code gives it and from files: no
 * shell, no `jq`, no `git` — each program started costs up to a second on a busy Windows machine, every refresh of
 * every Claude. It loads only what the hook may (tests/architecture/hook-imports.test.ts): never config.ts, so
 * config.json is read here as plain JSON.
 */

/** What the line needs from config.json. `choice` null: never asked (the user's own line shows, as before). */
export interface LineConfig {
  choice: 'work' | 'own' | null;
  /** `claudeAccounts`: name → folder. */
  accounts: Record<string, string>;
}

/** `claudeStatusLine` and `claudeAccounts`, read plainly; a missing or broken file reads as nothing chosen. */
export function readLineConfig(file: string = path.join(configDirPath(), 'config.json')): LineConfig {
  try {
    const v: unknown = JSON.parse(fs.readFileSync(file, 'utf-8'));
    if (typeof v !== 'object' || v === null || Array.isArray(v)) return { choice: null, accounts: {} };
    const raw = v as Record<string, unknown>;
    const choice = raw.claudeStatusLine === 'work' || raw.claudeStatusLine === 'own' ? raw.claudeStatusLine : null;
    const accounts: Record<string, string> = {};
    const given = raw.claudeAccounts;
    if (typeof given === 'object' && given !== null && !Array.isArray(given))
      for (const [name, dir] of Object.entries(given)) if (typeof dir === 'string' && dir) accounts[name] = dir;
    return { choice, accounts };
  } catch {
    return { choice: null, accounts: {} };
  }
}

const samePath = (a: string, b: string, platform: NodeJS.Platform) => {
  const norm = (p: string) => {
    const r = path.resolve(p);
    return platform === 'win32' ? r.toLowerCase() : r;
  };
  return norm(a) === norm(b);
};

/**
 * The account's name: `default` for ~/.claude, its name in `claudeAccounts`, else its folder's name (`.claude-x` → `x`).
 * Null when there is only the one account (no `claudeAccounts`, no CLAUDE_CONFIG_DIR): nothing to tell apart.
 */
export function accountLabel(
  configDir: string | undefined,
  accounts: Record<string, string>,
  home: string = os.homedir(),
  platform: NodeJS.Platform = process.platform,
): string | null {
  const several = Object.keys(accounts).length > 0;
  if (!configDir || samePath(configDir, path.join(home, '.claude'), platform)) return several || configDir ? 'default' : null;
  const named = Object.entries(accounts).find(([, dir]) => samePath(dir.replace(/^~(?=$|[\\/])/, home), configDir, platform));
  if (named) return named[0];
  return path.basename(path.resolve(configDir)).replace(/^\.claude-/, '') || 'default';
}

/** The branch of the checkout `dir` is in (its nearest folder with a `.git`), or the short commit when detached; null outside one. */
export function branchLabel(dir: string): string | null {
  for (let at = path.resolve(dir); ;) {
    const dirs = gitDirs(at);
    if (dirs) {
      try {
        const head = fs.readFileSync(path.join(dirs.gitDir, 'HEAD'), 'utf8');
        return branchFromHead(head) ?? (/^[0-9a-f]{7,}/.exec(head.trim())?.[0].slice(0, 7) || null);
      } catch {
        return null;
      }
    }
    const up = path.dirname(at);
    if (up === at) return null;
    at = up;
  }
}

/** The folder as the line shows it: under home as `~/…`. */
export function folderLabel(dir: string, home: string = os.homedir()): string {
  // Another drive comes back absolute; a folder beside home starts with `..`.
  const rel = path.relative(home, dir);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return dir;
  return rel === '' ? '~' : `~/${rel.split(path.sep).join('/')}`;
}

const color = (code: string, text: string) => `\x1b[${code}m${text}\x1b[0m`;

/** The line for Claude's status-line input: `Opus (42%) admin ~/source/repos/x main`, each part in its colour. */
export function workStatusLine(
  input: Record<string, unknown> | null,
  o: { configDir?: string; accounts?: Record<string, string>; home?: string; platform?: NodeJS.Platform } = {},
): string {
  const home = o.home ?? os.homedir();
  const platform = o.platform ?? process.platform;
  const model = input?.model as { display_name?: unknown } | undefined;
  const ws = input?.workspace as { current_dir?: unknown } | undefined;
  const ctx = input?.context_window as { used_percentage?: unknown } | undefined;
  const name = typeof model?.display_name === 'string' && model.display_name.trim() ? model.display_name.trim() : null;
  const dir = [ws?.current_dir, input?.cwd].find((d): d is string => typeof d === 'string' && d.length > 0) ?? null;
  const used = typeof ctx?.used_percentage === 'number' && Number.isFinite(ctx.used_percentage) ? Math.round(ctx.used_percentage) : null;

  const parts: string[] = [];
  if (name) parts.push(used === null ? color('0;36', name) : `${color('0;36', name)} ${color('0;32', `(${used}%)`)}`);
  const account = accountLabel(o.configDir, o.accounts ?? {}, home, platform);
  if (account) parts.push(color('0;34', account));
  if (dir) {
    parts.push(color('0;33', folderLabel(dir, home)));
    const branch = branchLabel(dir);
    if (branch) parts.push(color('0;35', branch));
  }
  return parts.join(' ');
}
