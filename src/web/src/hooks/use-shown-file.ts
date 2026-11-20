import { useCallback, useEffect, useState } from 'react';
import type { SessionShownWire } from '../../../core/api-types.js';
import { fetchSessionShown } from '../api/client.js';
import { useSse } from '../api/events.js';

/** The file a session shows beside its terminal, followed live (`session-show-changed`); null: none. */
export function useShownFile(sessionId: string): NonNullable<SessionShownWire['shown']> | null {
  const [shown, setShown] = useState<SessionShownWire['shown']>(null);
  const load = useCallback(() => {
    fetchSessionShown(sessionId).then(
      (w) => setShown(w.shown),
      () => setShown(null),
    );
  }, [sessionId]);
  useEffect(() => {
    setShown(null);
    load();
  }, [load]);
  useSse('/events', {
    events: {
      'session-show-changed': (data: unknown) => {
        if ((data as { sessionId?: string } | null)?.sessionId === sessionId) load();
      },
    },
  });
  return shown;
}
