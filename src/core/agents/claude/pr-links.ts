import type { ConversationPrLink } from '../types.js';

/**
 * The pull requests a stretch of a Claude Code transcript names as its session's: Claude Code writes a
 * `{"type":"pr-link","prNumber":…,"prUrl":…,"prRepository":"owner/name","timestamp":…}` line whenever its session
 * makes a PR or works on one (again each time it looks at it, so one PR has many). Each PR once here, in the order
 * first seen. Lines are looked at only when they mention `pr-link` (a transcript is mostly other lines, megabytes of
 * them); a line that doesn't parse — cut at a chunk's edge — is skipped: the same PR is linked again later. Pure.
 */
export function claudePrLinks(text: string): ConversationPrLink[] {
  const out = new Map<string, ConversationPrLink>();
  let from = 0;
  for (;;) {
    const hit = text.indexOf('"pr-link"', from);
    if (hit < 0) break;
    const start = text.lastIndexOf('\n', hit) + 1;
    const nl = text.indexOf('\n', hit);
    const end = nl < 0 ? text.length : nl;
    from = end + 1;
    let o: unknown;
    try {
      o = JSON.parse(text.slice(start, end));
    } catch {
      continue;
    }
    const e = o as { type?: unknown; prNumber?: unknown; prUrl?: unknown; prRepository?: unknown; timestamp?: unknown } | null;
    if (!e || e.type !== 'pr-link') continue;
    if (typeof e.prUrl !== 'string' || !/^https?:\/\//i.test(e.prUrl) || e.prUrl.length > 500) continue;
    if (typeof e.prNumber !== 'number' || !Number.isInteger(e.prNumber) || e.prNumber <= 0) continue;
    if (out.has(e.prUrl)) continue;
    out.set(e.prUrl, {
      url: e.prUrl,
      number: e.prNumber,
      repo: typeof e.prRepository === 'string' && e.prRepository.length <= 200 ? e.prRepository : '',
      ...(typeof e.timestamp === 'string' && Number.isFinite(Date.parse(e.timestamp)) ? { at: e.timestamp } : {}),
    });
  }
  return [...out.values()];
}
