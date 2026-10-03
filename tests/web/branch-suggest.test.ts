import { describe, expect, it } from 'vitest';
import { suggestBranch } from '../../src/web/src/state/branch-suggest.js';

describe('suggestBranch', () => {
  it('a feature by default, without filler verbs and small words', () => {
    expect(suggestBranch('Add CSV export to the invoices endpoint')).toBe('feat/csv-export-invoices');
    expect(suggestBranch('Please implement a dark mode toggle')).toBe('feat/dark-mode-toggle');
  });

  it('the first word picks the kind', () => {
    expect(suggestBranch('Fix the redirect loop after login')).toBe('fix/redirect-loop-after');
    expect(suggestBranch('Update express and zod')).toBe('chore/express-zod');
    expect(suggestBranch('Refactor the ledger into modules')).toBe('refactor/ledger-modules');
    expect(suggestBranch('Document the release steps')).toBe('docs/release-steps');
  });

  it('keeps it to the first line, safe characters and a sane length', () => {
    expect(suggestBranch('Support émojis & "quotes" in titles\nand more on the second line')).toBe('feat/emojis-quotes-titles');
    expect(suggestBranch("Let's make the PDF generation way faster than before")).toBe('feat/pdf-generation-way');
    expect(suggestBranch('a'.repeat(60))).toBe(`feat/${'a'.repeat(40)}`);
  });

  it('nothing to go on: nothing', () => {
    expect(suggestBranch('')).toBe('');
    expect(suggestBranch('   ')).toBe('');
    expect(suggestBranch('the a an')).toBe('');
  });
});
