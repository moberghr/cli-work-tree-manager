import { describe, expect, it } from 'vitest';
import { suggestBranch } from '../../src/web/src/state/branch-suggest.js';

const NOW = new Date(2026, 9, 4, 9, 5); // 4 Oct, 09:05 local

describe('suggestBranch', () => {
  it('a feature by default, without filler and small words', () => {
    expect(suggestBranch('Add CSV export to the invoices endpoint')).toBe('feat/csv-export-invoices');
    expect(suggestBranch('Please implement a dark mode toggle')).toBe('feat/dark-mode-toggle');
  });

  it('the first word after the filler picks the kind', () => {
    expect(suggestBranch('Fix the redirect loop after login')).toBe('fix/redirect-loop-after');
    expect(suggestBranch('Please fix the login bug')).toBe('fix/login-bug');
    expect(suggestBranch('Can you update express and zod')).toBe('chore/express-zod');
    expect(suggestBranch('Refactor the ledger into modules')).toBe('refactor/ledger-modules');
    expect(suggestBranch('Document the release steps')).toBe('docs/release-steps');
    // Filler only counts at the start: "build" is the subject here.
    expect(suggestBranch('Fix the build')).toBe('fix/build');
  });

  it('safe characters: accents folded, đ/ß spelled out, no stray hyphens', () => {
    expect(suggestBranch('Support émojis & "quotes" in titles')).toBe('feat/emojis-quotes-titles');
    expect(suggestBranch('Uređivanje računa')).toBe('feat/uredivanje-racuna');
    expect(suggestBranch('Straße names')).toBe('feat/strasse-names');
    expect(suggestBranch('- fix login redirect')).toBe('fix/login-redirect'); // a pasted bullet
    expect(suggestBranch('fix a - b')).toBe('fix/b');
    expect(suggestBranch('a'.repeat(60))).toBe(`feat/${'a'.repeat(40)}`);
  });

  it('the first line with text, three words at most', () => {
    expect(suggestBranch('\n\n  Fix login\nand more on the next line')).toBe('fix/login');
    expect(suggestBranch("Let's make the PDF generation way faster than before")).toBe('feat/pdf-generation-way');
  });

  it('a prompt with nothing to name it by still gets a branch of its own', () => {
    expect(suggestBranch('Implement this', NOW)).toBe('feat/work-1004-0905');
    expect(suggestBranch('Fix -', NOW)).toBe('fix/work-1004-0905');
    expect(suggestBranch('Исправь логин', NOW)).toBe('feat/work-1004-0905');
    expect(suggestBranch('the a an', NOW)).toBe('feat/work-1004-0905');
  });

  it('no prompt: no branch (the project as it is)', () => {
    expect(suggestBranch('')).toBe('');
    expect(suggestBranch('  \n ')).toBe('');
  });
});
