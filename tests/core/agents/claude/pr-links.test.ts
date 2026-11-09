import { describe, expect, it } from 'vitest';
import { claudePrLinks } from '../../../../src/core/agents/claude/pr-links.js';

const line = (o: Record<string, unknown>) => JSON.stringify(o);
const link = (n: number, repo = 'kvika/straumur-backend', at = '2026-11-04T10:00:00.000Z') =>
  line({ type: 'pr-link', sessionId: 's', prNumber: n, prUrl: `https://github.com/${repo}/pull/${n}`, prRepository: repo, timestamp: at });

describe("Claude Code's pr-link lines: the PRs a session made or worked on", () => {
  it('each PR once, in the order first seen, among the other lines', () => {
    const text = [
      line({ type: 'user', message: { content: 'open a PR for pull/1 please' } }),
      link(3592),
      line({ type: 'assistant', message: { content: [{ type: 'text', text: 'Opened https://github.com/x/y/pull/9' }] } }),
      link(3592, 'kvika/straumur-backend', '2026-11-05T00:00:00.000Z'),
      link(87, 'kvika/straumur-documentation'),
    ].join('\n');
    expect(claudePrLinks(text)).toEqual([
      {
        url: 'https://github.com/kvika/straumur-backend/pull/3592',
        number: 3592,
        repo: 'kvika/straumur-backend',
        at: '2026-11-04T10:00:00.000Z',
      },
      {
        url: 'https://github.com/kvika/straumur-documentation/pull/87',
        number: 87,
        repo: 'kvika/straumur-documentation',
        at: '2026-11-04T10:00:00.000Z',
      },
    ]);
  });

  it('a line cut at either end, or one that only mentions pr-link, is skipped', () => {
    const whole = link(3657);
    const text = [
      whole.slice(20),
      line({ type: 'user', message: { content: 'what is a "pr-link"?' } }),
      link(3656),
      whole.slice(0, 40),
    ].join('\n');
    expect(claudePrLinks(text).map((l) => l.number)).toEqual([3656]);
  });

  it('a malformed entry is skipped: no http link, no whole positive number', () => {
    const text = [
      line({ type: 'pr-link', prNumber: 5, prUrl: 'javascript:alert(1)' }),
      line({ type: 'pr-link', prNumber: 1.5, prUrl: 'https://github.com/a/b/pull/1' }),
      line({ type: 'pr-link', prNumber: 6, prUrl: 'https://github.com/a/b/pull/6' }),
    ].join('\n');
    expect(claudePrLinks(text)).toEqual([{ url: 'https://github.com/a/b/pull/6', number: 6, repo: '' }]);
  });
});
