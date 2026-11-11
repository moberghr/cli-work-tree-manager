import { describe, expect, it } from 'vitest';
import { createTicketBook, isLoopbackOrigin, TICKET_TTL_MS } from '../../../src/core/pty/terminal-tickets.js';

/** One-time tickets for a dashboard page to attach a terminal straight to the PTY host (no token leaves work web). */

describe('terminal tickets', () => {
  const page = 'http://127.0.0.1:54989';

  it('once, for its terminal, from its origin, before it expires', () => {
    let t = 1_000;
    const book = createTicketBook(() => t);
    const a = book.issue('s1', page)!;
    expect(a).toMatch(/^[0-9a-f]{48}$/);
    expect(book.redeem(a, 's1', page)).toBe(true);
    expect(book.redeem(a, 's1', page)).toBe(false); // used
    const late = book.issue('s1', page)!;
    t += TICKET_TTL_MS;
    expect(book.redeem(late, 's1', page)).toBe(false); // expired
  });

  it('another terminal or another origin burns it: no second try with the same ticket', () => {
    const book = createTicketBook();
    const a = book.issue('s1', page)!;
    expect(book.redeem(a, 's2', page)).toBe(false);
    expect(book.redeem(a, 's1', page)).toBe(false);
    const b = book.issue('s1', page)!;
    expect(book.redeem(b, 's1', 'http://127.0.0.1:1')).toBe(false);
    expect(book.redeem(b, 's1', page)).toBe(false);
    expect(book.redeem('nope', 's1', page)).toBe(false);
    expect(book.redeem(book.issue('s1', page)!, 's1', undefined)).toBe(false); // no origin: not a page
  });

  it('only for a page on this machine', () => {
    const book = createTicketBook();
    expect(book.issue('s1', 'https://evil.example')).toBeNull();
    expect(book.issue('', page)).toBeNull();
    for (const o of ['http://127.0.0.1:5', 'http://localhost:54989', 'https://localhost', 'http://[::1]:80'])
      expect(isLoopbackOrigin(o)).toBe(true);
    for (const o of ['http://127.0.0.1.evil.example', 'http://localhost.evil:1', 'file://', 'null'])
      expect(isLoopbackOrigin(o)).toBe(false);
  });
});
