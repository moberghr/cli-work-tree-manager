import { tx, withDb } from './db.js';
import { cleanOrder } from './session-order.js';

/** The sessions list's manual order (session ids, top first), in state.db. */
const KEY = 'ui:session-order';

export function readSessionOrder(): string[] {
  return withDb((d) => {
    const row = d.prepare('SELECT value FROM meta WHERE key = ?').get(KEY) as { value: string } | undefined;
    if (!row) return [];
    let parsed: unknown;
    try {
      parsed = JSON.parse(row.value);
    } catch {
      return [];
    }
    return cleanOrder(parsed) ?? [];
  });
}

export function writeSessionOrder(order: string[]): void {
  tx((d) => {
    d.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(KEY, JSON.stringify(order));
  });
}
