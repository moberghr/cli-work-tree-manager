import { describe, it, expect } from 'vitest';
import {
  checkpointAtOrBefore,
  decideRange,
  rangeEmptyMessage,
} from '../../src/web/src/state/checkpoint-range.js';
import type { CheckpointEntry } from '../../src/web/src/api/client.js';

function entry(id: number, label?: string): CheckpointEntry {
  return {
    id,
    ts: '2026-06-03T00:00:00Z',
    label,
    repos: { 'C:/repo': `sha-for-${id}` },
  };
}

describe('decideRange', () => {
  it('returns legacy mode when there are no checkpoints', () => {
    expect(decideRange([], false, null)).toEqual({ kind: 'legacy' });
  });

  it('returns legacy mode when only Initial exists', () => {
    // The whole point: Initial captures the live working tree, so
    // ranging against it on first open shows an empty diff. Falling
    // through to legacy `HEAD → working` is what users intuitively
    // expect.
    expect(decideRange([entry(0, 'Initial')], false, null)).toEqual({
      kind: 'legacy',
    });
  });

  it('returns Initial → working when a second checkpoint arrives', () => {
    const entries = [entry(0, 'Initial'), entry(1)];
    expect(decideRange(entries, false, null)).toEqual({
      kind: 'range',
      range: { from: 0, to: 'working' },
    });
  });

  it('pins from to the FIRST entry, not the latest, so the baseline survives autosaves', () => {
    // Regression: an earlier shape advanced `from` to the newest
    // checkpoint on every refresh, collapsing the visible diff to
    // "since the last save" — users lost their session baseline.
    const entries = [entry(0, 'Initial'), entry(1), entry(2), entry(3)];
    const decision = decideRange(entries, false, null);
    expect(decision.kind).toBe('range');
    expect(decision.kind === 'range' && decision.range.from).toBe(0);
  });

  it('keeps an explicit user pick across refreshes', () => {
    const entries = [entry(0), entry(1), entry(2)];
    const userRange = { from: 1, to: 2 as const };
    const decision = decideRange(entries, true, userRange);
    expect(decision.kind).toBe('range');
    expect(decision.kind === 'range' && decision.range).toEqual(userRange);
    expect(decision.resetUserPicked).toBeUndefined();
  });

  it('resets the user pick + clears the flag when the picked from-id is no longer present', () => {
    // Scope was torn down and re-registered, so the manifest restarts
    // at id 0 with new shas. The user's previous `{from: 2, to: 'working'}`
    // pick is meaningless — both endpoints may be gone.
    const newEntries = [entry(0), entry(1)];
    const stale = { from: 5, to: 'working' as const };
    const decision = decideRange(newEntries, true, stale);
    expect(decision).toEqual({
      kind: 'range',
      range: { from: 0, to: 'working' },
      resetUserPicked: true,
    });
  });

  it('resets when picked numeric to-id is no longer present', () => {
    const newEntries = [entry(0), entry(1)];
    const stale = { from: 0, to: 7 as const };
    const decision = decideRange(newEntries, true, stale);
    expect(decision.kind).toBe('range');
    expect(decision.resetUserPicked).toBe(true);
  });

  it('to=working always validates (working tree is always reachable)', () => {
    const entries = [entry(0), entry(1)];
    const decision = decideRange(
      entries,
      true,
      { from: 0, to: 'working' },
    );
    expect(decision).toEqual({
      kind: 'range',
      range: { from: 0, to: 'working' },
    });
  });
});

describe('rangeEmptyMessage', () => {
  it('explains that the newest checkpoint matches the working tree', () => {
    const msg = rangeEmptyMessage({ from: 21, to: 'working' }, 21);
    expect(msg).toContain('checkpoint #21');
    expect(msg).toContain('most recent snapshot');
    expect(msg).toContain('earlier checkpoint');
    // Must NOT show the generic hint in this case.
    expect(msg).not.toContain('Pick a different range');
  });

  it('labels Initial specially when it is the latest-and-only checkpoint', () => {
    const msg = rangeEmptyMessage({ from: 0, to: 'working' }, 0);
    expect(msg).toContain('Initial is the most recent snapshot');
  });

  it('uses the generic message for an older from-checkpoint', () => {
    const msg = rangeEmptyMessage({ from: 19, to: 'working' }, 21);
    expect(msg).toContain('No changes between checkpoint #19 and working tree');
    expect(msg).toContain('Pick a different range');
  });

  it('uses the generic message for a checkpoint-to-checkpoint range', () => {
    const msg = rangeEmptyMessage({ from: 0, to: 5 }, 21);
    expect(msg).toContain('No changes between Initial and checkpoint #5');
  });

  it('falls back to the generic message when the latest id is unknown', () => {
    const msg = rangeEmptyMessage({ from: 21, to: 'working' }, undefined);
    expect(msg).toContain('Pick a different range');
  });
});

describe('checkpointAtOrBefore ("Only new" baseline)', () => {
  const at = (id: number, iso: string): CheckpointEntry => ({
    id,
    ts: iso,
    repos: {},
  });
  const cps = [
    at(0, '2026-09-23T10:00:00Z'),
    at(1, '2026-09-23T10:05:00Z'),
    at(2, '2026-09-23T10:10:00Z'),
  ];
  const ms = (iso: string) => Date.parse(iso);

  it('picks the newest checkpoint taken before the diff was fetched', () => {
    expect(checkpointAtOrBefore(cps, ms('2026-09-23T10:07:00Z'))).toBe(1);
  });

  it('counts a checkpoint taken at the exact fetch instant as seen', () => {
    expect(checkpointAtOrBefore(cps, ms('2026-09-23T10:05:00Z'))).toBe(1);
  });

  it('resolves once a late checkpoint list arrives (first-load race)', () => {
    // The diff lands before the checkpoint list: nothing to resolve yet...
    expect(checkpointAtOrBefore([], ms('2026-09-23T10:12:00Z'))).toBeNull();
    // ...and the same fetch time resolves correctly when the list shows up,
    // instead of staying null for the whole session.
    expect(checkpointAtOrBefore(cps, ms('2026-09-23T10:12:00Z'))).toBe(2);
  });

  it('includes a checkpoint the list learns about after a reload (reload race)', () => {
    // Reload fetched at 10:12, but the list still only knew 0..1 when the
    // diff landed. Once checkpoint 2 (10:10, BEFORE the fetch) arrives, the
    // baseline moves to it — the reloaded diff already contains that turn.
    expect(checkpointAtOrBefore(cps.slice(0, 2), ms('2026-09-23T10:12:00Z'))).toBe(1);
    expect(checkpointAtOrBefore(cps, ms('2026-09-23T10:12:00Z'))).toBe(2);
  });

  it('ignores checkpoints taken after the fetch — those are the new part', () => {
    expect(checkpointAtOrBefore(cps, ms('2026-09-23T10:01:00Z'))).toBe(0);
  });

  it('is null when the diff predates every checkpoint', () => {
    expect(checkpointAtOrBefore(cps, ms('2026-09-23T09:00:00Z'))).toBeNull();
  });
});
