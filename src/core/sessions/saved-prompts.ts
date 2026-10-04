import type { SavedPrompt } from '../api-types.js';

export type { SavedPrompt } from '../api-types.js';

/**
 * One-click instructions for a session ("Prompts ▾" in its header). Sent
 * like a review comment, so they reach Claude the same safe way: pushed to
 * a terminal the dashboard owns, or on the session's next turn — never
 * typed over a permission prompt. Pure (the demo uses it too).
 *
 * `prompts` in config.json replaces these defaults; `repos` limits one to
 * those repo aliases / group names.
 */
export const DEFAULT_PROMPTS: SavedPrompt[] = [
  {
    label: 'Review your changes',
    prompt:
      'Review the changes on this branch as a strict reviewer would: bugs, missing edge cases, missing tests, leftovers (debug output, TODOs, dead code). Fix what you find, then tell me briefly what you changed.',
  },
  {
    label: 'Add tests',
    prompt:
      'Add tests for what changed on this branch, following the existing test patterns in this repo. Run them and fix anything that fails.',
  },
  {
    label: 'Run checks and fix',
    prompt:
      "Run this repo's type check, lint and tests (whatever it has). Fix what fails, and tell me if something is failing for a reason outside this change.",
  },
  {
    label: 'Commit',
    prompt: "Commit the current changes with a clear message in this repo's commit style. Don't push.",
  },
  {
    label: 'Open a pull request',
    prompt:
      'Push this branch and open a pull request for it with `gh pr create`. Write the title and description yourself from what we did in this conversation: what changed and why, how it was tested, anything a reviewer should look at first. Put the Jira key in the title if the branch or our conversation has one. Open it ready for review, not as a draft, and give me its link.',
  },
  {
    label: 'Rebase on the default branch',
    prompt:
      "Fetch, then rebase this branch on origin's default branch. Resolve conflicts keeping both sides' intent, run the tests, and tell me about any conflict you weren't sure of.",
  },
];

const MAX_PROMPT = 20_000;

/** The configured list, validated; undefined (use the defaults) when absent. */
export function validatePrompts(raw: unknown): SavedPrompt[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: SavedPrompt[] = [];
  for (const p of raw) {
    if (!p || typeof p !== 'object') continue;
    const { label, prompt, repos } = p as Record<string, unknown>;
    if (typeof label !== 'string' || !label.trim() || typeof prompt !== 'string' || !prompt.trim()) continue;
    const item: SavedPrompt = { label: label.trim(), prompt: prompt.trim().slice(0, MAX_PROMPT) };
    if (Array.isArray(repos)) {
      const names = repos.filter((r): r is string => typeof r === 'string' && r.length > 0);
      if (names.length) item.repos = names;
    }
    out.push(item);
  }
  return out;
}

/** The prompts that apply to a session: unscoped ones, and those naming
 *  its target (a repo alias or group name) or one of its repos. */
export function promptsForSession(prompts: SavedPrompt[], target: string, repoNames: string[] = []): SavedPrompt[] {
  const names = new Set([target, ...repoNames]);
  return prompts.filter((p) => !p.repos || p.repos.some((r) => names.has(r)));
}
