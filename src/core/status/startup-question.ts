/**
 * A question an agent asks before its first turn — Claude Code's "do you trust this folder?" (reported: a session
 * started with a prompt on a second account sat at it for an hour, and nothing said it was waiting). No hook runs
 * before a turn, so its terminal's screen is the only place it shows: the screens of agents that have had no turn
 * since they started are read (through the PTY host), each again only when it has printed since, and what the
 * agent's adapter recognises there (`input.startupQuestion`) becomes the session's status: needs you.
 *
 * Reads only: nothing is typed. Answering it is yours (it is the agent's own safety question).
 */

export interface StartupQuestion {
  /** What it asks, in a line. */
  what: string;
  /** When work first saw it (ISO). */
  since: string;
}

/** An agent's terminal in the PTY host, with when its session last had a turn recorded. */
export interface StartupTerminal {
  id: string;
  /** When its process started (ISO). */
  startedAt: string;
  /** When it last printed (ISO); absent: an older host, or nothing yet. */
  lastOutputAt?: string;
  /** When a hook last recorded anything for its session (ms; 0: never). */
  turnAt: number;
}

export function createStartupQuestions(deps: {
  /** The terminal's screen as text; null when it can't be read now. */
  screen: (id: string) => Promise<string | null>;
  /** What its agent recognises on that screen, or null. */
  question: (id: string, screen: string) => string | null;
  now?: () => Date;
}) {
  /** Per terminal: what its screen said when it last printed (`key`: its start and its last output). */
  const read = new Map<string, { key: string; found: StartupQuestion | null }>();
  return {
    /** The question a session's agent is stopped at, if any. */
    for: (id: string): StartupQuestion | null => read.get(id)?.found ?? null,
    /**
     * Look again. `changed`: some session's answer differs from before (its row needs a refresh); `asked`: the ones
     * newly found waiting (to say so once). A screen that can't be read is tried again next time.
     */
    async check(terminals: readonly StartupTerminal[]): Promise<{ changed: boolean; asked: string[] }> {
      let changed = false;
      const asked: string[] = [];
      const here = new Set(terminals.map((t) => t.id));
      for (const [id, was] of read)
        if (!here.has(id)) {
          read.delete(id);
          if (was.found) changed = true;
        }
      for (const t of terminals) {
        const was = read.get(t.id);
        // A turn since it started: it is past any question it had before one. Its screen is never read again.
        if (t.turnAt >= (Date.parse(t.startedAt) || 0)) {
          if (was?.found) changed = true;
          read.set(t.id, { key: 'turn', found: null });
          continue;
        }
        const key = `${t.startedAt}|${t.lastOutputAt ?? ''}`;
        if (was?.key === key) continue;
        const screen = await deps.screen(t.id).catch(() => null);
        if (screen === null) continue;
        const what = deps.question(t.id, screen);
        const found = what
          ? { what, since: was?.found?.what === what ? was.found.since : (deps.now?.() ?? new Date()).toISOString() }
          : null;
        if ((was?.found?.what ?? null) !== (found?.what ?? null)) {
          changed = true;
          if (found) asked.push(t.id);
        }
        read.set(t.id, { key, found });
      }
      return { changed, asked };
    },
  };
}
