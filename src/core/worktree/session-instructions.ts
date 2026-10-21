import fs from 'node:fs';
import path from 'node:path';
import { atomicWriteFile } from '../platform/fs-safe.js';

/**
 * A session folder's instructions file (CLAUDE.md, AGENTS.md…): it imports
 * each repo's own (`@<repo-folder>/CLAUDE.md`), so the agent started in the
 * folder reads every repo's instructions — no combined file written by an
 * internal run. The imports live in a block work owns; anything else in the
 * file is the user's and is kept as it is.
 */

export const BLOCK_START = '<!-- work:repos -->';
export const BLOCK_END = '<!-- /work:repos -->';
const HEADING = "This session's repos, each a folder here:";

/** The work-managed block for these imports (one `@<folder>/<file>` line each). */
function block(imports: string[]): string {
  return [BLOCK_START, HEADING, '', ...imports, BLOCK_END].join('\n');
}

/**
 * The file's text with its block set to these imports: replaced in place when
 * it has one, else appended (after a blank line) — the rest kept as it is.
 * Pure. `imports` are the lines as written (`@api/CLAUDE.md`).
 */
export function renderInstructions(existing: string, imports: string[]): string {
  const next = block(imports);
  const start = existing.indexOf(BLOCK_START);
  const end = start >= 0 ? existing.indexOf(BLOCK_END, start) : -1;
  if (start >= 0 && end >= 0) return existing.slice(0, start) + next + existing.slice(end + BLOCK_END.length);
  if (!existing.trim()) return `${next}\n`;
  return `${existing.replace(/\s*$/, '')}\n\n${next}\n`;
}

/** Whether a file has work's block (a session folder's import file, not a copied group summary). */
export function hasInstructionsBlock(file: string): boolean {
  try {
    return fs.readFileSync(file, 'utf8').includes(BLOCK_START);
  } catch {
    return false;
  }
}

/**
 * Write or update `<folder>/<fileName>`: one import per repo folder whose
 * worktree has that file. Returns the imports written.
 */
export function writeSessionInstructions(folder: string, repoFolders: string[], fileName: string): string[] {
  const imports = repoFolders
    .filter((repo) => fs.existsSync(path.join(folder, repo, fileName)))
    .map((repo) => `@${repo.replace(/\\/g, '/')}/${fileName}`);
  const file = path.join(folder, fileName);
  let existing = '';
  try {
    existing = fs.readFileSync(file, 'utf8');
  } catch {
    /* none yet: made */
  }
  const next = renderInstructions(existing, imports);
  if (next !== existing) atomicWriteFile(file, next);
  return imports;
}
