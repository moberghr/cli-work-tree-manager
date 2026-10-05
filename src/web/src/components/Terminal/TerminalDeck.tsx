import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { PtyView } from './LazyPtyView.js';
import type { SessionSummary } from '../../api/client.js';

/** How many terminals stay connected in the background. Each holds a
 *  WebGL context (browsers allow ~16) and a socket. */
export const DECK_SIZE = 5;

interface Props {
  /** The session whose Terminal tab is on screen, or null. */
  activeId: string | null;
  /** Where the terminal goes (SessionDetail's slot), or null when none shows. */
  slot: HTMLElement | null;
  sessions: SessionSummary[];
}

/** Most recent first, at most `size`, only sessions that still exist. */
export function nextDeck(prev: string[], activeId: string | null, alive: Set<string>, size = DECK_SIZE): string[] {
  const kept = prev.filter((id) => alive.has(id) && id !== activeId);
  return (activeId && alive.has(activeId) ? [activeId, ...kept] : kept).slice(0, size);
}

/**
 * How long a hidden terminal stays connected. While connected, its Claude
 * counts as watched and never goes to sleep (idle-sleep.ts) — with the app
 * open all day, that kept the five most recent Claudes, each with its
 * language server, awake forever. Coming back after this reconnects (the
 * screen replays; nothing restarts unless it slept).
 */
export const DECK_HIDDEN_MS = 10 * 60_000;

/** The deck without terminals hidden longer than `maxHiddenMs` (the shown one always stays). */
export function pruneDeck(
  ids: string[],
  activeId: string | null,
  hiddenSince: ReadonlyMap<string, number>,
  now: number,
  maxHiddenMs = DECK_HIDDEN_MS,
): string[] {
  return ids.filter((id) => id === activeId || now - (hiddenSince.get(id) ?? now) < maxHiddenMs);
}

/**
 * Keeps the last few session terminals connected, so going back to one is
 * instant: no new socket, no screen replay, no Claude start. Lives at the
 * dashboard level (the session view unmounts when you go to the Inbox) and
 * lays the active terminal over the session view's slot.
 *
 * The hidden ones keep their size (visibility, not display: none): a
 * terminal that shrank to nothing would resize the shared PTY.
 */
export function TerminalDeck({ activeId, slot, sessions }: Props) {
  const [ids, setIds] = useState<string[]>([]);
  const [rect, setRect] = useState<{ top: number; left: number; width: number; height: number } | null>(null);

  useEffect(() => {
    const alive = new Set(sessions.filter((s) => !s.archivedAt).map((s) => s.id));
    setIds((prev) => {
      const next = nextDeck(prev, activeId, alive);
      return next.length === prev.length && next.every((id, i) => id === prev[i]) ? prev : next;
    });
  }, [activeId, sessions]);

  // When each terminal was last on screen; hidden too long, it lets go.
  const hiddenSince = useRef(new Map<string, number>());
  const shown = slot ? activeId : null;
  useEffect(() => {
    const now = Date.now();
    for (const id of ids) {
      if (id === shown) hiddenSince.current.delete(id);
      else if (!hiddenSince.current.has(id)) hiddenSince.current.set(id, now);
    }
    for (const id of [...hiddenSince.current.keys()]) if (!ids.includes(id)) hiddenSince.current.delete(id);
  }, [ids, shown]);
  useEffect(() => {
    const t = setInterval(() => {
      setIds((prev) => {
        const next = pruneDeck(prev, shown, hiddenSince.current, Date.now());
        return next.length === prev.length ? prev : next;
      });
    }, 60_000);
    return () => clearInterval(t);
  }, [shown]);

  // Follow the slot: its size changes with the rail divider, the window,
  // the header strip wrapping.
  useLayoutEffect(() => {
    if (!slot) return;
    const measure = () => {
      const r = slot.getBoundingClientRect();
      setRect((prev) =>
        prev && prev.top === r.top && prev.left === r.left && prev.width === r.width && prev.height === r.height
          ? prev
          : { top: r.top, left: r.left, width: r.width, height: r.height },
      );
    };
    measure();
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : null;
    ro?.observe(slot);
    window.addEventListener('resize', measure);
    window.addEventListener('scroll', measure, true);
    return () => {
      ro?.disconnect();
      window.removeEventListener('resize', measure);
      window.removeEventListener('scroll', measure, true);
    };
  }, [slot]);

  if (ids.length === 0 || !rect) return null;
  const showing = !!slot && !!activeId;
  const byId = new Map(sessions.map((s) => [s.id, s]));
  return (
    <div
      className="wd-term-deck"
      style={{ top: rect.top, left: rect.left, width: rect.width, height: rect.height, visibility: showing ? 'visible' : 'hidden' }}
    >
      {ids.map((id) => {
        const on = showing && id === activeId;
        const s = byId.get(id);
        return (
          <div key={id} className="wd-term-deck-item" style={{ visibility: on ? 'visible' : 'hidden' }} aria-hidden={!on}>
            <PtyView sessionId={id} target={s?.target} branch={s?.branch} active={on} />
          </div>
        );
      })}
    </div>
  );
}
