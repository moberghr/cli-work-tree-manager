/**
 * What the Reviews tab remembers per browser (localStorage, best effort: a
 * blocked storage just forgets): whether the session rail is folded there,
 * which files of a review you've ticked viewed, and which of its comments
 * you've looked at. A review's marks are kept per head commit — a new push is
 * a new review to read.
 */

export type PrefStorage = Pick<Storage, 'getItem' | 'setItem'>;

const store = (): PrefStorage | null => {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
};

export const RAIL_FOLDED_KEY = 'work-web:reviews-rail-folded';

export function readRailFolded(s: PrefStorage | null = store()): boolean {
  try {
    return s?.getItem(RAIL_FOLDED_KEY) === '1';
  } catch {
    return false;
  }
}

export function writeRailFolded(folded: boolean, s: PrefStorage | null = store()): void {
  try {
    s?.setItem(RAIL_FOLDED_KEY, folded ? '1' : '0');
  } catch {
    /* per browser, best effort */
  }
}

/** The key of one review's set of marks: `viewed` files or `looked` comments, for its head. */
export const marksKey = (kind: 'viewed' | 'looked', r: { repo: string; number: number; headSha: string }) =>
  `work-web:review-${kind}:${r.repo}#${r.number}@${r.headSha}`;

export function readMarks(key: string, s: PrefStorage | null = store()): Set<string> {
  try {
    const v: unknown = JSON.parse(s?.getItem(key) ?? '[]');
    return new Set(Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
  } catch {
    return new Set();
  }
}

export function writeMarks(key: string, marks: ReadonlySet<string>, s: PrefStorage | null = store()): void {
  try {
    s?.setItem(key, JSON.stringify([...marks]));
  } catch {
    /* per browser, best effort */
  }
}

/** The set with `id` in or out. */
export function toggled(marks: ReadonlySet<string>, id: string, on: boolean): Set<string> {
  const next = new Set(marks);
  if (on) next.add(id);
  else next.delete(id);
  return next;
}
