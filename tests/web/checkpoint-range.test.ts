import { describe, it, expect } from 'vitest';
import { decideRange } from '../../src/web/src/state/checkpoint-range.js';
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
