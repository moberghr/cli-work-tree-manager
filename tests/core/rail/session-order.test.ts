import { describe, expect, it } from 'vitest';
import { applyManualOrder, cleanOrder, moveSession } from '../../../src/core/rail/session-order.js';
import { readSessionOrder, writeSessionOrder } from '../../../src/core/rail/session-order-store.js';

const ids = (xs: Array<{ id: string }>) => xs.map((x) => x.id);
const s = (...names: string[]) => names.map((id) => ({ id }));

describe('applyManualOrder', () => {
  it('puts sessions you placed in your order, and new ones first', () => {
    expect(ids(applyManualOrder(s('a', 'b', 'c', 'new'), ['c', 'a', 'b']))).toEqual(['new', 'c', 'a', 'b']);
    expect(ids(applyManualOrder(s('a', 'b'), []))).toEqual(['a', 'b']);
  });

  it('the ones you haven’t placed: newest created first, not by project name (reported: timesheet second after perf-check)', () => {
    // As the rail hands them over (by project): straumur-backend before timesheet.
    const list = [
      { id: 'perf', createdAt: '2026-10-01T11:31:49Z' },
      { id: 'timesheet', createdAt: '2026-10-02T07:47:25Z' },
      { id: 'placed', createdAt: '2026-09-29T13:56:51Z' },
    ];
    expect(ids(applyManualOrder(list, ['placed']))).toEqual(['timesheet', 'perf', 'placed']);
  });
});

describe('moveSession', () => {
  it('moves a row in front of another, or to the end', () => {
    expect(moveSession(['a', 'b', 'c', 'd'], 'd', 'b', [])).toEqual(['a', 'd', 'b', 'c']);
    expect(moveSession(['a', 'b', 'c'], 'a', null, [])).toEqual(['b', 'c', 'a']);
    expect(moveSession(['a', 'b', 'c'], 'b', 'b', [])).toEqual(['a', 'b', 'c']);
  });
  it('keeps placed sessions that are not shown after the shown ones', () => {
    expect(moveSession(['a', 'b'], 'b', 'a', ['old1', 'a', 'old2', 'b'])).toEqual(['b', 'a', 'old1', 'old2']);
  });
});

describe('cleanOrder', () => {
  it('accepts an array of ids, dropping duplicates; refuses anything else', () => {
    expect(cleanOrder(['a', 'b', 'a'])).toEqual(['a', 'b']);
    expect(cleanOrder('a,b')).toBeNull();
    expect(cleanOrder(['a', 3])).toBeNull();
  });
});

describe('the stored order (state.db)', () => {
  it('round-trips, and is empty before anything was saved', () => {
    expect(readSessionOrder()).toEqual([]);
    writeSessionOrder(['x', 'y']);
    expect(readSessionOrder()).toEqual(['x', 'y']);
    writeSessionOrder(['y']);
    expect(readSessionOrder()).toEqual(['y']);
  });
});
