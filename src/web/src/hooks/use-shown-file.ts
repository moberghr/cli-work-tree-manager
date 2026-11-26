import { useCallback, useEffect, useState } from 'react';
import type { SessionShownWire } from '../../../core/api-types.js';
import { fetchSessionShown } from '../api/client.js';
import { useSse } from '../api/events.js';

export type ShownFileWire = NonNullable<SessionShownWire['shown']>;
export type PaneViewWire = NonNullable<SessionShownWire['pane']>;

/** The pane an older server describes by its file alone: open on the file while one is shown. Pure. */
export function paneOf(w: SessionShownWire): PaneViewWire | null {
  if (w.pane !== undefined) return w.pane;
  return w.shown ? { tab: 'file', at: w.shown.at } : null;
}

/**
 * What a session shows beside its terminal, followed live (`session-show-changed`): the pane (which view is on; null:
 * closed) and the file it shows (null: none).
 */
export function useSessionShown(sessionId: string): {
  shown: ShownFileWire | null;
  pane: PaneViewWire | null;
  /** Apply an answer at once (a change made here), before the server's announcement comes back. */
  set: (w: { shown: ShownFileWire | null; pane: PaneViewWire | null }) => void;
} {
  const [state, setState] = useState<{ shown: ShownFileWire | null; pane: PaneViewWire | null }>({ shown: null, pane: null });
  const load = useCallback(() => {
    fetchSessionShown(sessionId).then(
      (w) => setState({ shown: w.shown, pane: paneOf(w) }),
      () => setState({ shown: null, pane: null }),
    );
  }, [sessionId]);
  useEffect(() => {
    setState({ shown: null, pane: null });
    load();
  }, [load]);
  useSse('/events', {
    events: {
      'session-show-changed': (data: unknown) => {
        if ((data as { sessionId?: string } | null)?.sessionId === sessionId) load();
      },
    },
  });
  return { ...state, set: setState };
}
