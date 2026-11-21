/**
 * Which PR reviews you have opened since they were last prepared — the Reviews list's "new" mark (asked for: after
 * Prepare again nothing said it was done). Per browser, in localStorage: a review is known by its repo and number,
 * and seen as of the time it became ready (`at`); prepared again, it is new again. The first time there is nothing
 * stored, every review there is counts as seen, so the mark never starts on a dozen old reviews.
 */

export const SEEN_KEY = 'wd:reviews-seen';

/** Seen reviews: `repo#number` → the `at` it had when you opened it. */
export type ReviewsSeen = Record<string, string>;

const keyOf = (r: { repo: string; number: number }) => `${r.repo}#${r.number}`;

/** The reviews that are ready and not opened since they became so. Pure. */
export function newReviews<T extends { repo: string; number: number; status: string; at: string }>(
  list: readonly T[],
  seen: ReviewsSeen,
): Set<string> {
  return new Set(list.filter((r) => r.status === 'ready' && seen[keyOf(r)] !== r.at).map(keyOf));
}

/** Whether this review carries the mark. Pure. */
export const isNewReview = (marks: ReadonlySet<string>, r: { repo: string; number: number }): boolean => marks.has(keyOf(r));

/** Seen as of now: this review, at the time it has. Pure. */
export function markSeen(seen: ReviewsSeen, r: { repo: string; number: number; at: string }): ReviewsSeen {
  return seen[keyOf(r)] === r.at ? seen : { ...seen, [keyOf(r)]: r.at };
}

/** Every review there is, seen as it is (the first time: nothing to mark yet). Pure. */
export function seedSeen(list: ReadonlyArray<{ repo: string; number: number; at: string }>): ReviewsSeen {
  return Object.fromEntries(list.map((r) => [keyOf(r), r.at]));
}

/** What this browser has stored; null when nothing (the first time) or it can't be read. */
export function readSeen(storage: Pick<Storage, 'getItem'> | null = safeStorage()): ReviewsSeen | null {
  try {
    const raw = storage?.getItem(SEEN_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as unknown;
    if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
    return Object.fromEntries(Object.entries(v as Record<string, unknown>).filter((e): e is [string, string] => typeof e[1] === 'string'));
  } catch {
    return null;
  }
}

/** Keep it (best effort: a browser that won't store just shows the mark again). */
export function writeSeen(seen: ReviewsSeen, storage: Pick<Storage, 'setItem'> | null = safeStorage()): void {
  try {
    storage?.setItem(SEEN_KEY, JSON.stringify(seen));
  } catch {
    /* per browser, best effort */
  }
}

function safeStorage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}
