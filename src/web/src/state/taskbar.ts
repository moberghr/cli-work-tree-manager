/**
 * The Inbox count on the desktop app's taskbar / Dock icon, and a flash when a
 * session newly needs you (desktop/src-tauri/src/badge.rs). The app marks its
 * window (`__workDesktopTaskbar`, the dev app's too) and takes the page's asks as
 * a navigation to its own host (use-desktop.ts ASK_URL), which it cancels. In a
 * browser tab there is no marker and nothing is asked. Pure, but for the marker
 * and the stored switch.
 */

/** This page is the desktop app's window (or the dev app's): it can show a count on the taskbar. */
export const inTaskbarApp = (): boolean => (window as unknown as { __workDesktopTaskbar?: boolean }).__workDesktopTaskbar === true;

/** The ask for a count: at most four digits, what the app reads (updates.rs page_ask). */
export function badgeAsk(count: number): string {
  return `badge/${Math.max(0, Math.min(Math.floor(count), 9999))}`;
}

/** Whether a session that wasn't waiting on you now is: the moment to flash the taskbar. */
export function newlyNeedingYou(before: ReadonlySet<string>, now: ReadonlySet<string>): boolean {
  for (const id of now) if (!before.has(id)) return true;
  return false;
}

const FLASH_KEY = 'work:taskbar-flash';

/** The "flash the taskbar" switch (per browser; on unless turned off). */
export function readFlashOn(): boolean {
  try {
    return localStorage.getItem(FLASH_KEY) !== 'off';
  } catch {
    return true;
  }
}

export function writeFlashOn(on: boolean): void {
  try {
    localStorage.setItem(FLASH_KEY, on ? 'on' : 'off');
  } catch {
    /* this time only */
  }
}
