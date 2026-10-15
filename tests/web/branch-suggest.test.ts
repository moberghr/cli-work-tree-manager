import { describe, expect, it } from 'vitest';
import { suggestBranch } from '../../src/web/src/state/branch-suggest.js';

const NOW = new Date(2026, 9, 4, 9, 5); // 4 Oct, 09:05 local

describe('suggestBranch', () => {
  it('a feature by default, without filler and small words', () => {
    expect(suggestBranch('Add CSV export to the invoices endpoint')).toBe('feat/csv-export-invoices');
    expect(suggestBranch('Please implement a dark mode toggle')).toBe('feat/dark-mode-toggle');
  });

  it('a leading word picks the kind', () => {
    expect(suggestBranch('Fix the redirect loop after login')).toBe('fix/redirect-loop-login');
    expect(suggestBranch('Please fix the login bug')).toBe('fix/login');
    expect(suggestBranch('Can you update express and zod')).toBe('chore/express-zod');
    expect(suggestBranch('Refactor the ledger into modules')).toBe('refactor/ledger-modules');
    expect(suggestBranch('Document the release steps')).toBe('docs/release-steps');
    expect(suggestBranch('Fix the build')).toBe('fix/build');
  });

  it('prompts as they come (real ones): the gist, not the first three words', () => {
    expect(suggestBranch('we should put version of warp running in dashboard somewhere')).toBe('feat/version-warp-dashboard');
    expect(suggestBranch('we get failures when we get duplicate sdr files webhook from adyen, can we somehow inspect this')).toBe(
      'fix/duplicate-sdr-files',
    );
    expect(suggestBranch('fix failing build for cryptography package')).toBe('fix/build-cryptography-package');
    expect(suggestBranch('kortalan transactions should be classified as credit, not debit')).toBe('feat/kortalan-transactions-classified');
  });

  it('a question or an investigation is something to look into: tmp/', () => {
    expect(suggestBranch('What reports do we process from adyen into our own tables')).toBe('tmp/reports-process-adyen');
    expect(suggestBranch('check why queue creates settlements job failed twice over weekend')).toBe('tmp/queue-creates-settlements');
    expect(suggestBranch('we have payment P-496079-31-A not reported to accounting, why is that?')).toBe('tmp/payment-reported-accounting');
    expect(suggestBranch('give me numbers about straumur per month')).toBe('tmp/numbers-straumur-month');
    // Croatian too.
    expect(suggestBranch('mozete provjeriti autorizaciju sa referencom JVRN7KPJD45NXVQ9?')).toBe('tmp/autorizaciju-referencom');
  });

  it('a Jira issue is its own branch, as Jira’s Start makes it', () => {
    expect(suggestBranch('https://kvika.atlassian.net/browse/SSD-2493')).toBe('feat/SSD-2493');
    expect(suggestBranch('Look at SD-3937 and the note it mentions')).toBe('feat/SD-3937');
  });

  it('a pasted exception names what broke; a URL by its last named part; code and ids left out', () => {
    expect(suggestBranch('System.InvalidOperationException: An exception has been raised that is likely due to a transient failure.')).toBe(
      'fix/invalid-operation-exception',
    );
    expect(suggestBranch('https://admin-api.straumur.is/api/authorizations?contractId=133211&page=0 is slow')).toBe(
      'feat/authorizations-slow',
    );
    expect(suggestBranch('check cloudwatch, ISettlementJobs.TransferSettlementPayment take like 1 minute each')).toBe(
      'tmp/cloudwatch-minute',
    );
  });

  it('safe characters: accents folded, đ/ß spelled out, no stray hyphens', () => {
    expect(suggestBranch('Support émojis & "quotes" in titles')).toBe('feat/emojis-quotes-titles');
    expect(suggestBranch('Uređivanje računa')).toBe('feat/uredivanje-racuna');
    expect(suggestBranch('Straße names')).toBe('feat/strasse-names');
    expect(suggestBranch('- fix login redirect')).toBe('fix/login-redirect'); // a pasted bullet
    expect(suggestBranch('a'.repeat(20) + ' ' + 'b'.repeat(20) + ' ' + 'c'.repeat(20))).toBe(`feat/${'a'.repeat(20)}-${'b'.repeat(19)}`);
  });

  it('the first line with text, three words at most, each once', () => {
    expect(suggestBranch('\n\n  Fix login\nand more on the next line')).toBe('fix/login');
    expect(suggestBranch("Let's make the PDF generation way faster than before")).toBe('feat/pdf-generation-faster');
    expect(suggestBranch('lets investigate process authorization and process transaction commands')).toBe(
      'tmp/process-authorization-transaction', // investigating: something to look into
    );
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
