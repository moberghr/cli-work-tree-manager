import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getConfigDir, getConfigPath, loadConfig } from '../platform/config.js';
import { replaceDb, snapshotDb, withDb } from '../platform/db.js';
import { atomicWriteFile } from '../platform/fs-safe.js';
import { loadHistory, saveHistory, type WorktreeSession } from '../sessions/history.js';
import { sessionIdFor } from '../sessions/session-id.js';
import { agentOf } from '../agents/index.js';
import { originUrl, readGitConfig } from '../worktree/repo-scan.js';
import { defaultRunner, type CommandRunner } from '../pr/ship.js';
import { createInProcess, type CreateWorktree } from '../worktree/setup-child.js';
import { readWebUrl, webServerResponds } from '../platform/web-discovery.js';
import { findHost } from '../pty/pty-host-client.js';

/**
 * Moving work to another computer (`work move export` / `import`). A bundle
 * is a folder you carry over (OneDrive, a USB stick): a snapshot of
 * state.db, config.json, work's own conversation copies and archives, the
 * groups' instruction files, every live session's agent transcripts, and a
 * manifest with each repo's origin. Never `~/.work` itself live in a synced
 * folder: syncing a database corrupts it, and two computers would both run
 * the PR and Jira watches.
 *
 * Import writes it all back with paths moved to the new computer (another
 * home folder, or other repo / worktree roots), clones repos that aren't
 * there (`--clone`), recreates live sessions' worktrees from their branches
 * on origin — so export first checks nothing is uncommitted or unpushed —
 * and puts the transcripts back where the agent looks, so conversations
 * resume. Checkpoint refs and wd's own review scopes stay behind (they live
 * in the old repos, keyed by old paths).
 */

export const BUNDLE_VERSION = 1;

export interface MoveManifest {
  version: number;
  exportedAt: string;
  from: { home: string; platform: string; worktreesRoot: string };
  /** Each repo's folder and origin URL, so a missing one can be cloned. */
  repos: Record<string, { path: string; origin: string | null }>;
  sessions: Array<{ id: string; target: string; branch: string; archived: boolean; transcripts: number }>;
}

/** A refusal, in words for the CLI. */
export class MoveError extends Error {}

const exists = (p: string) => fs.existsSync(p);

// ---- before export: what wouldn't survive the move -------------------------------

export interface Unsaved {
  session: string;
  repo: string;
  path: string;
  what: string;
}

/**
 * Work only this computer has, per live session's repo: uncommitted files,
 * commits not on origin. Import recreates worktrees from origin, so these
 * would stay behind.
 */
export async function unsavedWork(sessions: WorktreeSession[], run: CommandRunner = defaultRunner): Promise<Unsaved[]> {
  const out: Unsaved[] = [];
  for (const s of sessions) {
    if (s.archivedAt) continue;
    for (const p of s.paths) {
      if (!exists(p)) continue;
      const at = { session: `${s.target} · ${s.branch || '(its checkout)'}`, repo: s.isGroup ? path.basename(p) : s.target, path: p };
      const status = await run('git', ['status', '--porcelain'], p);
      const dirty = status.code === 0 ? status.stdout.split('\n').filter((l) => l.trim()).length : 0;
      if (dirty) out.push({ ...at, what: `${dirty} uncommitted file${dirty === 1 ? '' : 's'}` });
      const branch = (await run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], p)).stdout.trim();
      if (!branch || branch === 'HEAD') continue;
      const onOrigin = (await run('git', ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${branch}`], p)).code === 0;
      const against = onOrigin ? `origin/${branch}` : 'origin/HEAD';
      const ahead = Number((await run('git', ['rev-list', '--count', `${against}..HEAD`], p)).stdout.trim()) || 0;
      if (ahead)
        out.push({ ...at, what: `${ahead} commit${ahead === 1 ? '' : 's'} not pushed${onOrigin ? '' : ` (${branch} isn't on origin)`}` });
    }
  }
  return out;
}

// ---- export ------------------------------------------------------------------------

export interface ExportResult {
  dir: string;
  sessions: number;
  transcripts: number;
}

/** Write the bundle into `dest` (a new or empty folder). */
export function exportBundle(dest: string, now = new Date()): ExportResult {
  if (exists(dest) && fs.readdirSync(dest).length) throw new MoveError(`${dest} isn't empty: give a new folder`);
  const home = getConfigDir();
  const config = loadConfig();
  if (!config) throw new MoveError('nothing to move: work has no config here');
  fs.mkdirSync(dest, { recursive: true });
  snapshotDb(path.join(dest, 'state.db'));
  fs.copyFileSync(getConfigPath(), path.join(dest, 'config.json'));
  for (const dir of ['conversations', 'archive']) {
    if (exists(path.join(home, dir))) fs.cpSync(path.join(home, dir), path.join(dest, dir), { recursive: true });
  }
  for (const f of fs.readdirSync(home).filter((n) => n.endsWith('.claude.md'))) {
    fs.mkdirSync(path.join(dest, 'instructions'), { recursive: true });
    fs.copyFileSync(path.join(home, f), path.join(dest, 'instructions', f));
  }

  const history = loadHistory();
  let transcripts = 0;
  const sessions: MoveManifest['sessions'] = [];
  for (const s of history) {
    const id = sessionIdFor(s);
    // An archived session's conversation is in its archive already.
    const files = s.archivedAt ? [] : (agentOf(s).conversation?.files(s) ?? []);
    for (const f of files) {
      fs.mkdirSync(path.join(dest, 'transcripts', id), { recursive: true });
      fs.copyFileSync(f.file, path.join(dest, 'transcripts', id, path.basename(f.file)));
    }
    transcripts += files.length;
    sessions.push({ id, target: s.target, branch: s.branch, archived: !!s.archivedAt, transcripts: files.length });
  }
  const repos: MoveManifest['repos'] = {};
  for (const [alias, p] of Object.entries(config.repos)) {
    repos[alias] = { path: p, origin: originUrl(readGitConfig(p) ?? '') };
  }
  const manifest: MoveManifest = {
    version: BUNDLE_VERSION,
    exportedAt: now.toISOString(),
    from: { home: os.homedir(), platform: process.platform, worktreesRoot: config.worktreesRoot },
    repos,
    sessions,
  };
  fs.writeFileSync(path.join(dest, 'manifest.json'), JSON.stringify(manifest, null, 2));
  return { dir: dest, sessions: history.length, transcripts };
}

// ---- paths on the new computer (pure) ---------------------------------------------

export interface PathRule {
  from: string;
  to: string;
}

const norm = (p: string, caseless: boolean) => {
  const n = p.replace(/\\/g, '/').replace(/\/+$/, '');
  return caseless ? n.toLowerCase() : n;
};

/**
 * Where things go: the worktrees root and each repo to the folders given
 * (`--worktrees-root`, `--repos-root` + its folder name), else the same
 * place under the new home folder; anything else under the old home moves
 * with it. Longest first, so the most specific rule wins. Pure.
 */
export function remapRules(
  m: Pick<MoveManifest, 'from' | 'repos'>,
  opts: { reposRoot?: string; worktreesRoot?: string },
  newHome: string,
  join: (...parts: string[]) => string = path.join,
): PathRule[] {
  const caseless = m.from.platform === 'win32';
  const homeSwap = (p: string) => remapPath(p, [{ from: m.from.home, to: newHome }], caseless, join);
  const base = (p: string) =>
    p
      .replace(/[\\/]+$/, '')
      .split(/[\\/]/)
      .pop() ?? p;
  const rules: PathRule[] = [
    { from: m.from.worktreesRoot, to: opts.worktreesRoot ?? homeSwap(m.from.worktreesRoot) },
    ...Object.values(m.repos).map((r) => ({ from: r.path, to: opts.reposRoot ? join(opts.reposRoot, base(r.path)) : homeSwap(r.path) })),
    { from: m.from.home, to: newHome },
  ];
  return rules.sort((a, b) => b.from.length - a.from.length);
}

/** `p` under the first rule whose folder holds it, written for this computer; unchanged when none does. Pure. */
export function remapPath(p: string, rules: PathRule[], caseless: boolean, join: (...parts: string[]) => string = path.join): string {
  const key = norm(p, caseless);
  for (const r of rules) {
    const from = norm(r.from, caseless);
    if (key !== from && !key.startsWith(`${from}/`)) continue;
    const rest = p.replace(/\\/g, '/').slice(from.length).split('/').filter(Boolean);
    return rest.length ? join(r.to, ...rest) : r.to;
  }
  return p;
}

/** A session with its paths (and per-repo bases, keyed by path) moved. Pure. */
export function remapSession(s: WorktreeSession, move: (p: string) => string): WorktreeSession {
  const out: WorktreeSession = { ...s, paths: s.paths.map(move) };
  if (s.baseBranches) out.baseBranches = Object.fromEntries(Object.entries(s.baseBranches).map(([p, b]) => [move(p), b]));
  return out;
}

// ---- import ------------------------------------------------------------------------

/**
 * What holds the database open here and must stop before an import replaces
 * it: work web, the PTY host. A host that doesn't answer counts as running.
 */
export async function runningHere(): Promise<string[]> {
  const out: string[] = [];
  const url = readWebUrl();
  if (url && (await webServerResponds(url))) out.push('work web (`work web --stop`)');
  try {
    if (await findHost()) out.push('the PTY host (`work pty-host --stop`)');
  } catch {
    out.push('the PTY host (`work pty-host --stop`)');
  }
  return out;
}

export function readManifest(dir: string): MoveManifest {
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf-8'));
  } catch {
    throw new MoveError(`${dir} isn't a work bundle (no manifest.json): make one with \`work move export\``);
  }
  const m = raw as MoveManifest;
  if (!m || typeof m !== 'object' || typeof m.from?.home !== 'string' || typeof m.repos !== 'object')
    throw new MoveError(`${dir}/manifest.json isn't one work can read`);
  if (m.version > BUNDLE_VERSION) throw new MoveError(`this bundle is from a newer work (v${m.version}): update work first`);
  if (!exists(path.join(dir, 'state.db')) || !exists(path.join(dir, 'config.json')))
    throw new MoveError(`${dir} is missing state.db or config.json`);
  return m;
}

export interface ImportOptions {
  reposRoot?: string;
  worktreesRoot?: string;
  /** Clone repos that aren't on this computer, from their origin. */
  clone?: boolean;
  /** Replace what this computer has already. */
  force?: boolean;
}

export interface ImportReport {
  sessions: number;
  repos: { cloned: string[]; missing: string[] };
  worktrees: { created: string[]; failed: Array<{ session: string; error: string }> };
  transcripts: number;
}

export interface ImportDeps {
  run: CommandRunner;
  create: CreateWorktree;
  /** Where a session's agent looks for its conversations (null: it starts fresh). */
  restoreDir: (s: WorktreeSession) => string | null;
}

const defaultImportDeps = (): ImportDeps => ({
  run: defaultRunner,
  create: createInProcess,
  restoreDir: (s) => agentOf(s).conversation?.restoreDir?.(s) ?? null,
});

/** Bring a bundle in. The caller makes sure no work web or PTY host runs (they hold the database). */
export async function importBundle(dir: string, opts: ImportOptions = {}, deps: ImportDeps = defaultImportDeps()): Promise<ImportReport> {
  const m = readManifest(dir);
  if (!opts.force && exists(getConfigPath()) && loadHistory().length)
    throw new MoveError('work here has sessions already; importing replaces them (--force to do it anyway)');
  const caseless = m.from.platform === 'win32';
  const rules = remapRules(m, opts, os.homedir());
  const move = (p: string) => remapPath(p, rules, caseless);

  // config.json, as JSON: keys this version doesn't know come along.
  const raw = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf-8')) as Record<string, unknown>;
  if (typeof raw.worktreesRoot === 'string') raw.worktreesRoot = move(raw.worktreesRoot);
  if (raw.repos && typeof raw.repos === 'object')
    raw.repos = Object.fromEntries(
      Object.entries(raw.repos as Record<string, unknown>).map(([a, p]) => [a, typeof p === 'string' ? move(p) : p]),
    );
  for (const key of ['scanRoots', 'ignoredRepos'])
    if (Array.isArray(raw[key])) raw[key] = (raw[key] as unknown[]).map((p) => (typeof p === 'string' ? move(p) : p));
  fs.mkdirSync(getConfigDir(), { recursive: true });
  atomicWriteFile(getConfigPath(), JSON.stringify(raw, null, 2));

  // The database, then its sessions' paths. Its Claudes start when you open them here.
  replaceDb(path.join(dir, 'state.db'));
  const history = loadHistory().map((s) => remapSession(s, move));
  saveHistory(history);
  withDb((d) => d.prepare('DELETE FROM pty_sessions').run());

  // work's own files.
  for (const sub of ['conversations', 'archive'])
    if (exists(path.join(dir, sub))) fs.cpSync(path.join(dir, sub), path.join(getConfigDir(), sub), { recursive: true, force: false });
  if (exists(path.join(dir, 'instructions')))
    for (const f of fs.readdirSync(path.join(dir, 'instructions')))
      fs.copyFileSync(path.join(dir, 'instructions', f), path.join(getConfigDir(), f));

  const report: ImportReport = {
    sessions: history.length,
    repos: { cloned: [], missing: [] },
    worktrees: { created: [], failed: [] },
    transcripts: 0,
  };
  const config = loadConfig()!;
  for (const [alias, p] of Object.entries(config.repos)) {
    if (exists(p)) continue;
    const origin = m.repos[alias]?.origin;
    if (opts.clone && origin) {
      fs.mkdirSync(path.dirname(p), { recursive: true });
      const r = await deps.run('git', ['clone', origin, p], path.dirname(p));
      if (r.code === 0) {
        report.repos.cloned.push(alias);
        continue;
      }
    }
    report.repos.missing.push(alias);
  }

  // Live sessions get their worktrees back, from their branches on origin.
  const missing = new Set(report.repos.missing);
  for (const s of history) {
    if (s.archivedAt || !s.branch || s.paths.every(exists)) continue;
    const label = `${s.target} · ${s.branch}`;
    const repos = s.isGroup ? (config.groups[s.target] ?? []) : [s.target];
    if (repos.some((r) => missing.has(r))) {
      report.worktrees.failed.push({ session: label, error: `its repo isn't here (${repos.filter((r) => missing.has(r)).join(', ')})` });
      continue;
    }
    // A repo's own checkout (`work tree <repo>`) comes with the repo.
    if (!s.isGroup && config.repos[s.target] && s.paths[0] === config.repos[s.target]) continue;
    const r = await deps.create({ target: s.target, branch: s.branch }, config);
    if (r.ok) report.worktrees.created.push(label);
    else report.worktrees.failed.push({ session: label, error: r.error });
  }

  // Conversations back where the agent looks, so they resume.
  for (const s of loadHistory()) {
    const from = path.join(dir, 'transcripts', sessionIdFor(s));
    const to = exists(from) ? deps.restoreDir(s) : null;
    if (!to) continue;
    fs.mkdirSync(to, { recursive: true });
    for (const f of fs.readdirSync(from)) {
      if (exists(path.join(to, f))) continue;
      fs.copyFileSync(path.join(from, f), path.join(to, f));
      report.transcripts++;
    }
  }
  return report;
}
