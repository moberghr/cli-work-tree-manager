/**
 * PURE — shared by the SPA, the demo and the server; keep it import-free.
 *
 * The order you gave the sessions list by dragging (stored in state.db,
 * session-order-store.ts). Sessions you haven't placed — a new worktree —
 * come first, in their usual order: they're what you're starting on.
 */

/** `list` in your order: unplaced first (as given), then by position. */
export function applyManualOrder<T extends { id: string }>(list: readonly T[], order: readonly string[]): T[] {
  if (order.length === 0) return [...list];
  const pos = new Map(order.map((id, i) => [id, i]));
  const unplaced = list.filter((s) => !pos.has(s.id));
  const placed = list.filter((s) => pos.has(s.id)).sort((a, b) => pos.get(a.id)! - pos.get(b.id)!);
  return [...unplaced, ...placed];
}

/**
 * The new order after dragging `id` in front of `beforeId` (null: to the
 * end) in the list as shown (`shown` ids, top to bottom). Everything shown
 * becomes placed where it now is; ids placed earlier but not shown (older
 * sessions, archived ones) keep their places after them.
 */
export function moveSession(shown: readonly string[], id: string, beforeId: string | null, previous: readonly string[]): string[] {
  if (id === beforeId) return [...shown, ...previous.filter((x) => !shown.includes(x))];
  const seq = shown.filter((x) => x !== id);
  const at = beforeId === null ? -1 : seq.indexOf(beforeId);
  seq.splice(at === -1 ? seq.length : at, 0, id);
  const inSeq = new Set(seq);
  return [...seq, ...previous.filter((x) => !inSeq.has(x))];
}

/** Keep an order sane before storing it: strings, no duplicates, bounded. */
export function cleanOrder(raw: unknown, max = 2000): string[] | null {
  if (!Array.isArray(raw)) return null;
  const seen = new Set<string>();
  for (const x of raw) {
    if (typeof x !== 'string' || !x || x.length > 200) return null;
    seen.add(x);
    if (seen.size >= max) break;
  }
  return [...seen];
}
