import type { ArchiveRecord } from './session-archive.js';

/**
 * The few sentences an archived session keeps on what was done and why —
 * what the Sessions list shows for it, and what archive search finds.
 * Written after archiving by an internal `claude -p` (no tools, neutral
 * cwd: the prompts are your text, but they are only material here).
 */

const MAX_PROMPT_CHARS = 600;
const MAX_INPUT_CHARS = 12_000;

/** The prompt for the summary, from what the archive kept (pure, for tests). */
export function summaryPrompt(rec: ArchiveRecord): string {
  const prompts = rec.summary.prompts
    .map((p) => `- ${p.text.replace(/\s+/g, ' ').slice(0, MAX_PROMPT_CHARS)}`)
    .join('\n')
    .slice(0, MAX_INPUT_CHARS);
  const prs = rec.summary.prs.map((p) => `#${p.number} (${p.repo}, ${p.state.toLowerCase()})`).join(', ');
  return [
    'Below is what a developer asked a coding assistant during one piece of work on a git branch, and how it ended.',
    'Write 2–4 plain sentences on what was done and why, for finding this work again months later:',
    'name the feature or bug, the main changes, and anything left open. No preamble, no lists, no markdown.',
    '',
    `Branch: ${rec.branch} (${rec.target})`,
    rec.summary.jiraKey ? `Jira: ${rec.summary.jiraKey}` : '',
    prs ? `Pull requests: ${prs}` : '',
    '',
    `The developer's requests (${rec.summary.promptCount} in all; first and latest shown):`,
    prompts || '(none kept)',
    '',
    rec.summary.lastSummary ? `How the last turn ended: ${rec.summary.lastSummary}` : '',
  ]
    .filter((l, i, all) => l !== '' || all[i - 1] !== '')
    .join('\n');
}

/** Ask `claude -p` (injectable) for the summary; null when it can't say. */
export async function summarizeArchive(rec: ArchiveRecord, ask: (prompt: string) => Promise<string | null>): Promise<string | null> {
  if (rec.summary.prompts.length === 0 && !rec.summary.lastSummary) return null;
  const out = (await ask(summaryPrompt(rec)))?.trim();
  if (!out) return null;
  // One paragraph, bounded: it is shown in a list row.
  return out.replace(/\s+/g, ' ').slice(0, 800);
}
