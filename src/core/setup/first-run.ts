import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getConfigDir, getConfigPath, loadConfig } from '../platform/config.js';
import { atomicWriteFile, withFileLock } from '../platform/fs-safe.js';
import { loadHistory } from '../sessions/history.js';
import { defaultRunner, type CommandRunner } from '../pr/ship.js';
import type { SetupWire, ToolCheck } from '../api-types.js';

/**
 * First run (the dashboard's Welcome page, `work init`): where your repos
 * are, where worktrees go, and whether the tools work leans on are there.
 * Nothing here is needed again once the folders are set and a repo is in.
 */

/** Files new worktrees get copied from the repo (local settings git ignores): `work init`'s defaults. */
export const DEFAULT_COPY_FILES = ['*.Development.json', '*.Local.json', '.claude/settings.local.json'];

/** Where repos usually live, most likely first. */
const REPO_FOLDERS = [['source', 'repos'], ['repos'], ['src'], ['code'], ['projects'], ['dev'], ['git'], ['work']];

/**
 * The folders to suggest: the first usual repos folder that exists under
 * home, and worktrees beside it (`…/source/repos` → `…/source/worktrees`).
 * With none, worktrees go under home and the repos folder is yours to name.
 */
export function suggestFolders(
  home: string,
  exists: (p: string) => boolean = fs.existsSync,
): { reposFolder: string | null; worktreesRoot: string } {
  for (const parts of REPO_FOLDERS) {
    const p = path.join(home, ...parts);
    if (exists(p)) return { reposFolder: p, worktreesRoot: path.join(path.dirname(p), 'worktrees') };
  }
  return { reposFolder: null, worktreesRoot: path.join(home, 'worktrees') };
}

/** What a folder entered for setup is wrong with, or null. */
export function folderProblem(p: unknown, mustExist: boolean): string | null {
  if (typeof p !== 'string' || !p.trim()) return 'give a folder';
  if (!path.isAbsolute(p.trim())) return `${p} isn't a full path (start it from the drive or /)`;
  if (mustExist && !fs.existsSync(p.trim())) return `${p} doesn't exist`;
  return null;
}

/**
 * Set the folders: config.json made when there is none (with `work init`'s
 * defaults), else its worktrees root and scanned folder changed in place,
 * every other key as it was.
 */
export async function saveFolders(req: { worktreesRoot: string; reposFolder: string }): Promise<void> {
  const wt = folderProblem(req.worktreesRoot, false);
  if (wt) throw new Error(`Worktrees folder: ${wt}`);
  const rf = folderProblem(req.reposFolder, true);
  if (rf) throw new Error(`Repos folder: ${rf}`);
  const worktreesRoot = path.resolve(req.worktreesRoot.trim());
  const reposFolder = path.resolve(req.reposFolder.trim());
  fs.mkdirSync(worktreesRoot, { recursive: true });
  getConfigDir();
  const file = getConfigPath();
  if (!fs.existsSync(file)) fs.writeFileSync(file, '{}', { flag: 'wx' });
  await withFileLock(file, () => {
    const raw = JSON.parse(fs.readFileSync(file, 'utf-8') || '{}') as Record<string, unknown>;
    raw.worktreesRoot = worktreesRoot;
    raw.scanRoots = [reposFolder];
    raw.repos ??= {};
    raw.groups ??= {};
    raw.copyFiles ??= DEFAULT_COPY_FILES;
    atomicWriteFile(file, JSON.stringify(raw, null, 2));
  });
}

/** One tool's check: its command, and what it means when it's missing. */
interface ToolSpec {
  id: ToolCheck['id'];
  label: string;
  needed: boolean;
  args: string[];
  cmd: string;
  missing: string;
  /** A failure that isn't "not installed" (gh logged out). */
  failing?: string;
}

const TOOLS: ToolSpec[] = [
  { id: 'git', label: 'git', needed: true, cmd: 'git', args: ['--version'], missing: 'Install git: worktrees are git’s.' },
  {
    id: 'claude',
    label: 'Claude Code',
    needed: true,
    cmd: 'claude',
    args: ['--version'],
    missing: 'Install Claude Code (npm install -g @anthropic-ai/claude-code) and sign in once in a terminal.',
  },
  {
    id: 'gh',
    label: 'GitHub CLI',
    needed: false,
    cmd: 'gh',
    args: ['auth', 'status'],
    missing: 'Optional: install gh to see your pull requests, CI and review comments.',
    failing: 'Optional: run `gh auth login` so work can see your pull requests.',
  },
  {
    id: 'acli',
    label: 'Atlassian CLI',
    needed: false,
    cmd: 'acli',
    args: ['--version'],
    missing: 'Optional: install acli to start sessions from your Jira issues.',
  },
];

/** Whether each tool answers. A command not found is "missing"; one that runs and fails says why. */
export async function checkTools(run: CommandRunner = defaultRunner): Promise<ToolCheck[]> {
  return Promise.all(
    TOOLS.map(async (t): Promise<ToolCheck> => {
      const r = await run(t.cmd, t.args, os.tmpdir()).catch(() => ({ code: 127, stdout: '', stderr: '' }));
      const ok = r.code === 0;
      const notFound = r.code === 127 || /not (found|recognized)|ENOENT/i.test(r.stderr);
      return {
        id: t.id,
        label: t.label,
        needed: t.needed,
        ok,
        detail: ok ? (r.stdout || r.stderr).split('\n')[0].trim() : notFound ? t.missing : (t.failing ?? t.missing),
      };
    }),
  );
}

/** Where setup stands: the folders, how many repos and sessions, the tools. */
export async function setupState(tools: () => Promise<ToolCheck[]> = () => checkTools()): Promise<SetupWire> {
  const config = loadConfig();
  const suggested = suggestFolders(os.homedir());
  const sessions = config ? loadHistory().filter((s) => !s.archivedAt).length : 0;
  return {
    configured: !!config && !!config.worktreesRoot,
    worktreesRoot: config?.worktreesRoot || null,
    reposFolder: config?.scanRoots?.[0] ?? (config?.worktreesRoot ? path.dirname(config.worktreesRoot) : null),
    repos: config ? Object.keys(config.repos).length : 0,
    sessions,
    suggested,
    tools: await tools(),
  };
}
