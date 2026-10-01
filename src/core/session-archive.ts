import fs from 'node:fs';
import { whileArchiving } from './archiving.js';
import path from 'node:path';
import zlib from 'node:zlib';
import { getConfigDir } from './config.js';
import { claudeProjectsRoot, encodeProjectDir } from './claude-activity.js';
import { promptsSince } from './digest.js';
import type { WorktreeSession } from './session-types.js';
import { sessionIdFor } from './session-id.js';
import { readTranscriptTail, type TranscriptEntry } from './transcript.js';

/**
 * Archiving a session: out of the way, its disk space back, its history kept.
 *
 *   0. unless forced, nothing is waiting in it: replies Claude drafted for
 *      you to post, notes not yet delivered to its Claude, a Claude mid-turn
 *      or waiting for your answer (`waiting`);
 *   1. its Claude and its dev server are stopped;
 *   2. its conversation (every transcript) is copied to
 *      ~/.work/archive/<id>/transcripts — Claude Code deletes old transcripts
 *      by itself, and this is what "recall what we did" reads;
 *   3. a summary is written next to it: your prompts, its PRs, how it ended,
 *      the branch tips — and, in the background, a few sentences on what was
 *      done and why (`writeArchiveSummary`, an internal `claude -p`);
 *   4. the worktree is removed — only when cleanup's own check says nothing
 *      would be lost (merged, clean) — and then its checkpoint refs go, and a
 *      branch already merged into the main branch is deleted (its tip is
 *      recorded; Restore recreates it). Otherwise the worktree stays, the
 *      reason is recorded, and its build output (node_modules, bin/obj, …)
 *      is cleared to give the disk back anyway;
 *   5. the session is marked archived.
 *
 * Restoring (`work tree` into it, or Restore in the dashboard) recreates the
 * branch if archiving deleted it, the worktree from the branch, and puts the
 * transcripts back where Claude looks for them, so it continues the
 * conversation. Old archives are compressed (archive-retention.ts).
 */

export interface ArchivedPr {
  repo: string;
  number: number;
  url: string;
  state: string;
}

export interface ArchiveRecord {
  sessionId: string;
  target: string;
  branch: string;
  isGroup: boolean;
  paths: string[];
  archivedAt: string;
  /** The worktree folder(s) were removed (false: kept, see keptBecause). */
  worktreeRemoved: boolean;
  keptBecause: string | null;
  /** Transcript file names under transcripts/, by the folder they belong to
   *  (on disk `<file>` or, once compressed, `<file>.gz`). */
  transcripts: Array<{ file: string; projectDir: string }>;
  summary: {
    prompts: Array<{ ts: string; text: string }>;
    promptCount: number;
    lastSummary: string | null;
    prs: ArchivedPr[];
    jiraKey: string | null;
    /** What was done and why, in a few sentences (written after archiving). */
    written?: string | null;
  };
  /** Each repo's branch tip when archived (repo alias → commit): of the branch checked out (`heads`), else the session's. */
  tips?: Record<string, string>;
  /** Repos checked out on another branch than the session's when archived (alias → branch): Restore brings that branch back. */
  heads?: Record<string, string>;
  /** Repos whose local branch was deleted (merged): Restore recreates it at its tip. */
  branchesDeleted?: string[];
  /** Build output cleared from a kept worktree. */
  buildFolders?: { folders: number; bytes: number };
  /** When the transcripts were compressed / deleted for retention (ISO). */
  compressedAt?: string;
  transcriptsDroppedAt?: string;
}

export interface ArchiveDeps {
  stopClaude: (id: string) => Promise<void>;
  /** Would removing its worktree lose anything? (cleanup's verdict) */
  removable: (s: WorktreeSession) => Promise<{ ok: boolean; reason: string }>;
  removeWorktree: (s: WorktreeSession) => Promise<boolean>;
  setArchived: (s: WorktreeSession) => Promise<boolean>;
  /** The session's transcript files. */
  transcripts: (s: WorktreeSession) => string[];
  prs?: (id: string) => ArchivedPr[];
  lastSummary?: (id: string) => string | null;
  /** What archiving now would leave behind unfinished (empty: nothing). */
  waiting?: (id: string) => string[];
  stopDev?: (id: string) => void;
  /** Repos checked out on another branch than the session's (alias → branch). */
  heads?: (s: WorktreeSession) => Record<string, string>;
  /** Each repo's branch tip (alias → commit): of `heads[alias]`, else the session's branch. */
  tips?: (s: WorktreeSession, heads: Record<string, string>) => Promise<Record<string, string>>;
  /** A kept worktree: clear its git-ignored build output. */
  clearBuildFolders?: (s: WorktreeSession) => Promise<{ folders: number; bytes: number }>;
  /** A removed worktree: its checkpoint refs, and merged local branches — the session's and the one checked out (returns the repos whose checked-out branch went). */
  tidy?: (s: WorktreeSession, heads: Record<string, string>) => Promise<string[]>;
  /** A few sentences on what was done (background; null: none). */
  summarize?: (rec: ArchiveRecord) => Promise<string | null>;
  archiveRoot?: string;
  now?: () => number;
}

export interface ArchiveOutcome {
  ok: boolean;
  worktreeRemoved: boolean;
  keptBecause: string | null;
  transcripts: number;
  message: string;
  /** Not archived: these were waiting (archive with force to go ahead). */
  blocked?: string[];
}

/** Most prompts kept in the summary: the first ones (what it was about) and the latest. */
const SUMMARY_PROMPTS = 40;

export const archiveRoot = (): string => path.join(getConfigDir(), 'archive');
export const archiveDirFor = (id: string, root = archiveRoot()): string => path.join(root, id);

export async function archiveSession(s: WorktreeSession, deps: ArchiveDeps, opts: { force?: boolean } = {}): Promise<ArchiveOutcome> {
  // Nothing starts its Claude again while this runs (archiving.ts).
  return whileArchiving(sessionIdFor(s), () => archiveSteps(s, deps, opts));
}

async function archiveSteps(s: WorktreeSession, deps: ArchiveDeps, opts: { force?: boolean }): Promise<ArchiveOutcome> {
  const id = sessionIdFor(s);
  const root = deps.archiveRoot ?? archiveRoot();
  const dir = archiveDirFor(id, root);
  const now = deps.now ?? Date.now;

  // 0. Work still waiting in it would vanish from view with it.
  const waiting = opts.force ? [] : (deps.waiting?.(id) ?? []);
  if (waiting.length) {
    return { ok: false, worktreeRemoved: false, keptBecause: null, transcripts: 0, blocked: waiting, message: `Not archived: ${waiting.join('; ')}.` };
  }

  await deps.stopClaude(id);
  try {
    deps.stopDev?.(id);
  } catch {
    /* not running */
  }
  // Which branch each repo is on: Claude may have switched from the session's.
  let heads: Record<string, string> = {};
  try {
    heads = deps.heads?.(s) ?? {};
  } catch {
    /* unreadable: the session's branch, as before */
  }
  const tips = (await deps.tips?.(s, heads).catch(() => ({}))) ?? {};

  // 2. The conversation. Copied before anything is removed; a copy that fails
  //    stops the archive (nothing removed, nothing marked).
  const copied: ArchiveRecord['transcripts'] = [];
  const entries: TranscriptEntry[][] = [];
  try {
    fs.mkdirSync(path.join(dir, 'transcripts'), { recursive: true });
    for (const file of deps.transcripts(s)) {
      const name = path.basename(file);
      fs.copyFileSync(file, path.join(dir, 'transcripts', name));
      copied.push({ file: name, projectDir: path.basename(path.dirname(file)) });
      entries.push(readTranscriptTail(file, 64 * 1024 * 1024));
    }
  } catch (err) {
    return { ok: false, worktreeRemoved: false, keptBecause: null, transcripts: copied.length, message: `Not archived: could not copy its conversation (${(err as Error).message}).` };
  }

  // 3–4. The folder goes only if nothing would be lost.
  const verdict = await deps.removable(s);
  let worktreeRemoved = false;
  let keptBecause: string | null = null;
  if (verdict.ok) {
    worktreeRemoved = await deps.removeWorktree(s);
    if (!worktreeRemoved) keptBecause = 'git refused to remove the worktree';
  } else {
    keptBecause = verdict.reason;
  }
  let branchesDeleted: string[] = [];
  let buildFolders: ArchiveRecord['buildFolders'];
  if (worktreeRemoved) branchesDeleted = (await deps.tidy?.(s, heads).catch(() => [])) ?? [];
  else if (keptBecause !== "it is the repo's own checkout" && deps.clearBuildFolders) {
    buildFolders = await deps.clearBuildFolders(s).catch(() => undefined);
  }

  const all = promptsSince(entries, 0);
  const prompts = all.length > SUMMARY_PROMPTS ? [...all.slice(0, SUMMARY_PROMPTS / 2), ...all.slice(-SUMMARY_PROMPTS / 2)] : all;
  const record: ArchiveRecord = {
    sessionId: id,
    target: s.target,
    branch: s.branch,
    isGroup: s.isGroup,
    paths: s.paths,
    archivedAt: new Date(now()).toISOString(),
    worktreeRemoved,
    keptBecause,
    transcripts: copied,
    summary: {
      prompts,
      promptCount: all.length,
      lastSummary: deps.lastSummary?.(id) ?? null,
      prs: deps.prs?.(id) ?? [],
      jiraKey: s.jiraKey ?? null,
    },
    ...(Object.keys(tips).length ? { tips } : {}),
    ...(Object.keys(heads).length ? { heads } : {}),
    ...(branchesDeleted.length ? { branchesDeleted } : {}),
    ...(buildFolders && buildFolders.folders ? { buildFolders } : {}),
  };
  fs.writeFileSync(path.join(dir, 'archive.json'), JSON.stringify(record, null, 2));

  await deps.setArchived(s);
  if (deps.summarize) void writeArchiveSummary(id, deps.summarize, root).catch(() => {});
  return {
    ok: true,
    worktreeRemoved,
    keptBecause,
    transcripts: copied.length,
    message: worktreeRemoved ? 'Archived; worktree removed, conversation kept' : `Archived; worktree kept (${keptBecause})`,
  };
}

/** Ask for the written summary and store it in the record (background, after archiving). */
export async function writeArchiveSummary(id: string, summarize: (rec: ArchiveRecord) => Promise<string | null>, root = archiveRoot()): Promise<string | null> {
  const rec = readArchive(id, root);
  if (!rec || rec.summary.written) return rec?.summary.written ?? null;
  const text = (await summarize(rec))?.trim() || null;
  if (!text) return null;
  const now = readArchive(id, root); // re-read: it may have changed meanwhile
  if (!now) return null;
  now.summary.written = text;
  writeArchiveRecord(now, root);
  return text;
}

export function writeArchiveRecord(rec: ArchiveRecord, root = archiveRoot()): void {
  const file = path.join(archiveDirFor(rec.sessionId, root), 'archive.json');
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(rec, null, 2));
  fs.renameSync(tmp, file);
}

/** An archived transcript's text, compressed or not (null: gone). */
export function readArchivedTranscript(id: string, file: string, root = archiveRoot()): string | null {
  const plain = path.join(archiveDirFor(id, root), 'transcripts', file);
  try {
    return fs.readFileSync(plain, 'utf8');
  } catch {
    /* compressed, or gone */
  }
  try {
    return zlib.gunzipSync(fs.readFileSync(`${plain}.gz`)).toString('utf8');
  } catch {
    return null;
  }
}

/** The archive record, or null (never archived with a copy, or unreadable). */
export function readArchive(id: string, root = archiveRoot()): ArchiveRecord | null {
  try {
    const raw: unknown = JSON.parse(fs.readFileSync(path.join(archiveDirFor(id, root), 'archive.json'), 'utf8'));
    return isArchiveRecord(raw) ? raw : null;
  } catch {
    return null;
  }
}

function isArchiveRecord(x: unknown): x is ArchiveRecord {
  const r = x as ArchiveRecord | null;
  return !!r && typeof r === 'object' && typeof r.sessionId === 'string' && typeof r.worktreeRemoved === 'boolean' && Array.isArray(r.transcripts) && !!r.summary && Array.isArray(r.summary.prompts);
}

/**
 * Put an archived conversation back where Claude looks for it (the project
 * folder of the session's worktree), so `--continue` picks it up. Files that
 * are already there are left alone. Returns how many were restored.
 */
export function restoreArchivedTranscripts(s: WorktreeSession, root = archiveRoot(), projectsRoot = claudeProjectsRoot()): number {
  const id = sessionIdFor(s);
  const rec = readArchive(id, root);
  if (!rec) return 0;
  // Where Claude runs for it: the worktree, or a group's root.
  const cwd = s.isGroup && s.paths[0] ? path.dirname(s.paths[0]) : s.paths[0];
  if (!cwd) return 0;
  const dest = path.join(projectsRoot, encodeProjectDir(cwd));
  let n = 0;
  for (const t of rec.transcripts) {
    const to = path.join(dest, t.file);
    if (fs.existsSync(to)) continue;
    const text = readArchivedTranscript(id, t.file, root);
    if (text === null) continue;
    fs.mkdirSync(dest, { recursive: true });
    fs.writeFileSync(to, text);
    n++;
  }
  return n;
}
