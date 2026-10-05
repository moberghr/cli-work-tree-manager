/** How far `-2`, `-3`… goes looking for a free name. */
const MAX_SUFFIX = 9;

/** The first name from `branch` that nothing has taken: `branch`, `branch-2`, … `branch-9`; null when none is free. Pure. */
export function firstFreeBranch(branch: string, taken: (name: string) => boolean): string | null {
  for (let n = 1; n <= MAX_SUFFIX; n++) {
    const name = n === 1 ? branch : `${branch}-${n}`;
    if (!taken(name)) return name;
  }
  return null;
}
