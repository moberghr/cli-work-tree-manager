import { useCallback, useEffect, useRef, useState } from 'react';
import { ASK_URL } from './use-desktop.js';
import { badgeAsk, inTaskbarApp, newlyNeedingYou, readFlashOn, writeFlashOn } from '../state/taskbar.js';

/**
 * In the desktop app: the Inbox count on its taskbar / Dock icon, kept current,
 * and a flash of the taskbar button when a session newly needs your input (the
 * app skips it while its window is in front). `needingYou`: the sessions waiting
 * on you now. Nothing in a browser tab.
 */
export function useTaskbar(
  inboxCount: number,
  needingYou: ReadonlySet<string>,
  go: (url: string) => void = (url) => window.location.assign(url),
  inApp: boolean = inTaskbarApp(),
) {
  const [flashOn, setFlashOnState] = useState(readFlashOn);
  const goRef = useRef(go);
  goRef.current = go;

  useEffect(() => {
    if (inApp) goRef.current(`${ASK_URL}${badgeAsk(inboxCount)}`);
  }, [inApp, inboxCount]);

  // The first list read isn't news: only a session that starts waiting while the app runs flashes it.
  const seen = useRef<ReadonlySet<string> | null>(null);
  useEffect(() => {
    const before = seen.current;
    seen.current = needingYou;
    if (inApp && flashOn && before && newlyNeedingYou(before, needingYou)) goRef.current(`${ASK_URL}attention`);
  }, [inApp, flashOn, needingYou]);

  const setFlashOn = useCallback((on: boolean) => {
    writeFlashOn(on);
    setFlashOnState(on);
  }, []);
  return { inApp, flashOn, setFlashOn };
}
