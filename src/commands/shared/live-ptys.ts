import { findHost, PtyHostClient } from '../../core/pty/pty-host-client.js';
import type { PtyInfo } from '../../core/pty/pty-host-protocol.js';

/** The PTY host's live sessions by id; null when no host runs (or it
 *  doesn't answer): "unknown", not "none". */
export async function livePtys(): Promise<Map<string, PtyInfo> | null> {
  try {
    const info = await findHost([800]);
    if (!info) return null;
    const ptys = await new PtyHostClient(info).list();
    return new Map(ptys.filter((p) => !p.exited).map((p) => [p.id, p]));
  } catch {
    return null;
  }
}
