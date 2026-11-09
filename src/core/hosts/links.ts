import { GITHUB_THREAD_ID, parseGithubPrUrl } from './github/origin.js';
import { AZURE_THREAD_ID, parseAzurePrUrl } from './azure/origin.js';
import { DEFAULT_HOST } from './commands.js';
import type { PrLink } from './types.js';

/**
 * Pull request links of the built-in hosts, read without the registry (which
 * reads git config from disk): pure, so the SPA, the demo and the pure
 * modules (`pr-ref.ts`, `blocks.ts`) share it. A host registered at run time
 * (a test's fake) is read by the registry's `hostOfPrUrl` instead.
 */
const PARSERS: Array<{ host: string; parse: (text: string) => PrLink | null }> = [
  { host: 'github', parse: parseGithubPrUrl },
  {
    host: 'azure',
    parse: (t) => {
      const l = parseAzurePrUrl(t);
      return l ? { repoId: l.repoId, number: l.number, url: l.url, label: l.label } : null;
    },
  },
];

/** A pull request link of a built-in host, read, with the host's id; null for anything else. */
export function parsePrLink(text: string): (PrLink & { host: string }) | null {
  for (const p of PARSERS) {
    const link = p.parse(text);
    if (link) return { ...link, host: p.host };
  }
  return null;
}

const THREAD_IDS: Array<{ host: string; re: RegExp }> = [
  { host: 'github', re: GITHUB_THREAD_ID },
  { host: 'azure', re: AZURE_THREAD_ID },
];

/** The built-in host a review-thread id is shaped for (the UI names it); the default host's for anything else. */
export function threadHostId(id: string): string {
  return THREAD_IDS.find((t) => t.re.test(id))?.host ?? DEFAULT_HOST;
}
