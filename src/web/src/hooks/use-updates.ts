import { useCallback, useEffect, useState } from 'react';
import type { UpdateWire } from '../../../core/api-types.js';
import { checkForUpdates, fetchUpdates, markNotesSeen, restartToUpdate } from '../api/panes.js';
import { useSse } from '../api/events.js';

/**
 * Where an update stands (GET /api/updates), kept fresh: on load, when the
 * server says it changed (a new release read, the desktop app's updater
 * moved), and every half hour. With the actions the dashboard offers on it.
 */
export function useUpdates(api = { fetchUpdates, checkForUpdates, restartToUpdate, markNotesSeen }) {
  const [updates, setUpdates] = useState<UpdateWire | null>(null);
  const [checking, setChecking] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const load = useCallback(() => {
    api.fetchUpdates().then(setUpdates, () => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the api is fixed for the hook's life
  }, []);
  useEffect(() => {
    load();
    const t = setInterval(load, 30 * 60_000);
    return () => clearInterval(t);
  }, [load]);
  useSse('/events', { events: { 'updates-changed': load } });

  /** Check for updates, and say how it went (the user is waiting for an answer). */
  const check = useCallback(() => {
    setChecking(true);
    setNote(null);
    api
      .checkForUpdates()
      .then(
        (w) => {
          setUpdates(w);
          setNote(
            w.checkError
              ? `Couldn't check: ${w.checkError}`
              : w.available
                ? `work ${w.available.version} is out.`
                : w.desktop?.state === 'checking'
                  ? 'Checking…'
                  : `You have the newest work (${w.running}).`,
          );
        },
        (err: Error) => setNote(`Couldn't check: ${err.message}`),
      )
      .finally(() => setChecking(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the api is fixed for the hook's life
  }, []);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- the api is fixed for the hook's life
  const restart = useCallback(() => api.restartToUpdate(), []);
  const seen = useCallback(
    (version: string) => {
      void api.markNotesSeen(version).then(load, () => {});
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the api is fixed for the hook's life
    [load],
  );
  return { updates, check, checking, note, restart, seen };
}
