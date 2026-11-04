import type { ShipPr, ShipPreflight } from '../api-types.js';

/**
 * A session's other branches (session-branches.ts) in Ship's and the PR watch's decisions. Pure and
 * import-free but for types: the PR watch is pure policy, and the demo imports it.
 */

/**
 * Work on a session's other branches that isn't finished (session-branches.ts): commits not pushed, a PR still
 * open, or one the host couldn't tell of. A session with any is never done — not archived by Ship's merge nor by
 * the PR watch — however its checked-out branch stands. Pure.
 */
export function workElsewhere(pre: ShipPreflight): string[] {
  const out: string[] = [];
  for (const r of pre.repos) {
    for (const b of r.otherBranches ?? []) {
      const parts: string[] = [];
      // Its PR merged at its tip: nothing on it is left behind, whether origin still has the branch or not.
      const mergedAtTip = b.pr?.state === 'MERGED' && !!b.sha && b.pr.headSha === b.sha;
      if (!mergedAtTip) {
        if (b.exists && b.unpushed === null && !b.merged) parts.push('its commits unknown');
        if (b.exists && b.unpushed && b.unpushed > 0) parts.push(`${b.unpushed} commit${b.unpushed === 1 ? '' : 's'} not pushed`);
      }
      if (b.pr?.state === 'OPEN') parts.push(`PR #${b.pr.number} open`);
      if (b.ghError && b.pushed) parts.push(`its PR unknown (${b.ghError})`);
      if (parts.length) out.push(`${r.name}: ${b.name} — ${parts.join(', ')}`);
    }
  }
  return out;
}

/**
 * A repo's other branches' PRs, newest first (by number): what the stage picks the newest open one from. A
 * branch whose PR couldn't be read this time keeps none here — `workElsewhere` holds the archive meanwhile.
 */
export function otherPrsOf(r: Pick<ShipPreflight['repos'][number], 'otherBranches'>): Array<{ branch: string; pr: ShipPr }> {
  return (r.otherBranches ?? [])
    .filter((b): b is typeof b & { pr: ShipPr } => !!b.pr)
    .map((b) => ({ branch: b.name, pr: b.pr }))
    .sort((a, b) => b.pr.number - a.pr.number);
}
