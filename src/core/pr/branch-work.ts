import type { ElsewherePr, ShipPr, ShipPreflight } from '../api-types.js';

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
    // The session's listed PRs (session-prs.ts) no branch above found: one still open is its work too.
    for (const l of r.listedPrs ?? [])
      if (l.pr.state === 'OPEN') out.push(`${r.name}: PR #${l.pr.number} open${l.branch ? ` (${l.branch})` : ''}`);
  }
  for (const e of pre.elsewhere ?? []) if (e.pr.state === 'OPEN') out.push(`${e.repo}: PR #${e.pr.number} open`);
  for (const u of pre.unknownPrs ?? []) out.push(`${u} (its state unknown)`);
  return out;
}

/**
 * A repo's other branches' PRs, newest first (by number): what the stage picks the newest open one from. A
 * branch whose PR couldn't be read this time keeps none here — `workElsewhere` holds the archive meanwhile.
 */
export function otherPrsOf(r: Pick<ShipPreflight['repos'][number], 'otherBranches' | 'listedPrs'>): Array<{ branch: string; pr: ShipPr }> {
  const found = (r.otherBranches ?? []).filter((b): b is typeof b & { pr: ShipPr } => !!b.pr).map((b) => ({ branch: b.name, pr: b.pr }));
  // The listed ones (session-prs.ts) the branches didn't find.
  const listed = (r.listedPrs ?? []).filter((l) => !found.some((f) => f.pr.url === l.pr.url));
  return [...found, ...listed].sort((a, b) => b.pr.number - a.pr.number);
}

/** A repo outside the session that holds one of its listed PRs, read as a repo of the session's (`stageInputOf`). */
export interface ElsewhereRepo {
  name: string;
  host?: string;
  pr: ShipPr;
  branch?: string;
  otherPrs?: Array<{ branch: string; pr: ShipPr }>;
  done: boolean;
  elsewhere: true;
}

/**
 * The repos whose PRs a session's stage and PR tab read: its own, then each repo outside it that holds one of its
 * listed PRs (`SessionCi.elsewhere`, by the host's name for it), as a repo of its own — its newest PR first. Pure.
 */
export function stageInputOf<R extends { name: string }>(
  ci: { repos: R[]; elsewhere?: ReadonlyArray<ElsewherePr> } | null | undefined,
): Array<R | ElsewhereRepo> {
  if (!ci) return [];
  const outside = new Map<string, ElsewhereRepo>();
  for (const e of [...(ci.elsewhere ?? [])].sort((a, b) => b.pr.number - a.pr.number)) {
    const was = outside.get(e.repo);
    if (!was) {
      outside.set(e.repo, {
        name: e.repo,
        ...(e.host ? { host: e.host } : {}),
        pr: e.pr,
        ...(e.branch ? { branch: e.branch } : {}),
        done: e.pr.state !== 'OPEN',
        elsewhere: true,
      });
    } else (was.otherPrs ??= []).push({ branch: e.branch ?? '', pr: e.pr });
  }
  return [...ci.repos, ...outside.values()];
}
