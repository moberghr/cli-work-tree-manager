import { describe, expect, it } from 'vitest';
import { parsePrRef, workOnPrPrompt } from '../../../src/core/pr/pr-ref.js';

describe('parsePrRef', () => {
  it('reads a PR link, with or without scheme, tail or query, the repo lowercased', () => {
    expect(parsePrRef('https://github.com/Moberg/Backend/pull/1927')).toEqual({ repo: 'moberg/backend', number: 1927 });
    expect(parsePrRef('  github.com/acme/api/pull/12/files?w=1 ')).toEqual({ repo: 'acme/api', number: 12 });
    expect(parsePrRef('https://www.github.com/acme/api/pull/7#discussion_r1')).toEqual({ repo: 'acme/api', number: 7 });
  });

  it('reads a bare number or #number, with no repo', () => {
    expect(parsePrRef('#42')).toEqual({ number: 42 });
    expect(parsePrRef('42')).toEqual({ number: 42 });
  });

  it('refuses anything else', () => {
    for (const bad of ['', '#', '#0', 'abc', 'https://github.com/acme/api/issues/3', 'https://gitlab.com/a/b/pull/3', '12a'])
      expect(parsePrRef(bad)).toBeNull();
  });
});

describe('workOnPrPrompt', () => {
  it('says whose branch it is, that pushes land in their PR, to get up to speed and wait, and to post nothing', () => {
    const text = workOnPrPrompt({ number: 12, title: 'Add export', url: 'https://github.com/acme/api/pull/12', author: 'ana' });
    expect(text.split('\n')[0]).toBe('Work on PR #12 by @ana: Add export');
    expect(text).toContain('https://github.com/acme/api/pull/12');
    expect(text).toContain("@ana's branch: what you commit and push lands in their PR");
    expect(text).toContain('gh pr diff 12');
    expect(text).toContain('wait for what I want done');
    expect(text).toContain("Don't post on GitHub");
  });

  it('with an instruction: up to speed, then that (no waiting)', () => {
    const text = workOnPrPrompt({ number: 12, title: 't', url: 'u', author: 'ana' }, '  fix the tests  ');
    expect(text).toContain('gh pr diff 12), then:\n\nfix the tests\n');
    expect(text).not.toContain('wait for what I want done');
    expect(text).toContain("Don't post on GitHub");
    expect(workOnPrPrompt({ number: 12, title: 't', url: 'u' }, '   ')).toContain('wait for what I want done');
  });

  it('names no one when the author is unknown', () => {
    expect(workOnPrPrompt({ number: 3, title: 't', url: 'u' })).toContain("its author's branch");
  });
});
