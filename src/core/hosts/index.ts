import { originUrl, readGitConfig } from '../worktree/repo-scan.js';
import { configView } from '../platform/config-cache.js';
import { addCommands, DEFAULT_HOST } from './commands.js';
import { github } from './github/adapter.js';
import type { GitHost } from './types.js';

export type { GitHost } from './types.js';
export { DEFAULT_HOST } from './commands.js';

/**
 * The hosts work knows, and which one a repo is on. Like the agent registry
 * (core/agents/index.ts): built-in adapters plus any registered at run time
 * (tests' fake host), looked up by id or by a repo's origin.
 *
 * A repo is on the host whose adapter claims its origin. Config `gitHosts`
 * names the host for an origin's hostname the URL can't tell
 * (`{"git.corp.example": "github"}`: GitHub Enterprise, Azure DevOps
 * Server). A repo nobody claims — no origin, another server — is asked as
 * GitHub, as before hosts existed: `gh` itself says whether it knows it.
 */

const builtIn: GitHost[] = [github];
const registered: GitHost[] = [];

/** Every host: registered ones first (a test's fake host can claim an origin before GitHub's adapter does). */
export function knownHosts(): GitHost[] {
  return [...registered, ...builtIn];
}

export function hostById(id: string | null | undefined): GitHost | null {
  return knownHosts().find((h) => h.id === id) ?? null;
}

/** The default host's adapter (GitHub). */
export function defaultHost(): GitHost {
  return hostById(DEFAULT_HOST) ?? github;
}

/** Add a host (a test's fake, a future adapter). Returns its removal. */
export function registerHost(host: GitHost): () => void {
  registered.unshift(host);
  const dropCommands = addCommands(host.id, host.commands);
  return () => {
    const i = registered.indexOf(host);
    if (i >= 0) registered.splice(i, 1);
    dropCommands();
  };
}

/** Config `gitHosts`: an origin hostname (lower case) → a host id. Bad entries are dropped. */
const overrides = configView((raw) => {
  const out = new Map<string, string>();
  const v = raw?.gitHosts;
  if (v && typeof v === 'object' && !Array.isArray(v))
    for (const [k, id] of Object.entries(v as Record<string, unknown>)) if (typeof id === 'string') out.set(k.toLowerCase(), id);
  return out;
});

/** An origin URL's hostname, lower case (https, ssh://, and scp-like `git@host:path`); null when it has none. Pure. */
export function originHostname(origin: string): string | null {
  const s = origin.trim();
  const url = /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/]*@)?([^/:]+)/i.exec(s);
  if (url) return url[1].toLowerCase();
  const scp = /^(?:[^@/]+@)?([^/:]+):(?!\/\/)/.exec(s);
  return scp ? scp[1].toLowerCase() : null;
}

export interface HostLookupDeps {
  /** A repo's git config text (tests pass their own). */
  gitConfig?: (repoPath: string) => string | null;
  /** Config `gitHosts` (tests pass their own). */
  overrides?: () => Map<string, string>;
}

/** The host an origin is on: the config's word for its hostname, else the adapter that claims it, else the default. */
export function hostForOrigin(origin: string | null, deps: Pick<HostLookupDeps, 'overrides'> = {}): GitHost {
  if (origin) {
    const name = originHostname(origin);
    const named = name ? hostById((deps.overrides ?? overrides)().get(name)) : null;
    if (named) return named;
    const claimed = knownHosts().find((h) => h.matches(origin));
    if (claimed) return claimed;
  }
  return defaultHost();
}

/** The host a repo (or a worktree of it) is on, from its origin; with the origin, for the host's list. */
export function hostForRepo(repoPath: string, deps: HostLookupDeps = {}): { host: GitHost; origin: string | null } {
  const text = (deps.gitConfig ?? readGitConfig)(repoPath);
  const origin = text ? originUrl(text) : null;
  return { host: hostForOrigin(origin, deps), origin };
}

/** The host whose review-thread ids look like this one (ids are each host's own shape); null for none. */
export function hostOfThread(id: string): GitHost | null {
  return knownHosts().find((h) => h.threads.isId(id)) ?? null;
}

/** The host a pull request link is on, and the link read; null when no host reads it. */
export function hostOfPrUrl(text: string): { host: GitHost; link: NonNullable<ReturnType<GitHost['parsePrUrl']>> } | null {
  for (const host of knownHosts()) {
    const link = host.parsePrUrl(text);
    if (link) return { host, link };
  }
  return null;
}
