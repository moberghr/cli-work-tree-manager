import { describe, expect, it } from 'vitest';
import {
  cleanSessionPrs,
  MAX_SESSION_PRS,
  noteSessionPrs,
  notePrLooks,
  readSessionPrs,
  withPrLooks,
  withPrSightings,
} from '../../../src/core/pr/session-prs.js';
import { purgeSessionRows, withDb } from '../../../src/core/platform/db.js';
import type { ShipPr } from '../../../src/core/api-types.js';

const NOW = new Date('2026-11-09T09:00:00Z');
const url = (n: number, repo = 'kvika/straumur-backend') => `https://github.com/${repo}/pull/${n}`;
const shipPr = (n: number, over: Partial<ShipPr> = {}): ShipPr => ({
  number: n,
  url: url(n),
  state: 'OPEN',
  isDraft: false,
  mergeStateStatus: 'CLEAN',
  checks: 'pass',
  headSha: 'abc',
  ...over,
});

describe("a session's PR list (pure)", () => {
  it('a PR is added once; a second sighting adds its source and branch, and an earlier first sighting', () => {
    const a = withPrSightings(null, [{ url: url(3644), number: 3644, source: 'agent', at: '2026-11-03T10:00:00.000Z' }], NOW);
    expect(a.prs).toEqual([
      { url: url(3644), number: 3644, repoId: 'kvika/straumur-backend', sources: ['agent'], firstSeen: '2026-11-03T10:00:00.000Z' },
    ]);
    const b = withPrSightings(a, [{ url: url(3644), number: 3644, branch: 'fix/SD-3999-webhook-nullable-columns', source: 'branch' }], NOW);
    expect(b.prs[0]).toMatchObject({ sources: ['agent', 'branch'], branch: 'fix/SD-3999-webhook-nullable-columns' });
    // Nothing new: the same object, so nothing is written.
    expect(withPrSightings(b, [{ url: url(3644), number: 3644, source: 'agent' }], NOW)).toBe(b);
  });

  it('the link as the host writes it is the key: a link with a tail is the same PR', () => {
    const docs = url(87, 'kvika/straumur-documentation');
    const a = withPrSightings(null, [{ url: docs, number: 87, source: 'agent' }], NOW);
    const b = withPrSightings(a, [{ url: `${docs}/files`, number: 87, source: 'branch' }], NOW);
    expect(b.prs).toHaveLength(1);
    expect(b.prs[0].repoId).toBe('kvika/straumur-documentation');
  });

  it('scanned is set once, by the first whole read', () => {
    const a = withPrSightings(null, [], NOW, { scanned: true });
    expect(a.scanned).toBe(NOW.toISOString());
    expect(withPrSightings(a, [], new Date('2026-12-01T00:00:00Z'), { scanned: true })).toBe(a);
  });

  it('a merged or closed PR keeps its last look and is asked no more; an open one is never final', () => {
    const rec = withPrSightings(
      null,
      [
        { url: url(1), number: 1, source: 'agent' },
        { url: url(2), number: 2, source: 'agent' },
      ],
      NOW,
    );
    const next = withPrLooks(rec, [
      { url: url(1), pr: shipPr(1, { state: 'MERGED', headBranch: 'fix/a' }), branch: 'fix/a' },
      { url: url(2), pr: shipPr(2) },
    ]);
    expect(next.prs[0]).toMatchObject({ final: { state: 'MERGED' }, branch: 'fix/a' });
    expect(next.prs[1].final).toBeUndefined();
    expect(withPrLooks(next, [{ url: url(2), pr: shipPr(2) }])).toBe(next);
  });

  it('at most MAX_SESSION_PRS: every open one stays, the oldest finished ones go', () => {
    const many = Array.from({ length: MAX_SESSION_PRS + 5 }, (_, i) => i + 1);
    const at = (n: number) => new Date(Date.parse('2026-01-01T00:00:00Z') + n * 3600_000).toISOString();
    const rec = withPrSightings(
      null,
      many.map((n) => ({ url: url(n), number: n, source: 'agent' as const, at: at(n) })),
      NOW,
    );
    // Everything is still open: none is dropped.
    expect(rec.prs).toHaveLength(MAX_SESSION_PRS + 5);
    const finished = withPrLooks(
      rec,
      many.slice(0, 10).map((n) => ({ url: url(n), pr: shipPr(n, { state: 'MERGED' }) })),
    );
    const trimmed = withPrSightings(finished, [{ url: url(999), number: 999, source: 'agent' }], NOW);
    expect(trimmed.prs).toHaveLength(MAX_SESSION_PRS);
    expect(trimmed.prs.some((p) => p.number === 1)).toBe(false); // the oldest finished went
    expect(trimmed.prs.some((p) => p.number === 999)).toBe(true);
  });

  it('a stored record is shape-checked: bad entries go, the record stays', () => {
    expect(cleanSessionPrs(null)).toBeNull();
    expect(cleanSessionPrs({ prs: 'x' })).toBeNull();
    const got = cleanSessionPrs({
      scanned: 'not a date',
      prs: [
        { url: url(1), number: 1, repoId: 'a/b', sources: ['agent', 'nonsense'], firstSeen: NOW.toISOString(), final: { state: 'OPEN' } },
        { url: url(2), number: -2, repoId: 'a/b', sources: ['agent'], firstSeen: NOW.toISOString() },
        { url: url(3), number: 3, repoId: 'a/b', sources: [], firstSeen: NOW.toISOString() },
      ],
    });
    expect(got).toEqual({ prs: [{ url: url(1), number: 1, repoId: 'a/b', sources: ['agent'], firstSeen: NOW.toISOString() }] });
  });
});

describe("a session's PR list in state.db", () => {
  it('written in one transaction, read back, final looks kept, and gone with the session', () => {
    noteSessionPrs('s1', [{ url: url(3657), number: 3657, branch: 'fix/culture', source: 'branch' }], NOW);
    notePrLooks('s1', [{ url: url(3657), pr: shipPr(3657, { state: 'CLOSED' }) }]);
    expect(readSessionPrs('s1')?.prs[0]).toMatchObject({ number: 3657, branch: 'fix/culture', final: { state: 'CLOSED' } });
    withDb((d) => purgeSessionRows(d, 's1'));
    expect(readSessionPrs('s1')).toBeNull();
  });
});
