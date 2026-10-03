import { hostHealthText, type HostHealth } from '../../../../core/pty/host-health.js';

/**
 * Says so when the PTY host — the process every Claude runs in — is slow or
 * has stopped answering (core/host-health.ts), instead of terminals that just
 * stop moving. Nothing when it's fine.
 */
export function HostHealthBanner({ health }: { health: HostHealth | null }) {
  const text = health ? hostHealthText(health) : null;
  if (!text) return null;
  return (
    <div className={`wd-host-health wd-host-health-${health!.state}`} role="alert">
      {text}
    </div>
  );
}
