import { useCallback, useEffect, useRef, useState } from 'react';
import { ASK_URL } from './use-desktop.js';
import { sendDesktopAsk } from '../state/desktop-asks.js';
import { badgeAsk, inTaskbarApp, newlyNeedingYou, readFlashOn, writeFlashOn } from '../state/taskbar.js';

/**
 * In the desktop app: the Inbox count on its taskbar / Dock icon, kept current,
 * and a flash of the taskbar button when a session newly needs your input (the
 * app skips it while its window is in front). `needingYou`: the sessions waiting
 * on you now. Nothing until the session list has loaded once (`ready`): before it
 * the count reads 0 and every waiting session would look new. Nothing in a
 * browser tab.
 */
export function useTaskbar(
  inboxCount: number,
  needingYou: ReadonlySet<string>,
  opts: { ready: boolean; go?: (url: string) => void; inApp?: boolean },
) {
  const [inApp] = useState(() => opts.inApp ?? inTaskbarApp());
  const [flashOn, setFlashOnState] = useState(readFlashOn);
  const goRef = useRef(opts.go ?? ((url: string) => window.location.assign(url)));
  goRef.current = opts.go ?? goRef.current;
  const { ready } = opts;

  useEffect(() => {
    if (inApp && ready) sendDesktopAsk(`${ASK_URL}${badgeAsk(inboxCount)}`, goRef.current);
  }, [inApp, ready, inboxCount]);

  // What was waiting when the list first came isn't news: only a session that starts waiting after it flashes.
  const seen = useRef<ReadonlySet<string> | null>(null);
  useEffect(() => {
    if (!ready) return;
    const before = seen.current;
    seen.current = needingYou;
    if (inApp && flashOn && before && newlyNeedingYou(before, needingYou)) sendDesktopAsk(`${ASK_URL}attention`, goRef.current);
  }, [inApp, ready, flashOn, needingYou]);

  const setFlashOn = useCallback((on: boolean) => {
    writeFlashOn(on);
    setFlashOnState(on);
  }, []);
  return { inApp, flashOn, setFlashOn };
}
