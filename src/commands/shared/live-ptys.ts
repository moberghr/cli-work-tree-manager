import { findHost, PtyHostClient } from '../../core/pty-host-client.js';

/** Session ids whose Claude runs in the PTY host right now; null when no
 *  host runs (or it doesn't answer): "unknown", not "none". */
export async function livePtyIds(): Promise<Set<string> | null> {
  try {
    const info = await findHost([800]);
    if (!info) return null;
    const ptys = await new PtyHostClient(info).list();
    return new Set(ptys.filter((p) => !p.exited).map((p) => p.id));
  } catch {
    return null;
  }
}
