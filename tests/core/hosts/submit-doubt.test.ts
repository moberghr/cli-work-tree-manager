import { describe, expect, it } from 'vitest';
import { refusedClearly } from '../../../src/core/hosts/submit-doubt.js';

describe('a failed host call: a clear refusal, or perhaps carried out', () => {
  it('clear: not installed, never started, a 4xx status or its reason phrase, the host’s own refusal words', () => {
    expect(refusedClearly(127, '')).toBe(true);
    expect(refusedClearly(1, 'az: refused: an argument has "&", which a Windows batch file can\'t be given safely')).toBe(true);
    expect(refusedClearly(1, 'gh: Validation Failed (HTTP 422)')).toBe(true);
    expect(refusedClearly(1, 'HTTP 404: Not Found (https://api.example/x)')).toBe(true);
    expect(refusedClearly(1, 'ERROR: Operation returned an invalid status code 403')).toBe(true);
    expect(refusedClearly(1, "ERROR: Operation returned an invalid status code 'Forbidden'")).toBe(true);
    expect(refusedClearly(1, 'ERROR: status code: 409')).toBe(true);
    expect(refusedClearly(1, 'Unprocessable Entity: line must be part of the diff')).toBe(true);
    expect(refusedClearly(1, 'TF401181: The pull request cannot be edited', /TF401181/)).toBe(true);
  });

  it('in doubt: a timeout, a 5xx, a dropped connection, an error with no status', () => {
    expect(refusedClearly(124, 'HTTP 422')).toBe(false); // timed out: whatever it says
    expect(refusedClearly(1, 'gh: Bad Gateway (HTTP 502)')).toBe(false);
    expect(refusedClearly(1, 'HTTP 504: Gateway Timeout')).toBe(false);
    expect(refusedClearly(1, 'read tcp 10.0.0.1:443: connection reset by peer')).toBe(false);
    expect(refusedClearly(1, 'TF400898: An Internal Error Occurred', /TF401181/)).toBe(false);
    expect(refusedClearly(1, '')).toBe(false);
  });
});
