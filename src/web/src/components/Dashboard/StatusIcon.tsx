import { useState, type ReactElement } from 'react';
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
export function StatusIcon({
  kind,
  labelled = false,
  muted = false,
}: {
  kind: DisplayKind;
  labelled?: boolean;
  /** Snoozed: the shape, greyed. */ muted?: boolean;
}) {
  // The spinner's phase, from the wall clock: one drawn again (a row remounted) carries on where it was, in step
  // with every other, rather than starting over.
  const [phase] = useState(spinPhase);
  const spins = SPINS.has(kind);
  const a11y = labelled
    ? { role: 'img' as const, 'aria-label': DISPLAY_LABEL[kind], title: `${DISPLAY_LABEL[kind]}: ${DISPLAY_MEANING[kind]}` }
    : { 'aria-hidden': true as const };
  return (
    <span className={`wd-rail-dot wd-rail-dot-${kind} wd-status-icon${muted ? ' wd-status-icon-muted' : ''}`} {...a11y}>
      {/* The whole svg turns, not a group inside it (reported, on macOS): WebKit animates an svg's inner element on
          the main thread and starts it over each time the row around it updates — a working session's does often. */}
      <svg
        viewBox="0 0 16 16"
        width="14"
        height="14"
        focusable="false"
        className={spins ? 'wd-status-spin' : undefined}
        style={spins ? { animationDelay: phase } : undefined}
      >
        {GLYPH[kind]}
      </svg>
    </span>
  );
}

/** The kinds drawn as the turning arc. */
const SPINS: ReadonlySet<DisplayKind> = new Set(['working', 'background', 'archiving', 'restoring']);

/** One turn (`wd-status-spin` in dashboard.css). */
export const SPIN_MS = 1000;

/** A negative delay that puts a spinner where the wall clock says it is in its turn. */
export function spinPhase(now: number = Date.now()): string {
  return `${-(now % SPIN_MS)}ms`;
}

const cut = 'var(--status-icon-cut, var(--bg))'; // the glyph inside a filled disc

const ARC = (
  <>
    <circle cx="8" cy="8" r="5.6" fill="none" stroke="currentColor" strokeOpacity="0.25" strokeWidth="2" />
    <path d="M8 2.4a5.6 5.6 0 0 1 5.6 5.6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
  </>
);

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
  working: ARC,
  // Its turn ended, a background agent it started is still at it: the same arc (still busy), its own colour (CSS).
  background: ARC,
  // Being archived: the same arc (something is happening), grey — it is on its way out.
  archiving: ARC,
  // Being restored: the same grey arc, on its way back.
  restoring: ARC,
  // Its Claude stopped while idle (asleep): a small "z z", grey — opening it starts it again.
  asleep: (
    <path
      d="M2 2.5h6.5L2 9.5h6.5M9.5 8.5h4.5L9.5 13.5h4.5"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  ),
  // Finished and seen: an empty ring.
  quiet: <circle cx="8" cy="8" r="5.4" fill="none" stroke="currentColor" strokeWidth="1.8" />,
  // Writing right now, no hook status: a pulse line.
  active: (
    <path
      d="M1.5 8.5h3l1.8-4.2 3.2 8 1.9-3.8h3.1"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
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
