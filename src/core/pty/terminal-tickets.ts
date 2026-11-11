import crypto from 'node:crypto';

/**
 * One-time tickets that let a dashboard page connect its Terminal tab straight to the PTY host, not through work web
 * (reported: typing lagged in the app while `work attach` in Windows Terminal — the same host, no work web — was
 * smooth; work web's event loop stalls every minute or so, and each keystroke and echo waited on it).
 *
 * work web asks for one with the host's token (which never leaves work web) after its own checks — the session may
 * run its agent here, it was started — and hands the page an address with the ticket. The host takes a connection
 * with it once: for that one terminal, from the page's own origin, within `TICKET_TTL_MS`. A ticket used for another
 * terminal or from another origin is burnt all the same. Pure but for the random ticket.
 */

export const TICKET_TTL_MS = 30_000;

/** The origins a ticket may be for: a page served on this machine (work web's, the desktop app's window). */
const LOOPBACK_ORIGIN = /^https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::\d{1,5})?$/;

export const isLoopbackOrigin = (origin: string): boolean => LOOPBACK_ORIGIN.test(origin);

export interface TicketBook {
  /** A ticket for this terminal and origin; null for an origin that isn't a page on this machine. */
  issue(id: string, origin: string): string | null;
  /** Whether this connection may use the ticket: true once, for its terminal, from its origin, before it expires. */
  redeem(ticket: string, id: string, origin: string | undefined): boolean;
}

export function createTicketBook(now: () => number = Date.now): TicketBook {
  const book = new Map<string, { id: string; origin: string; expires: number }>();
  const sweep = () => {
    const t = now();
    for (const [k, v] of book) if (v.expires <= t) book.delete(k);
  };
  return {
    issue(id, origin) {
      if (!id || !isLoopbackOrigin(origin)) return null;
      sweep();
      const ticket = crypto.randomBytes(24).toString('hex');
      book.set(ticket, { id, origin, expires: now() + TICKET_TTL_MS });
      return ticket;
    },
    redeem(ticket, id, origin) {
      const t = book.get(ticket);
      if (!t) return false;
      book.delete(ticket); // once, whatever happens next
      return t.expires > now() && t.id === id && t.origin === origin;
    },
  };
}
