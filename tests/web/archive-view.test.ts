import { describe, expect, it } from 'vitest';
import { archivedAge, archivedLine, archivedWhen, lastActiveLine, listTime } from '../../src/web/src/state/archive-view.js';

describe('archivedLine', () => {
  const at = '2026-10-14T13:02:00Z';

  it('when, and who when it was recorded', () => {
    expect(archivedLine({ archivedAt: at, archive: { by: 'pr-merged' } })).toBe(
      `Archived ${archivedWhen(at)} — its pull request merged, so work archived it.`,
    );
    expect(archivedLine({ archivedAt: at, archive: { by: 'you' } })).toBe(`Archived ${archivedWhen(at)} — you archived it.`);
    expect(archivedLine({ archivedAt: at })).toBe(`Archived ${archivedWhen(at)}.`);
  });

  it('nothing for a live session; a date with its year', () => {
    expect(archivedLine({ archivedAt: null })).toBe('');
    expect(archivedWhen(at)).toContain('2026');
    expect(archivedWhen('not a date')).toBe('');
    expect(archivedLine({ archivedAt: 'not a date', archive: { by: 'you' } })).toBe(''); // never "Archived  — you…"
  });

  it('last active: never "just now ago", nothing when unknown', () => {
    const now = Date.parse('2026-10-15T12:00:00Z');
    expect(lastActiveLine('2026-10-15T11:50:00Z', now)).toBe('Last active 10m ago.');
    expect(lastActiveLine('2026-10-15T11:59:50Z', now)).toBe('Last active just now.');
    expect(lastActiveLine('not a date', now)).toBe('');
  });

  it("the list's time: when archived, only in the Archived view", () => {
    expect(listTime({ archivedAt: 'A' }, 'L', true)).toBe('A');
    expect(listTime({ archivedAt: 'A' }, 'L', false)).toBe('L');
    expect(listTime({ archivedAt: null }, 'L', true)).toBe('L');
  });

  it("the Archived view's sections by when each was archived", () => {
    const now = Date.parse('2026-10-15T12:00:00Z');
    expect(archivedAge('2026-10-15T09:00:00Z', now)).toBe('now');
    expect(archivedAge('2026-10-12T09:00:00Z', now)).toBe('week');
    expect(archivedAge('2026-09-01T09:00:00Z', now)).toBe('older');
    expect(archivedAge('not a date', now)).toBe('now'); // never hidden away as older
  });
});
