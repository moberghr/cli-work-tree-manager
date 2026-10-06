import type { DiffSelection } from './diff-history.js';

/**
 * The Diff tab's small decisions, apart so they're tested: which repo tab is
 * shown, in what order, and what an empty diff says. Pure.
 */

interface RepoLike {
  name: string;
  files: readonly unknown[];
}

/**
 * The repo tab to show: the one you clicked while it's there; else the one on
 * screen while it has changes; else the first with changes (a group once
 * opened on `backend (0)` — "No changes in backend" — with the change in
 * frontend); else the first.
 */
export function preferredRepo(repos: readonly RepoLike[], current: string | null, picked: string | null): string | null {
  if (repos.length === 0) return current;
  if (picked && repos.some((r) => r.name === picked)) return picked;
  const cur = repos.find((r) => r.name === current);
  if (cur && cur.files.length > 0) return cur.name;
  return (repos.find((r) => r.files.length > 0) ?? cur ?? repos[0]).name;
}

/** Repos with changes first, in their own order; the rest after (shown dimmed). */
export function orderRepoTabs<T extends RepoLike>(repos: readonly T[]): T[] {
  return [...repos.filter((r) => r.files.length > 0), ...repos.filter((r) => r.files.length === 0)];
}

/** What an empty diff says, for what was asked. */
export function emptyDiffMessage(shown: DiffSelection, resolvedBase: string | undefined, label?: string): string {
  if (shown.kind === 'range') {
    if (label === 'Since you looked') return 'Nothing changed since you last looked.';
    if (label === 'Last turn') return 'The last turn changed no files.';
    return shown.fromKey === shown.toKey ? 'This changed no files.' : 'Nothing changed in this span.';
  }
  if (shown.base === 'uncommitted') return 'No uncommitted changes.';
  if (!resolvedBase || resolvedBase === 'HEAD') {
    return (
      "Couldn't find this branch's parent. Tried main, master, dev, develop (and their origin/* mirrors). " +
      'Record one with `work tree --base <ref>`.'
    );
  }
  return `No commits since \`${resolvedBase}\` — this branch is up to date or already merged.`;
}
