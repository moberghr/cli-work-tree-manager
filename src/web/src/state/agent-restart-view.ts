import type { AgentsWire, RestartWire } from '../../../core/api-types.js';
import type { SessionSummary } from '../api/client.js';
import { LATER_TEXT, restartCountsText } from '../../../core/pty/restart-view.js';

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** One outdated session, named as the rail names it, and whether it waits for its turn to end. */
export interface OutdatedName {
  id: string;
  name: string;
  /** Asked to restart, waiting for its turn (queued), or working / waiting on you (it will wait). */
  waits: boolean;
}

/**
 * Which sessions still run the old version, by name: your name for it, else its branch, with its project; the
 * Ctrl+K assistant as such; one the list doesn't know (gone meanwhile) by its id. Waiting ones last. Pure.
 */
export function outdatedNames(
  w: AgentsWire | null | undefined,
  sessions: ReadonlyArray<Pick<SessionSummary, 'id' | 'target' | 'branch' | 'title' | 'titleIsYours'>>,
): OutdatedName[] {
  if (!w) return [];
  const byId = new Map(sessions.map((s) => [s.id, s]));
  const queued = new Set(w.queued);
  const named = w.outdated.map((o): OutdatedName => {
    const s = byId.get(o.id);
    const name =
      o.id === 'assistant'
        ? 'the Ctrl+K assistant'
        : s
          ? `${s.titleIsYours && s.title ? s.title : s.branch || '(base)'} · ${s.target}`
          : o.id;
    return { id: o.id, name, waits: queued.has(o.id) || o.busy };
  });
  return [...named.filter((n) => !n.waits), ...named.filter((n) => n.waits)];
}

/** The tool's name as people know it (`claude` is Claude Code). */
export function toolName(tool: string): string {
  return tool === 'claude' ? 'Claude Code' : tool;
}

/** "Claude Code was updated: 3 sessions still run the old version", or null with none outdated. Pure. */
export function outdatedText(w: AgentsWire | null | undefined): string | null {
  const n = w?.outdated.length ?? 0;
  if (!w || n === 0) return null;
  const tools = [...new Set(w.outdated.map((o) => toolName(o.tool)))];
  const what = tools.length === 1 ? tools[0] : 'Your agents';
  return `${what} was updated: ${plural(n, 'session')} still ${n === 1 ? 'runs' : 'run'} the old version.`;
}

/**
 * The button: "Restart them" — and how many wait for their turn ("2 now, 1 after its turn"); null when every
 * outdated one is already asked to restart (it waits for its turn). Pure.
 */
export function restartLabel(w: AgentsWire): string | null {
  const asked = new Set(w.queued);
  const left = w.outdated.filter((o) => !asked.has(o.id));
  if (left.length === 0) return null;
  const later = left.filter((o) => o.busy).length;
  const now = left.length - later;
  if (later === 0) return left.length === 1 ? 'Restart it' : 'Restart them';
  if (now === 0) return later === 1 ? 'Restart it after its turn' : 'Restart them after their turns';
  return `Restart (${now} now, ${later} after ${later === 1 ? 'its turn' : 'their turns'})`;
}

/** "2 restart when their turns end": the ones asked that wait; null with none. Pure. */
export function queuedText(w: AgentsWire): string | null {
  const asked = new Set(w.queued);
  const n = w.outdated.filter((o) => asked.has(o.id)).length;
  return n === 0 ? null : `${n} ${n === 1 ? LATER_TEXT : 'restart when their turns end'}.`;
}

/** How a restart went, in a line. Pure. */
export function restartSummary(r: RestartWire): string {
  return restartCountsText({ restarted: r.now.length, later: r.later.length, failed: r.failed.length, firstError: r.failed[0]?.error });
}
