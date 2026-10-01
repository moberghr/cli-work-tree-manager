import type { ReactElement } from 'react';
import type { DisplayKind } from '../../state/session-display.js';
import { DISPLAY_LABEL, DISPLAY_MEANING } from '../../state/session-display.js';

/**
 * A session's status as a small icon: the shape says it, the colour backs
 * it up (the dots' colours, in CSS). One per DisplayKind, for
 * every view — rail, header, Sessions table, inbox, legend.
 *
 * Keeps the dot's class names (`wd-rail-dot wd-rail-dot-<kind>`): views and
 * tests find a row's status by them.
 */
export function StatusIcon({ kind, labelled = false }: { kind: DisplayKind; labelled?: boolean }) {
  const a11y = labelled
    ? { role: 'img' as const, 'aria-label': DISPLAY_LABEL[kind], title: `${DISPLAY_LABEL[kind]}: ${DISPLAY_MEANING[kind]}` }
    : { 'aria-hidden': true as const };
  return (
    <span className={`wd-rail-dot wd-rail-dot-${kind} wd-status-icon`} {...a11y}>
      <svg viewBox="0 0 16 16" width="14" height="14" focusable="false">
        {GLYPH[kind]}
      </svg>
    </span>
  );
}

const cut = 'var(--status-icon-cut, var(--bg))'; // the glyph inside a filled disc

const GLYPH: Record<DisplayKind, ReactElement> = {
  // Blocked on you: "!" in a filled disc.
  needs_input: (
    <>
      <circle cx="8" cy="8" r="7" fill="currentColor" />
      <path d="M8 4.3v4.4" stroke={cut} strokeWidth="1.9" strokeLinecap="round" />
      <circle cx="8" cy="11.4" r="1.1" fill={cut} />
    </>
  ),
  // Finished, not looked at: a check in a filled disc.
  done: (
    <>
      <circle cx="8" cy="8" r="7" fill="currentColor" />
      <path d="M4.8 8.3l2.1 2.1 4.3-4.5" fill="none" stroke={cut} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </>
  ),
  // Mid-turn: a turning arc.
  working: (
    <g className="wd-status-spin">
      <circle cx="8" cy="8" r="5.6" fill="none" stroke="currentColor" strokeOpacity="0.25" strokeWidth="2" />
      <path d="M8 2.4a5.6 5.6 0 0 1 5.6 5.6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </g>
  ),
  // Reviewers are waiting: a speech bubble.
  review: (
    <path
      d="M3 3.2h10a1.6 1.6 0 0 1 1.6 1.6v5.2a1.6 1.6 0 0 1-1.6 1.6H7.4L4.3 14v-2.4H3A1.6 1.6 0 0 1 1.4 10V4.8A1.6 1.6 0 0 1 3 3.2z"
      fill="currentColor"
    />
  ),
  // Finished and seen: an empty ring.
  quiet: <circle cx="8" cy="8" r="5.4" fill="none" stroke="currentColor" strokeWidth="1.8" />,
  // Writing right now, no hook status: a pulse line.
  active: (
    <path d="M1.5 8.5h3l1.8-4.2 3.2 8 1.9-3.8h3.1" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
  ),
  // Open at its prompt, no hook status: a ring with a dot.
  open: (
    <>
      <circle cx="8" cy="8" r="5.4" fill="none" stroke="currentColor" strokeWidth="1.8" />
      <circle cx="8" cy="8" r="2" fill="currentColor" />
    </>
  ),
  // Used today, nothing running (the same word as quiet: Idle).
  recent: <circle cx="8" cy="8" r="5.4" fill="none" stroke="currentColor" strokeWidth="1.8" />,
  // Not used for over a day: a moon.
  stale: <path d="M10.6 2.2a6 6 0 1 0 3.2 9.6A5 5 0 0 1 10.6 2.2z" fill="currentColor" />,
};
