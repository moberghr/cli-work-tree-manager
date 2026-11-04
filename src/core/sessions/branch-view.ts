import type { SessionBranchWire } from '../api-types.js';

/**
 * A session's branches (session-branches.ts) in words, for `work sessions`, `work status` and the Ctrl+K
 * assistant's description. Pure, import-free but for types.
 */

/** One branch in a word or two: "fix/x (current, 1 commit, not pushed)", "feat/y (PR #12 merged)". */
export function branchLine(b: SessionBranchWire): string {
  const bits = [
    ...(b.current ? ['current'] : []),
    ...(b.exists === false ? ['deleted'] : []),
    ...(typeof b.commits === 'number' && b.exists !== false ? [`${b.commits} commit${b.commits === 1 ? '' : 's'}`] : []),
    ...(b.exists !== false && b.pushed === false ? ['not pushed'] : b.unpushed ? [`${b.unpushed} unpushed`] : []),
    ...(b.pr ? [`PR #${b.pr.number} ${b.pr.state.toLowerCase()}`] : b.merged ? ['merged'] : []),
  ];
  return `${b.name}${bits.length ? ` (${bits.join(', ')})` : ''}`;
}

/** Every branch, repo by repo for a group: "branches: fix/x (current, …) · feat/y (PR #12 merged)". */
export function branchesText(branches: SessionBranchWire[], isGroup: boolean): string {
  return branches.map((b) => `${isGroup ? `${b.repo}: ` : ''}${branchLine(b)}`).join(' · ');
}

/** Another branch in Ship's dialog: "fix/y — 2 commits, not pushed · PR #14 open". */
export function otherBranchFact(b: {
  name: string;
  exists: boolean;
  pushed: boolean;
  commits: number | null;
  unpushed: number | null;
  merged: boolean;
  pr: { number: number; state: string } | null;
  ghError?: string;
}): string {
  const bits: string[] = [];
  if (!b.exists) bits.push('deleted');
  else {
    if (typeof b.commits === 'number') bits.push(`${b.commits} commit${b.commits === 1 ? '' : 's'}`);
    if (!b.pushed) bits.push('not pushed');
    else if (b.unpushed) bits.push(`${b.unpushed} unpushed`);
  }
  if (b.pr) bits.push(`PR #${b.pr.number} ${b.pr.state.toLowerCase()}`);
  else if (b.merged) bits.push('merged');
  if (b.ghError) bits.push(`its PR unknown: ${b.ghError}`);
  return `${b.name}${bits.length ? ` — ${bits.join(', ')}` : ''}`;
}
