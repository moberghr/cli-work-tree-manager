import { describe, expect, it } from 'vitest';
import { archivedLine, archivedWhen } from '../../src/web/src/state/archive-view.js';

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
  });
});
