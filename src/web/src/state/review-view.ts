import type { PrReviewWire, ReviewSummaryWire } from '../../../core/api-types.js';
import type { Story } from '../../../core/review/review-plan.js';
import { FOLDED_KINDS, KIND_LABEL, KIND_ORDER, type ChangeKind } from '../../../core/review/change-kinds.js';

/**
 * PURE — how the Reviews tab lays a review out (#64): the tree on the left
 * and the diff on the right in one order, the review's rather than the
 * alphabet's — the stories first, riskiest first, each with the test files
 * that cover it right under its code; then every other file by kind, the
 * generated and mechanical ones folded. And the list of reviews, by repo.
 */

export interface ReviewEntry {
  path: string;
  added: number;
  deleted: number;
  /** Why it's where it is: the rule that put it in its kind, or "covers …" for a story's test. */
  why: string;
  role: 'code' | 'test';
}

export interface ReviewSection {
  key: string;
  label: string;
  /** A story (its reasoning shown above its files), or a kind of change. */
  story?: Story;
  kind?: ChangeKind;
  folded: boolean;
  entries: ReviewEntry[];
}

/** The review's sections in reading order; every file in exactly one. */
export function reviewSections(r: PrReviewWire): ReviewSection[] {
  const byPath = new Map(r.files.map((f) => [f.path, f]));
  const placed = new Set<string>();
  const entry = (path: string, role: ReviewEntry['role'], why?: string): ReviewEntry | null => {
    const f = byPath.get(path);
    if (!f || placed.has(path)) return null;
    placed.add(path);
    return { path, added: f.added, deleted: f.deleted, why: why ?? f.why, role };
  };
  const sections: ReviewSection[] = r.stories.map((s, i) => {
    const code = s.files.map((p) => entry(p, 'code')).filter((e): e is ReviewEntry => !!e);
    // Its tests next to its code: the PR's test files that cover any of its files.
    const tests = Object.entries(r.tests.covers)
      .filter(([, covered]) => covered.some((p) => s.files.includes(p)))
      .map(([t, covered]) =>
        entry(
          t,
          'test',
          `tests ${covered
            .filter((p) => s.files.includes(p))
            .map(baseName)
            .join(', ')}`,
        ),
      )
      .filter((e): e is ReviewEntry => !!e);
    return { key: `story-${i}`, label: s.title, story: s, folded: false, entries: [...code, ...tests] };
  });
  for (const kind of KIND_ORDER) {
    const entries = r.files
      .filter((f) => f.kind === kind)
      .map((f) => entry(f.path, kind === 'tests' ? 'test' : 'code'))
      .filter((e): e is ReviewEntry => !!e);
    if (entries.length) sections.push({ key: `kind-${kind}`, label: KIND_LABEL[kind], kind, folded: FOLDED_KINDS.has(kind), entries });
  }
  return sections;
}

const baseName = (p: string) => p.split('/').pop() ?? p;

/** The reviews by repo (the newest push first within each, repos by their newest), or as one list. */
export function groupReviews(
  list: ReviewSummaryWire[],
  by: 'repo' | 'none',
): Array<{ repo: string | null; host?: string; reviews: ReviewSummaryWire[] }> {
  const sorted = [...list].sort((a, b) => b.at.localeCompare(a.at));
  if (by === 'none') return [{ repo: null, reviews: sorted }];
  const groups = new Map<string, ReviewSummaryWire[]>();
  for (const r of sorted) groups.set(r.repo, [...(groups.get(r.repo) ?? []), r]);
  return [...groups].map(([repo, reviews]) => ({ repo, ...(reviews[0].host ? { host: reviews[0].host } : {}), reviews }));
}

/** The drafts that would go out with the review (not posted yet). */
export const pendingDrafts = (r: PrReviewWire) => r.drafts.filter((d) => d.state === 'draft');

/**
 * Why Fix it myself can't be offered now (null: it can) — the button disabled with this as its reason. The server
 * checks the same (`fixRefusal`): a fork's branch isn't on origin; a submit in doubt or under way speaks for the
 * drafts; nothing to take off.
 */
export function fixMyselfBlocked(r: PrReviewWire): string | null {
  if (r.fork) return "It comes from a fork: its branch isn't on origin, so a session couldn't push to it";
  if (r.inDoubt) return 'The last submit may have gone out: say whether it went first';
  if (r.submitting) return 'This review is being submitted';
  if (!pendingDrafts(r).length) return 'No draft comments to fix';
  return null;
}

/** "3 comments being fixed in feat/x" — each batch Fix it myself took off, named by its session (`nameOf`) or branch. */
export function fixingLines(r: PrReviewWire, nameOf: (id: string) => string | null): Array<{ sessionId: string; text: string }> {
  return (r.fixingMyself ?? []).map((f) => ({
    sessionId: f.sessionId,
    text: `${f.comments.length} comment${f.comments.length === 1 ? '' : 's'} being fixed in ${nameOf(f.sessionId) ?? f.branch}`,
  }));
}
