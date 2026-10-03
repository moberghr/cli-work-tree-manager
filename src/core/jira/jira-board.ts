/**
 * The Jira board's columns in workflow order: to do, then in progress, then
 * review, then testing, then done — not in whichever order the most
 * recently updated issue happened to put them ("Review" came before "New").
 * By Jira's status category first, then by name within "in progress". Pure:
 * the SPA imports it.
 */

const CATEGORY_RANK: Record<string, number> = { new: 0, indeterminate: 1, done: 2 };

/** Within a category, by what the name says: open → doing → review → testing → the rest. */
function nameRank(status: string): number {
  const s = status.toLowerCase();
  if (/backlog|^new$|to ?do|open|selected|ready/.test(s)) return 0;
  if (/progress|doing|develop|implement|active/.test(s)) return 1;
  if (/review|pr\b|approval/.test(s)) return 2;
  if (/test|qa|verif|staging|uat/.test(s)) return 3;
  return 4;
}

export function columnOrder(columns: Array<{ status: string; category?: string }>): string[] {
  return [...columns]
    .map((c, i) => ({ ...c, i }))
    .sort((a, b) => {
      const ca = CATEGORY_RANK[a.category ?? ''] ?? (nameRank(a.status) === 0 ? 0 : 1);
      const cb = CATEGORY_RANK[b.category ?? ''] ?? (nameRank(b.status) === 0 ? 0 : 1);
      return ca - cb || nameRank(a.status) - nameRank(b.status) || a.i - b.i;
    })
    .map((c) => c.status);
}
