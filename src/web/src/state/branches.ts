import type { SessionBranchWire, SessionSummary } from '../api/client.js';

/**
 * A session's branches (session-branches.ts) as the dashboard shows them: the session header's Branches line,
 * the Diff picker's branch sections. Pure.
 */

/** What's known of a branch in a few words: "2 commits · not pushed", "PR #3592 merged". Null when nothing is.
 *  `withPr: false`: its PR left out (shown as a pill beside it). */
export function branchNote(b: SessionBranchWire | null, withPr = true): string | null {
  if (!b) return null;
  const bits: string[] = [];
  if (b.exists === false) bits.push('deleted');
  else {
    // Merged: none of its commits are its own any more, which says nothing of the work it held.
    if (typeof b.commits === 'number' && !(b.merged && b.commits === 0)) bits.push(`${b.commits} commit${b.commits === 1 ? '' : 's'}`);
    if (b.pushed === false) bits.push('not pushed');
    else if (b.unpushed) bits.push(`${b.unpushed} not pushed`);
  }
  if (b.pr && withPr) bits.push(`PR #${b.pr.number} ${b.pr.state === 'OPEN' ? 'open' : b.pr.state.toLowerCase()}`);
  else if (b.merged) bits.push('merged');
  return bits.length ? bits.join(' · ') : null;
}

/** It waits on you: work that isn't pushed, on a branch that still exists. */
export const branchUnpushed = (b: SessionBranchWire): boolean => b.exists !== false && (b.pushed === false || !!b.unpushed) && !b.merged;

/** The header's Branches line: shown when the session worked on more than one branch (the row carries them only then). */
export function headerBranches(s: Pick<SessionSummary, 'branches'>): SessionBranchWire[] {
  return s.branches ?? [];
}

/** A branch's label in the header: a group's names its repo. */
export const branchLabel = (b: SessionBranchWire, isGroup: boolean): string => (isGroup ? `${b.repo}: ${b.name}` : b.name);

/** The tooltip of a branch in the header. */
export function branchTitle(b: SessionBranchWire): string {
  const parts = [
    b.current ? 'Checked out now.' : `Last checked out ${new Date(b.lastSeen).toLocaleString()}.`,
    ...(b.from ? [`Made from ${b.from}.`] : []),
    ...(branchNote(b) ? [`${branchNote(b)}.`] : []),
    'Click to see its changes in the Diff tab.',
  ];
  return parts.join(' ');
}
