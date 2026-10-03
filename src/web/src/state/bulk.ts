/**
 * Doing one thing to several sessions (the Sessions table's bulk bar): each
 * through the same call as the one-session button, a few at a time, then one
 * line saying what happened — and for the ones refused, why. Pure apart from
 * the calls it is given.
 */

export interface BulkResult {
  id: string;
  ok: boolean;
  error?: string;
}

export async function runBulk(
  ids: string[],
  fn: (id: string) => Promise<unknown>,
  opts: { concurrency?: number; onProgress?: (done: number, total: number) => void } = {},
): Promise<BulkResult[]> {
  const results: BulkResult[] = new Array(ids.length);
  let next = 0;
  let done = 0;
  const worker = async () => {
    for (let i = next++; i < ids.length; i = next++) {
      try {
        await fn(ids[i]);
        results[i] = { id: ids[i], ok: true };
      } catch (err) {
        results[i] = { id: ids[i], ok: false, error: (err as Error).message };
      }
      opts.onProgress?.(++done, ids.length);
    }
  };
  await Promise.all(Array.from({ length: Math.min(opts.concurrency ?? 3, ids.length) }, worker));
  return results;
}

/** "Archived 4." / "Archived 3; 1 refused: fix/x — 1 uncommitted file." */
export function bulkSummary(verb: string, results: BulkResult[], labelOf: (id: string) => string): string {
  const ok = results.filter((r) => r.ok).length;
  const failed = results.filter((r) => !r.ok);
  if (failed.length === 0) return `${verb} ${ok}.`;
  const why = failed
    .slice(0, 3)
    .map((r) => `${labelOf(r.id)} — ${r.error ?? 'refused'}`)
    .join('; ');
  return `${verb} ${ok}; ${failed.length} refused: ${why}${failed.length > 3 ? ` (and ${failed.length - 3} more)` : ''}`;
}
