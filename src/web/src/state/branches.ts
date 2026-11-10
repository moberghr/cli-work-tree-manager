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
    // Merged: none of its commits are its own any more, which says nothing of the work it held. None of its own
    // and not merged: "no commits" — nothing there to push either (it read "0 commits · not pushed").
    const none = b.commits === 0 && !b.merged;
    if (none) bits.push('no commits');
    else if (typeof b.commits === 'number' && !(b.merged && b.commits === 0)) bits.push(`${b.commits} commit${b.commits === 1 ? '' : 's'}`);
    if (none) {
      /* nothing to push */
    } else if (b.pushed === false) bits.push('not pushed');
    else if (b.unpushed) bits.push(`${b.unpushed} not pushed`);
  }
  if (b.pr && withPr) bits.push(`PR #${b.pr.number} ${b.pr.state === 'OPEN' ? 'open' : b.pr.state.toLowerCase()}`);
  else if (b.merged) bits.push('merged');
  return bits.length ? bits.join(' · ') : null;
}

/** It waits on you: work that isn't pushed, on a branch that still exists. */
export const branchUnpushed = (b: SessionBranchWire): boolean =>
  b.exists !== false && ((b.pushed === false && b.commits !== 0) || !!b.unpushed) && !b.merged;

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

/**
 * The header's "3 branches ▾": how many branches the session worked on and whether any holds work not pushed (it
 * turns amber). Null with one branch: nothing to open. Pure.
 */
export function branchesChip(s: Pick<SessionSummary, 'branches'>): { count: number; unpushed: number } | null {
  const list = headerBranches(s);
  if (list.length < 2) return null;
  return { count: list.length, unpushed: list.filter(branchUnpushed).length };
}

/** One branch on the Branches tab: what's known of it, the turns taken on it, its commits (newest first). */
export interface BranchTabRow {
  branch: SessionBranchWire;
  /** The repo's folder name: what turns and commits name it by. */
  folder: string;
  note: string | null;
  turns: { first: number; last: number; count: number; from: string; to: string } | null;
  commits: Array<{ sha: string; subject: string; at: string }>;
}

/**
 * The Branches tab's rows, per repo in the session's order, each repo's checked-out branch first, then newest.
 * `entries` and `commits` are the Diff tab's history (`GET …/checkpoints`): a turn is on a branch when it recorded
 * that branch for the repo; the checked-out branch's commits are the unmarked ones, another's carry its name.
 * The record names a single repo by its alias, a group's by its folder: `folders` maps it. Pure.
 */
export function branchTabRows(
  s: Pick<SessionSummary, 'branches' | 'isGroup' | 'paths'>,
  entries: Array<{ id: number; ts: string; branches?: Record<string, string | null> }>,
  commits: Array<{ repo: string; sha: string; subject: string; at: string; branch?: string }>,
): Array<{ repo: string; rows: BranchTabRow[] }> {
  const folderOf = (repo: string) => (s.isGroup ? repo : lastPart(s.paths[0] ?? repo));
  const branchAtFolder = (b: Record<string, string | null> | undefined, folder: string): string | null => {
    if (!b) return null;
    if (folder in b) return b[folder] ?? null;
    const key = Object.keys(b).find((k) => lastPart(k) === folder);
    return key ? (b[key] ?? null) : null;
  };
  const sorted = [...entries].sort((a, b) => a.id - b.id);
  const byRepo = new Map<string, BranchTabRow[]>();
  for (const b of headerBranches(s)) {
    const folder = folderOf(b.repo);
    const on = sorted.filter((e) => e.id > 0 && branchAtFolder(e.branches, folder) === b.name);
    const mine = commits
      .filter((c) => c.repo === folder && (b.current ? !c.branch : c.branch === b.name))
      .map((c) => ({ sha: c.sha, subject: c.subject, at: c.at }));
    const row: BranchTabRow = {
      branch: b,
      folder,
      note: branchNote(b, false),
      turns: on.length ? { first: on[0].id, last: on[on.length - 1].id, count: on.length, from: on[0].ts, to: on[on.length - 1].ts } : null,
      commits: mine,
    };
    byRepo.set(b.repo, [...(byRepo.get(b.repo) ?? []), row]);
  }
  const order = (r: BranchTabRow) => (r.branch.current ? Number.MAX_SAFE_INTEGER : Date.parse(r.branch.lastSeen) || 0);
  const at = (repo: string) => {
    const i = s.paths.findIndex((p) => folderOf(repo) === lastPart(p));
    return i < 0 ? s.paths.length : i;
  };
  return [...byRepo].sort(([a], [b]) => at(a) - at(b)).map(([repo, rows]) => ({ repo, rows: rows.sort((a, b) => order(b) - order(a)) }));
}

/** A path's last part (a folder's name), Windows or POSIX: `C:\wt\api\` and `/wt/api` → `api`. */
function lastPart(p: string): string {
  return (
    p
      .split(/[\\/]+/)
      .filter(Boolean)
      .pop() ?? p
  );
}
