import type { SetupWire } from '../../../core/api-types.js';

/** The dashboard opens on Welcome while there is nothing to work on yet: no folders set, or no repo and no session. Pure. */
export function needsSetup(s: Pick<SetupWire, 'configured' | 'repos' | 'sessions'>): boolean {
  return !s.configured || (s.repos === 0 && s.sessions === 0);
}

/** A needed tool that doesn't answer: work can't start sessions until it does. Pure. */
export function blockingTools(s: Pick<SetupWire, 'tools'>): string[] {
  return s.tools.filter((t) => t.needed && !t.ok).map((t) => t.label);
}
