import { useCallback, useEffect, useRef, useState } from 'react';
import type { UpdateWire } from '../../../core/api-types.js';
import { inAppUpdates, parseDesktopUpdate, type DesktopUpdate } from '../../../core/updates/updates.js';

/**
 * The desktop app's window, straight to and from the app — not through work
 * web, which can be another work (a dev checkout's) or a version behind the
 * app. The app marks its window before the page loads (`__workDesktop`),
 * sends where its update stands as a `work-desktop` event (with the download
 * percentage), and takes the page's asks as a navigation to its own host,
 * which it cancels (desktop/src-tauri/src/updates.rs: ASK_HOST, page_ask).
 * In a browser tab none of this exists: the hook says null.
 */

/** desktop/src-tauri/src/updates.rs ASK_HOST: `.invalid` never resolves, so outside the app it goes nowhere. */
export const ASK_URL = 'http://work-desktop.invalid/';
export type DesktopAsk = 'hello' | 'check' | 'restart';

interface Marker {
  app?: boolean;
  update?: unknown;
}
const marker = (): Marker | undefined => (window as unknown as { __workDesktop?: Marker }).__workDesktop;
const parse = (x: unknown): DesktopUpdate | null => (x && typeof x === 'object' ? parseDesktopUpdate(JSON.stringify(x)) : null);

/** Whether this page is the desktop app's window. */
export const inDesktopApp = (): boolean => marker()?.app === true;

export function useDesktop(go: (url: string) => void = (url) => window.location.assign(url)) {
  const [inApp] = useState(inDesktopApp);
  const [update, setUpdate] = useState<DesktopUpdate | null>(() => parse(marker()?.update));
  const [note, setNote] = useState<string | null>(null);
  /** When a Check was asked (the app's `at`, in seconds), or null. */
  const checkAsked = useRef<number | null>(null);
  const goRef = useRef(go);
  goRef.current = go;

  useEffect(() => {
    if (!inApp) return;
    const on = (e: Event) => setUpdate(parse((e as CustomEvent).detail));
    window.addEventListener('work-desktop', on);
    // Up: ask for where the update stands (the app sent it before this page, or a reload, was there).
    goRef.current(`${ASK_URL}hello`);
    return () => window.removeEventListener('work-desktop', on);
  }, [inApp]);

  // How a Check for updates went, once the app has looked.
  useEffect(() => {
    // A download's progress isn't the check's answer: the check runs after it (one updater loop).
    if (checkAsked.current === null || !update || update.state === 'checking' || update.state === 'downloading') return;
    if (typeof update.at === 'number' && update.at < checkAsked.current) return; // from before the ask
    checkAsked.current = null;
    setNote(
      update.state === 'failed'
        ? `Couldn't check: ${update.error ?? 'unknown'}`
        : update.state === 'current'
          ? `You have the newest work (${update.appVersion}).`
          : update.target
            ? `work ${update.target} is out.`
            : null,
    );
  }, [update]);

  const ask = useCallback((what: Exclude<DesktopAsk, 'hello'>) => {
    if (what === 'check') {
      checkAsked.current = Math.floor(Date.now() / 1000);
      setNote(null);
    }
    goRef.current(`${ASK_URL}${what}`);
  }, []);

  // A dev build of the app runs no updater (`unmanaged`): the server's view stands.
  if (!inApp || update?.state === 'unmanaged') return null;
  return { update, note, ask };
}

/**
 * The dashboard's update view inside the app: from the app's own state, the
 * server adding only the release notes; the server's alone until the app has
 * said. Pure.
 */
export function desktopWire(server: UpdateWire | null, app: DesktopUpdate | null): UpdateWire | null {
  if (!app) return server;
  const base: UpdateWire = server ?? {
    running: app.appVersion,
    install: 'desktop',
    latest: null,
    checkedAt: null,
    checkError: null,
    desktop: null,
    available: null,
    whatsNew: null,
  };
  return inAppUpdates(base, app);
}
