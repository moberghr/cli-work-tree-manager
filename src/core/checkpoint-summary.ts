/**
 * Lazy, cached one-line summaries of what changed at a checkpoint.
 *
 * The diff between checkpoint `id-1` and `id` is rendered to a compact text
 * blob and handed to `claude -p` for a terse label. The result is cached in
 * the manifest `label` (see `setCheckpointLabel`) so each checkpoint is only
 * summarised once. If Claude is unavailable or times out, a cheap heuristic
 * label ("3 files · +52 −8") is returned instead so the UI never blocks on
 * an external binary.
 */
import spawn from 'cross-spawn';
import path from 'node:path';
import { computeRangeDiff } from './diff-pipeline.js';
import { loadManifest } from './checkpoint.js';
import type { ParsedFile } from './diff-parse.js';

export interface SummaryRepo {
  /** Manifest key — the full repo path (see scope-routes `scopeRepos`). */
  name: string;
  root: string;
}

/** Cap on the diff text we feed Claude — keeps the prompt small and cheap. */
const MAX_DIFF_CHARS = 6000;
const MAX_LABEL_CHARS = 80;

/** Render the delta into checkpoint `id` as `{ files, added, deleted, text }`. */
function buildDelta(
  scopeHash: string,
  repos: SummaryRepo[],
  id: number,
): { files: ParsedFile[]; added: number; deleted: number; text: string } {
  const manifest = loadManifest(scopeHash);
  const entry = manifest.entries.find((e) => e.id === id);
  const prev = manifest.entries.find((e) => e.id === id - 1);
  const all: ParsedFile[] = [];
  for (const repo of repos) {
    const toRef = entry?.repos[repo.name];
    if (!toRef) continue;
    // Missing prev sha (fresh repo) → diff against the empty tree by passing
    // the well-known empty-tree object isn't available here cheaply; fall
    // back to HEAD which yields the same files for the common case.
    const fromRef = prev?.repos[repo.name] ?? 'HEAD';
    try {
      all.push(...computeRangeDiff({ root: repo.root, fromRef, toRef }));
    } catch {
      /* skip a repo that fails to diff */
    }
  }
  let added = 0;
  let deleted = 0;
  for (const f of all) {
    added += f.added;
    deleted += f.deleted;
  }
  // Compact patch text: file header lines + their changed lines, truncated.
  const parts: string[] = [];
  let budget = MAX_DIFF_CHARS;
  for (const f of all) {
    const head = `### ${f.status} ${f.path} (+${f.added} -${f.deleted})\n`;
    if (budget - head.length < 0) break;
    parts.push(head);
    budget -= head.length;
    for (const h of f.hunks) {
      for (const ln of h.lines) {
        if (ln.kind !== 'add' && ln.kind !== 'delete') continue;
        const prefix = ln.kind === 'add' ? '+' : '-';
        const line = `${prefix}${ln.content}\n`;
        if (budget - line.length < 0) {
          budget = -1;
          break;
        }
        parts.push(line);
        budget -= line.length;
      }
      if (budget < 0) break;
    }
    if (budget < 0) break;
  }
  return { files: all, added, deleted, text: parts.join('') };
}

/** Cheap fallback label when Claude can't be reached. */
function heuristicLabel(
  files: ParsedFile[],
  added: number,
  deleted: number,
): string {
  if (files.length === 0) return 'no changes';
  if (files.length === 1) {
    return `${path.basename(files[0].path)} +${added} −${deleted}`;
  }
  return `${files.length} files · +${added} −${deleted}`;
}

/** Run `claude -p` with the prompt on stdin; resolve its trimmed stdout, or
 *  null on error/timeout. Async (never blocks the server event loop). */
function runClaude(prompt: string, timeoutMs = 25_000): Promise<string | null> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (v: string | null) => {
      if (settled) return;
      settled = true;
      resolve(v);
    };
    let out = '';
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn('claude', ['-p'], {
        stdio: ['pipe', 'pipe', 'ignore'],
        windowsHide: true,
      });
    } catch {
      finish(null);
      return;
    }
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* already gone */
      }
      finish(null);
    }, timeoutMs);
    child.stdout?.on('data', (d: Buffer) => {
      out += d.toString();
    });
    child.on('error', () => {
      clearTimeout(timer);
      finish(null);
    });
    child.on('close', (code: number | null) => {
      clearTimeout(timer);
      finish(code === 0 && out.trim() ? out.trim() : null);
    });
    try {
      child.stdin?.write(prompt);
      child.stdin?.end();
    } catch {
      clearTimeout(timer);
      finish(null);
    }
  });
}

/** Normalise Claude's reply to a single terse line. */
function cleanLabel(raw: string): string {
  const firstLine = raw.split('\n').map((l) => l.trim()).find(Boolean) ?? '';
  // Strip surrounding quotes / trailing punctuation, collapse whitespace.
  const cleaned = firstLine
    .replace(/^["'`]+|["'`]+$/g, '')
    .replace(/\s+/g, ' ')
    .replace(/[.;]+$/, '')
    .trim();
  return cleaned.slice(0, MAX_LABEL_CHARS);
}

/**
 * Produce a one-line label for checkpoint `id`. Tries Claude; falls back to
 * a heuristic. Pure (no caching) — the caller persists the result.
 */
export async function summarizeCheckpoint(
  scopeHash: string,
  repos: SummaryRepo[],
  id: number,
): Promise<string> {
  const { files, added, deleted, text } = buildDelta(scopeHash, repos, id);
  if (files.length === 0) return 'no changes';
  const fallback = heuristicLabel(files, added, deleted);
  if (!text.trim()) return fallback;
  const prompt =
    'Summarise this code change in 8 words or fewer, imperative mood, ' +
    'no trailing punctuation. Output ONLY the summary line.\n\n' +
    text;
  const reply = await runClaude(prompt);
  if (!reply) return fallback;
  const label = cleanLabel(reply);
  return label || fallback;
}
