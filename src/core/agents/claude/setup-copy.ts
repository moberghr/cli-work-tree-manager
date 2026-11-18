import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { applyEnvDelta, type EnvDelta } from '../../platform/env-delta.js';
import { atomicWriteFile, ensureFile, withFileLockSync } from '../../platform/fs-safe.js';
import spawn from '../../platform/spawn.js';
import { accountDirKey, defaultAccountDir } from './accounts.js';

/**
 * Copy one Claude account's SETUP to another (reported: a second account starts empty — none of the first one's MCP
 * servers, plugins, CLAUDE.md, agents, commands or permissions — so a session moved to it lost its tools).
 *
 * What goes across:
 * - files and folders that are yours: `CLAUDE.md`, `agents/`, `commands/`, each of `skills/` (not `synced`, which
 *   Claude Code manages), your status line's script;
 * - `settings.json` and `settings.local.json`, MERGED (`mergeSettings`): never `statusLine` or work's own hooks, which
 *   work sets up per account;
 * - user-scope MCP servers, marketplaces and enabled plugins, through the `claude` CLI run AS the target account, so
 *   Claude Code's own locking and install logic do the writing (its `.claude.json` is rewritten by every running
 *   Claude; a plugin's files are fetched, not copied).
 *
 * What never goes across: logins and tokens (`.credentials.json`, an MCP server's sign-in), conversations, history,
 * usage and caches. A server that needs a sign-in needs it once more on the target account.
 * Nothing on the target is deleted: what it has and the source hasn't stays.
 */

export interface SetupAccount {
  name: string;
  /** Its config folder. */
  dir: string;
}

export type SetupKind = 'file' | 'folder' | 'settings' | 'mcp' | 'marketplace' | 'plugin';

export interface SetupItem {
  kind: SetupKind;
  /** What it is, as the list names it: `CLAUDE.md`, `agents/`, `atlassian`, `mtk@moberg-plugins`. */
  name: string;
  /** What the copy does with it. */
  does: 'adds' | 'replaces' | 'merges into';
  /** Something to know of it (a sign-in needed, where it comes from). */
  note?: string;
}

export interface SetupResult extends SetupItem {
  ok: boolean;
  /** Why it didn't go (not ok). */
  error?: string;
}

/** Where an account's global config (`mcpServers` and Claude Code's own state) is: `~/.claude.json` for the default folder, inside the folder for another. */
export function globalConfigFile(dir: string, home: string = os.homedir()): string {
  return accountDirKey(dir) === accountDirKey(path.join(home, '.claude'))
    ? path.join(home, '.claude.json')
    : path.join(dir, '.claude.json');
}

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** Settings a copy never carries: work sets them up for each account itself. */
const NEVER_COPIED = new Set(['statusLine']);
/** Settings that are maps: the source's entries are added over the target's. */
const MAPS = new Set(['enabledPlugins', 'extraKnownMarketplaces', 'mcpServers', 'env', 'skillOverrides']);

/**
 * The target's settings with the source's merged in. Lists of rules (`permissions.allow` / `deny` / `ask`) are joined,
 * each rule once; maps take the source's entries over the target's; a hook goes across unless it is work's own
 * (`_workHookOwner`: set up per account) or the target has it already; anything else is the source's value. What only
 * the target has stays. Pure.
 */
export function mergeSettings(source: Record<string, unknown>, target: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...target };
  for (const [key, value] of Object.entries(source)) {
    if (NEVER_COPIED.has(key)) continue;
    if (key === 'hooks') {
      if (!isObject(value)) continue;
      const hooks: Record<string, unknown[]> = {};
      for (const [event, list] of Object.entries(isObject(target.hooks) ? target.hooks : {}))
        hooks[event] = Array.isArray(list) ? [...list] : [];
      for (const [event, list] of Object.entries(value)) {
        for (const entry of Array.isArray(list) ? list : []) {
          if (isObject(entry) && '_workHookOwner' in entry) continue;
          if (!(hooks[event] ??= []).some((have) => same(have, entry))) hooks[event].push(entry);
        }
      }
      if (Object.keys(hooks).length) out.hooks = hooks;
    } else if (key === 'permissions' && isObject(value)) {
      const have = isObject(target.permissions) ? target.permissions : {};
      const merged: Record<string, unknown> = { ...have };
      for (const [k, v] of Object.entries(value)) {
        merged[k] = Array.isArray(v) ? [...new Set([...(Array.isArray(have[k]) ? (have[k] as unknown[]) : []), ...v])] : v;
      }
      out.permissions = merged;
    } else if (MAPS.has(key) && isObject(value)) {
      out[key] = { ...(isObject(target[key]) ? target[key] : {}), ...value };
    } else {
      out[key] = value;
    }
  }
  return out;
}

/**
 * What merging `source` into `target` would change, in a few words each (found on the first real use: the plan said
 * "merges into settings" for one plugin that would be switched back on, which is the thing to know before saying
 * yes). Names only, never a value that could be a key (`env`). Pure.
 */
export function settingsChanges(source: Record<string, unknown>, target: Record<string, unknown>): string[] {
  const merged = mergeSettings(source, target);
  const out: string[] = [];
  for (const key of Object.keys(merged)) {
    const now = merged[key];
    const was = target[key];
    if (same(now, was)) continue;
    if (key === 'enabledPlugins' && isObject(now)) {
      const before = isObject(was) ? was : {};
      for (const [id, on] of Object.entries(now))
        if (before[id] !== on) out.push(`${on === true ? 'turns on' : 'turns off'} plugin ${id}${id in before ? '' : ' (new here)'}`);
    } else if (key === 'permissions' && isObject(now)) {
      const before = isObject(was) ? was : {};
      for (const [k, v] of Object.entries(now)) {
        if (same(v, before[k])) continue;
        if (Array.isArray(v)) {
          const n = v.length - (Array.isArray(before[k]) ? (before[k] as unknown[]).length : 0);
          out.push(`adds ${n} ${k} rule${n === 1 ? '' : 's'}`);
        } else out.push(`sets permissions.${k}`);
      }
    } else if (key === 'hooks' && isObject(now)) {
      const count = (h: unknown) => (isObject(h) ? Object.values(h).reduce((n: number, l) => n + (Array.isArray(l) ? l.length : 0), 0) : 0);
      const n = count(now) - count(was);
      out.push(`adds ${n} of your hook${n === 1 ? '' : 's'}`);
    } else if (MAPS.has(key) && isObject(now)) {
      const before = isObject(was) ? was : {};
      const names = Object.keys(now).filter((k) => !same(now[k], before[k]));
      out.push(`${key}: ${names.slice(0, 4).join(', ')}${names.length > 4 ? ` and ${names.length - 4} more` : ''}`);
    } else out.push(`sets ${key}`);
  }
  return out;
}

/** What `claude plugin marketplace add` is given for a marketplace as Claude Code recorded it; null: a kind we don't know how to add. */
export function marketplaceAddArgs(source: unknown): string[] | null {
  if (!isObject(source)) return null;
  const sparse =
    Array.isArray(source.sparsePaths) && source.sparsePaths.every((p) => typeof p === 'string') ? (source.sparsePaths as string[]) : [];
  const where =
    source.source === 'github' && typeof source.repo === 'string'
      ? source.repo
      : source.source === 'directory' && typeof source.path === 'string'
        ? source.path
        : (source.source === 'git' || source.source === 'url') && typeof source.url === 'string'
          ? source.url
          : null;
  // Never an option in the place of a source (a name starting with a dash).
  if (!where || where.startsWith('-') || sparse.some((p) => p.startsWith('-'))) return null;
  return ['plugin', 'marketplace', 'add', where, '--scope', 'user', ...(sparse.length ? ['--sparse', ...sparse] : [])];
}

/** The files and folders of an account that are the user's own setup. `skills/synced` is Claude Code's. */
const FILES = ['CLAUDE.md', 'statusline-command.sh'];
const FOLDERS = ['agents', 'commands'];
const SETTINGS = ['settings.json', 'settings.local.json'];

export interface SetupIo {
  exists: (p: string) => boolean;
  isDir: (p: string) => boolean;
  list: (dir: string) => string[];
  readJson: (file: string) => unknown;
  /** A file's bytes; null when it can't be read. */
  read: (file: string) => Buffer | null;
}

/**
 * Every file of `from` (a file, or a folder and all under it) is in `to` with the same content: copying it would
 * change nothing (found on the first real use: a second copy listed CLAUDE.md, the agents and every skill as
 * "replaces" though they were identical). What `to` has besides doesn't matter: a copy deletes nothing. Pure but for `io`.
 */
export function alreadyThere(from: string, to: string, io: SetupIo): boolean {
  if (io.isDir(from)) return io.isDir(to) && io.list(from).every((name) => alreadyThere(path.join(from, name), path.join(to, name), io));
  const a = io.read(from);
  const b = io.read(to);
  return !!a && !!b && a.equals(b);
}

/** Where a marketplace comes from, as one key: two names for one source are one marketplace (`moberghr` and `moberghr-claude-helpers`). */
export function marketplaceKey(source: unknown): string | null {
  const args = marketplaceAddArgs(source);
  return args ? args[3].replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase() : null;
}

export const realSetupIo: SetupIo = {
  exists: (p) => fs.existsSync(p),
  isDir: (p) => {
    try {
      return fs.statSync(p).isDirectory();
    } catch {
      return false;
    }
  },
  list: (dir) => {
    try {
      return fs.readdirSync(dir);
    } catch {
      return [];
    }
  },
  read: (file) => {
    try {
      return fs.readFileSync(file);
    } catch {
      return null;
    }
  },
  readJson: (file) => {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf-8')) as unknown;
    } catch {
      return null;
    }
  },
};

const objectAt = (v: unknown, key: string): Record<string, unknown> =>
  isObject(v) && isObject(v[key]) ? (v[key] as Record<string, unknown>) : {};

/** The user-scope MCP servers of an account, by name (its global config's `mcpServers`). */
export function userMcpServers(dir: string, io: SetupIo = realSetupIo): Record<string, unknown> {
  return objectAt(io.readJson(globalConfigFile(dir)), 'mcpServers');
}

/**
 * What a copy from `from` to `to` would do, in the order it is done: a read (nothing is changed or started). Only
 * what differs is listed, so an account already set up the same gives an empty plan.
 */
export function planSetupCopy(from: SetupAccount, to: SetupAccount, io: SetupIo = realSetupIo): SetupItem[] {
  const items: SetupItem[] = [];
  const there = (rel: string) => io.exists(path.join(to.dir, rel));
  // Only what a copy would change: a file or folder the target has with the same content already isn't listed.
  const differs = (rel: string) => !alreadyThere(path.join(from.dir, rel), path.join(to.dir, rel), io);
  for (const f of FILES)
    if (io.exists(path.join(from.dir, f)) && differs(f)) items.push({ kind: 'file', name: f, does: there(f) ? 'replaces' : 'adds' });
  for (const d of FOLDERS)
    if (io.isDir(path.join(from.dir, d)) && io.list(path.join(from.dir, d)).length && differs(d))
      items.push({ kind: 'folder', name: `${d}/`, does: there(d) ? 'merges into' : 'adds' });
  for (const skill of io.list(path.join(from.dir, 'skills')).filter((s) => s !== 'synced' && io.isDir(path.join(from.dir, 'skills', s))))
    if (differs(path.join('skills', skill)))
      items.push({ kind: 'folder', name: `skills/${skill}/`, does: there(path.join('skills', skill)) ? 'replaces' : 'adds' });
  for (const s of SETTINGS) {
    const source = io.readJson(path.join(from.dir, s));
    if (!isObject(source)) continue;
    const target = io.readJson(path.join(to.dir, s));
    const have = isObject(target) ? target : {};
    if (!same(mergeSettings(source, have), have))
      items.push({
        kind: 'settings',
        name: s,
        does: 'merges into',
        // What it would change, by name; the rest of the file stays (the status line and work's hooks always).
        note: settingsChanges(source, have).join('; '),
      });
  }
  const servers = userMcpServers(from.dir, io);
  const haveServers = userMcpServers(to.dir, io);
  for (const [name, def] of Object.entries(servers)) {
    if (same(haveServers[name], def)) continue;
    const remote = isObject(def) && (def.type === 'http' || def.type === 'sse');
    items.push({
      kind: 'mcp',
      name,
      does: name in haveServers ? 'replaces' : 'adds',
      ...(remote ? { note: `needs its own sign-in on ${to.name}: /mcp → ${name} → Authenticate` } : {}),
    });
  }
  const markets = io.readJson(path.join(from.dir, 'plugins', 'known_marketplaces.json'));
  const haveMarkets = io.readJson(path.join(to.dir, 'plugins', 'known_marketplaces.json'));
  // By where each comes from, not its name: Claude Code names one after its own manifest, so the same marketplace
  // can carry another name on the other account (found on the first real use: two were offered again).
  const haveSources = new Set(
    Object.values(isObject(haveMarkets) ? haveMarkets : {})
      .map((m) => marketplaceKey(isObject(m) ? m.source : null))
      .filter((k): k is string => k !== null),
  );
  for (const [name, m] of Object.entries(isObject(markets) ? markets : {})) {
    if (isObject(haveMarkets) && name in haveMarkets) continue;
    const key = marketplaceKey(isObject(m) ? m.source : null);
    if (key && haveSources.has(key)) continue;
    const args = marketplaceAddArgs(isObject(m) ? m.source : null);
    if (args) items.push({ kind: 'marketplace', name, does: 'adds', note: args[3] });
  }
  const enabled = objectAt(io.readJson(path.join(from.dir, 'settings.json')), 'enabledPlugins');
  const installed = objectAt(io.readJson(path.join(to.dir, 'plugins', 'installed_plugins.json')), 'plugins');
  for (const [id, on] of Object.entries(enabled))
    if (on === true && !(id in installed)) items.push({ kind: 'plugin', name: id, does: 'adds', note: 'installed from its marketplace' });
  return items;
}

/** Runs `claude <args>` as an account (argv only, §1.1; `input`: its stdin). */
export type SetupRun = (args: string[], env: EnvDelta, input?: string) => { ok: boolean; out: string };

const runClaude: SetupRun = (args, env, input) => {
  const r = spawn.sync('claude', args, {
    encoding: 'utf8',
    timeout: 180_000,
    windowsHide: true,
    stdio: 'pipe',
    env: applyEnvDelta(process.env, env) as NodeJS.ProcessEnv,
    ...(input !== undefined ? { input } : {}),
  });
  const text = (v: unknown) => (typeof v === 'string' ? v : '');
  return { ok: !r.error && r.status === 0, out: r.error ? r.error.message : `${text(r.stderr)}\n${text(r.stdout)}` };
};

const lastLine = (out: string) =>
  out
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .pop() ?? 'it failed';

/** The environment that makes `claude` act on an account's folder: nothing set for the default one. */
export function setupEnv(dir: string): EnvDelta {
  return accountDirKey(dir) === accountDirKey(defaultAccountDir()) ? { CLAUDE_CONFIG_DIR: null } : { CLAUDE_CONFIG_DIR: dir };
}

/** One settings file merged under its lock, written whole (§5.2: a file that stays a file). */
function mergeSettingsFile(fromFile: string, toFile: string): void {
  const source = JSON.parse(fs.readFileSync(fromFile, 'utf-8')) as unknown;
  if (!isObject(source)) throw new Error('its settings are not an object');
  fs.mkdirSync(path.dirname(toFile), { recursive: true });
  ensureFile(toFile, '{}\n');
  withFileLockSync(toFile, () => {
    let target: unknown = {};
    try {
      target = JSON.parse(fs.readFileSync(toFile, 'utf-8'));
    } catch {
      // An empty or broken file is replaced by the merge of nothing.
    }
    atomicWriteFile(toFile, `${JSON.stringify(mergeSettings(source, isObject(target) ? target : {}), null, 2)}\n`);
  });
}

/**
 * Do the copy: every item of the plan as it is now, one after another, each reported. One that fails is said and the
 * rest still go. `run`: a test's.
 */
export async function applySetupCopy(from: SetupAccount, to: SetupAccount, run: SetupRun = runClaude): Promise<SetupResult[]> {
  if (accountDirKey(from.dir) === accountDirKey(to.dir)) throw new Error('an account’s setup can’t be copied to itself');
  const env = setupEnv(to.dir);
  const servers = userMcpServers(from.dir);
  const markets = realSetupIo.readJson(path.join(from.dir, 'plugins', 'known_marketplaces.json'));
  const results: SetupResult[] = [];
  for (const item of planSetupCopy(from, to)) {
    try {
      const rel = item.name.replace(/\/$/, '');
      if (item.kind === 'file') {
        fs.mkdirSync(to.dir, { recursive: true });
        fs.copyFileSync(path.join(from.dir, rel), path.join(to.dir, rel));
      } else if (item.kind === 'folder') {
        // Symlinks are not followed out of the folder: a link is copied as a link.
        fs.cpSync(path.join(from.dir, rel), path.join(to.dir, rel), { recursive: true, force: true, verbatimSymlinks: true });
      } else if (item.kind === 'settings') {
        mergeSettingsFile(path.join(from.dir, rel), path.join(to.dir, rel));
      } else if (item.kind === 'mcp') {
        if (item.does === 'replaces') run(['mcp', 'remove', item.name, '--scope', 'user'], env);
        // Its definition goes on stdin: a server's env or headers may hold a key, which must not be on a command line.
        const r = run(['mcp', 'add-json', item.name, '-', '--scope', 'user'], env, JSON.stringify(servers[item.name]));
        if (!r.ok) throw new Error(lastLine(r.out));
      } else if (item.kind === 'marketplace') {
        const args = marketplaceAddArgs(
          isObject(markets) && isObject(markets[item.name]) ? (markets[item.name] as Record<string, unknown>).source : null,
        );
        if (!args) throw new Error('work doesn’t know how to add this kind of marketplace');
        const r = run(args, env);
        if (!r.ok) throw new Error(lastLine(r.out));
      } else {
        const r = run(['plugin', 'install', item.name, '--scope', 'user', '-y'], env);
        if (!r.ok) throw new Error(lastLine(r.out));
      }
      results.push({ ...item, ok: true });
    } catch (err) {
      results.push({ ...item, ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return results;
}

/** "Copied 9 of 11 things from default to admin; 2 failed" / "admin already has default's setup." Pure. */
export function setupSummary(results: readonly SetupResult[], from: string, to: string): string {
  if (results.length === 0) return `${to} already has ${from}'s setup: nothing to copy.`;
  const ok = results.filter((r) => r.ok).length;
  const failed = results.length - ok;
  return `Copied ${ok} of ${results.length} thing${results.length === 1 ? '' : 's'} from ${from} to ${to}${failed ? `; ${failed} failed` : ''}.`;
}
