import type { SessionSummary } from '../api/client.js';
import { lastActiveAt, sessionMatches } from './session-display.js';

/**
 * What the Ctrl+P switcher lists. Nothing typed: the sessions you used
 * last. Typed: every session the rail's search would find (branch, repo,
 * folder, name, summary, Jira key…), the ones whose name or branch starts
 * with it first, archived ones last. Pure.
 */

const RECENT = 12;
const MAX = 30;

/** Your name for it when you gave one, else its branch. */
export const switcherLabel = (s: SessionSummary): string => (s.titleIsYours && s.title ? s.title : s.branch || s.target);

export function switcherResults(sessions: SessionSummary[], query: string): SessionSummary[] {
  const q = query.trim().toLowerCase();
  const recent = (a: SessionSummary, b: SessionSummary) => lastActiveAt(b).localeCompare(lastActiveAt(a));
  if (!q) return sessions.filter((s) => !s.archivedAt).sort(recent).slice(0, RECENT);
  const rank = (s: SessionSummary) => {
    const names = [switcherLabel(s), s.branch, s.title ?? ''].map((n) => n.toLowerCase());
    if (names.some((n) => n === q)) return 0;
    if (names.some((n) => n.startsWith(q) || n.split(/[/\-_ ]/).some((part) => part.startsWith(q)))) return 1;
    return 2;
  };
  return sessions
    .filter((s) => sessionMatches(s, q))
    .sort((a, b) => Number(!!a.archivedAt) - Number(!!b.archivedAt) || rank(a) - rank(b) || recent(a, b))
    .slice(0, MAX);
}
