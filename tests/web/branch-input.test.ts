import { describe, expect, it } from 'vitest';
import { typedBranch } from '../../src/web/src/utils/branch-input.js';

describe('typedBranch (#60: a space in a branch name becomes a dash)', () => {
  it('each run of spaces is one dash, as typed or pasted', () => {
    expect(typedBranch('fix login bug').value).toBe('fix-login-bug');
    expect(typedBranch('fix   login	bug').value).toBe('fix-login-bug');
    expect(typedBranch('feat/new checkout page').value).toBe('feat/new-checkout-page');
  });

  it('dashes around a space fold into it; your own dashes stay', () => {
    expect(typedBranch('fix - login').value).toBe('fix-login');
    expect(typedBranch('fix-- login').value).toBe('fix-login');
    expect(typedBranch('fix--login').value).toBe('fix--login');
  });

  it('a leading space goes (a branch can not start with a dash); a trailing one waits as a dash for the next word', () => {
    expect(typedBranch('  fix').value).toBe('fix');
    expect(typedBranch('fix ').value).toBe('fix-');
  });

  it('the cursor stays where you were typing', () => {
    // "fix |bug" → typed a space after "fix": the cursor after the new dash.
    expect(typedBranch('fix bug', 4)).toEqual({ value: 'fix-bug', caret: 4 });
    // A paste of "a  b" in the middle of "x|y" → "xa  by": the cursor after "a-b".
    expect(typedBranch('xa  by', 5)).toEqual({ value: 'xa-by', caret: 4 });
    expect(typedBranch('fix login').caret).toBe(9);
  });
});
