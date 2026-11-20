import type { PrLink } from '../types.js';

/**
 * GitHub origins and pull request links. Pure and import-free (types only):
 * the SPA reads PR links with it too (`core/hosts/links.ts`).
 */

/** GitHub review-thread node ids. Checked before a thread id reaches gh or the database. */
export const GITHUB_THREAD_ID = /^PRRT_[A-Za-z0-9_-]{4,120}$/;

/** An origin on github.com (https, ssh or git@ form). */
export function onGithub(origin: string): boolean {
  return /(^|[@/.])github\.com[:/]/i.test(origin);
}

/** `owner/name` (lower case) of an origin on github.com; null for another host. */
export function githubRepoId(origin: string): string | null {
  if (!onGithub(origin)) return null;
  const m = /[:/]([^/:]+)\/([^/]+?)(?:\.git)?\/?$/.exec(origin.trim());
  return m ? `${m[1]}/${m[2]}`.toLowerCase() : null;
}

/** A GitHub pull request link (`https://github.com/owner/repo/pull/123`, any tail, scheme optional); null for anything else. */
export function parseGithubPrUrl(text: string): PrLink | null {
  const m = /^(?:https?:\/\/)?(?:www\.)?github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)(?:[/?#].*)?$/i.exec(text.trim());
  if (!m) return null;
  const number = Number(m[3]);
  return {
    repoId: `${m[1]}/${m[2]}`.toLowerCase(),
    number,
    url: `https://github.com/${m[1]}/${m[2]}/pull/${number}`,
    label: `${m[2]}#${number}`,
  };
}
