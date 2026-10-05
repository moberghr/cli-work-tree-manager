import type { WorktreeSession } from '../sessions/session-types.js';
import { sessionIdFor } from '../sessions/session-id.js';
import { logSwallowed } from '../platform/best-effort.js';

/**
 * What work web does after an archive (`onArchived`, session-archive.ts): the
 * sessions stacked on it move onto main when it merged (stack-retarget.ts),
 * and the blocks waiting on it are swept. The listener fires only in the
 * process that archived, so the dev server (`work web --dev`) moves the
 * stacked sessions too — no other process hears of an archive done from its
 * dashboard — but leaves the block sweep (gh, notifications, notes to
 * Claudes) to the real work web, whose 3-minute sweep finds it.
 */
export function afterArchive(
  s: WorktreeSession,
  deps: { retarget: (id: string) => Promise<number>; changed: () => void; sweepBlocks?: () => Promise<void> },
): void {
  void deps
    .retarget(sessionIdFor(s))
    .then((n) => n && deps.changed())
    .catch((err) => logSwallowed('moving stacked sessions onto main', err));
  // A session others wait on is done.
  if (deps.sweepBlocks) void deps.sweepBlocks();
}
