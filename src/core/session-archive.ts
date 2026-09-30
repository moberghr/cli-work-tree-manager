import fs from 'node:fs';
import path from 'node:path';
import { getConfigDir } from './config.js';
import { claudeProjectsRoot, encodeProjectDir } from './claude-activity.js';
import { promptsSince } from './digest.js';
import type { WorktreeSession } from './session-types.js';
import { sessionIdFor } from './session-id.js';
import { readTranscriptTail, type TranscriptEntry } from './transcript.js';

/**
 * Archiving a session: out of the way, its disk space back, its history kept.
 *
 *   1. its Claude is stopped;
 *   2. its conversation (every transcript) is copied to
 *      ~/.work/archive/<id>/transcripts — Claude Code deletes old transcripts
 *      by itself, and this is what "recall what we did" reads;
 *   3. a summary is written next to it: your prompts, the turns, its PRs, how
 *      it ended;
 *   4. the worktree is removed — only when cleanup's own check says nothing
 *      would be lost (merged, clean); otherwise it stays, and the reason is
 *      recorded. The branch is always kept;
 *   5. the session is marked archived.
 *
 * Restoring (`work tree` into it, or Restore in the dashboard) recreates the
 * worktree from the branch and puts the transcripts back where Claude looks
 * for them, so it continues the conversation.
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
  /** Transcript file names under transcripts/, by the folder they belong to. */
  transcripts: Array<{ file: string; projectDir: string }>;
  summary: {
    prompts: Array<{ ts: string; text: string }>;
    promptCount: number;
    lastSummary: string | null;
    prs: ArchivedPr[];
    jiraKey: string | null;
  };
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
  archiveRoot?: string;
  now?: () => number;
}

export interface ArchiveOutcome {
  ok: boolean;
  worktreeRemoved: boolean;
  keptBecause: string | null;
  transcripts: number;
  message: string;
}

/** Most prompts kept in the summary: the first ones (what it was about) and the latest. */
const SUMMARY_PROMPTS = 40;

export const archiveRoot = (): string => path.join(getConfigDir(), 'archive');
export const archiveDirFor = (id: string, root = archiveRoot()): string => path.join(root, id);

export async function archiveSession(s: WorktreeSession, deps: ArchiveDeps): Promise<ArchiveOutcome> {
  const id = sessionIdFor(s);
  const root = deps.archiveRoot ?? archiveRoot();
  const dir = archiveDirFor(id, root);
  const now = deps.now ?? Date.now;

  await deps.stopClaude(id);

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
  };
  fs.writeFileSync(path.join(dir, 'archive.json'), JSON.stringify(record, null, 2));

  await deps.setArchived(s);
  return {
    ok: true,
    worktreeRemoved,
    keptBecause,
    transcripts: copied.length,
    message: worktreeRemoved ? 'Archived; worktree removed, conversation kept' : `Archived; worktree kept (${keptBecause})`,
  };
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
    const from = path.join(archiveDirFor(id, root), 'transcripts', t.file);
    const to = path.join(dest, t.file);
    if (fs.existsSync(to) || !fs.existsSync(from)) continue;
    fs.mkdirSync(dest, { recursive: true });
    fs.copyFileSync(from, to);
    n++;
  }
  return n;
}
