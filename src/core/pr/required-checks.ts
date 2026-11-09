import type { ShipPr, ShipPreflight } from '../api-types.js';

/**
 * Which failed checks count — what makes a PR's checks red, brings it to the Inbox and is asked of Claude. The host's
 * own list wins (GitHub's required checks, Azure DevOps' blocking policies: the adapter applies it,
 * `ShipPr.checksRequiredByHost`). A repo whose host requires none may have its list in config
 * (`prWatch.requiredChecks`, by alias or the host's `owner/name`): a failed check not on it is set apart as
 * `optionalFailing` — shown grey as "not required", never asked of Claude. With neither, every check counts. Pure.
 */

/** The configured list for a repo: by its alias, else by the host's name for it (case-blind); null with none. */
export function requiredChecksFor(lists: Record<string, string[]> | undefined, ...names: Array<string | undefined>): string[] | null {
  if (!lists) return null;
  for (const n of names) {
    if (!n) continue;
    const hit = Object.entries(lists).find(([k]) => k.toLowerCase() === n.toLowerCase());
    if (hit) return hit[1];
  }
  return null;
}

/** The PR with only the listed checks counting (none listed, or the host said: unchanged — the same object). */
export function countedChecks(pr: ShipPr, required: readonly string[] | null): ShipPr {
  if (!required || pr.checksRequiredByHost || pr.checks !== 'fail') return pr;
  const want = new Set(required.map((n) => n.toLowerCase()));
  const failing = pr.failing ?? [];
  const counted = failing.filter((f) => want.has(f.name.toLowerCase()));
  const optional = failing.filter((f) => !want.has(f.name.toLowerCase()));
  if (!optional.length) return pr;
  const { failing: _f, ...rest } = pr;
  return {
    ...rest,
    // Only failures were listed: with none of the counted ones failing, the rest passed or are still running —
    // read as passing (a running one shows again as running once it fails or the host says so).
    checks: counted.length ? 'fail' : 'pass',
    ...(counted.length ? { failing: counted } : {}),
    optionalFailing: [...(pr.optionalFailing ?? []), ...optional],
  };
}

/** Every PR of a preflight through `countedChecks`, each with its repo's list. Unchanged when no list applies. Pure. */
export function withRequiredChecks(
  pre: ShipPreflight,
  lists: Record<string, string[]> | undefined,
  repoIdOf: (repoName: string) => string | null = () => null,
): ShipPreflight {
  if (!lists || !Object.keys(lists).length) return pre;
  return {
    ...pre,
    repos: pre.repos.map((r) => {
      const req = requiredChecksFor(lists, r.name, repoIdOf(r.name) ?? undefined);
      if (!req) return r;
      return {
        ...r,
        pr: r.pr ? countedChecks(r.pr, req) : null,
        ...(r.otherBranches ? { otherBranches: r.otherBranches.map((b) => (b.pr ? { ...b, pr: countedChecks(b.pr, req) } : b)) } : {}),
        ...(r.listedPrs ? { listedPrs: r.listedPrs.map((l) => ({ ...l, pr: countedChecks(l.pr, req) })) } : {}),
      };
    }),
    ...(pre.elsewhere
      ? { elsewhere: pre.elsewhere.map((e) => ({ ...e, pr: countedChecks(e.pr, requiredChecksFor(lists, e.repo)) })) }
      : {}),
  };
}
