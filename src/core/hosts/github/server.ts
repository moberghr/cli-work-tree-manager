import type { CommandRunner } from '../../platform/command-runner.js';
import { originUrl, readGitConfig } from '../../worktree/repo-scan.js';
import { originHostname } from '../origin-hostname.js';
import { onGithub } from './origin.js';

/**
 * Which GitHub server a repo is on, for every `gh api` call made in it. `gh pr …` and `gh repo …` follow the
 * repo (gh reads its remotes, SSH aliases through `~/.ssh/config`), but `gh api` asks github.com unless told
 * `--hostname`, whatever repo it runs in: a GitHub Enterprise repo's review read, thread replies and review
 * would go to github.com (or fail there), and who you are would be github.com's login.
 *
 * The server is asked of gh, never guessed from the name's shape (a dotted SSH alias of github.com,
 * `git@github.com-work:`, is no server; a dotless GitHub Enterprise host, `ghe`, is one):
 * `gh repo view --json url` in the repo — gh resolves the remote only to a host it's signed in to, so an
 * answer names a server gh can ask. An origin that names github.com isn't asked. Cached per repo folder and
 * origin; a failed lookup for `FAILED_LOOKUP_MS`, so a sweep doesn't ask again each time.
 */

/** `[]` on github.com, `['--hostname', <server>]` elsewhere; or why the server isn't known (nothing is asked then). */
export type ServerArgs = { ok: true; args: string[] } | { ok: false; error: string };

/** How long a lookup that failed stands before gh is asked again. */
export const FAILED_LOOKUP_MS = 5 * 60_000;

const HOSTNAME = /^[a-z0-9][a-z0-9.-]*$/;

interface Known {
  value: ServerArgs;
  /** Asked again after this (ms); Infinity for an answer. */
  until: number;
}
const known = new Map<string, Known>();
const asking = new Map<string, Promise<ServerArgs>>();

/** Forget every lookup (tests). */
export function clearGithubServers(): void {
  known.clear();
  asking.clear();
}

export interface ServerDeps {
  readConfig?: (repoPath: string) => string | null;
  now?: () => number;
}

/** The server gh resolves for the repo at `cwd`: what every `gh api` there is given. */
export async function githubServerArgs(run: CommandRunner, cwd: string, deps: ServerDeps = {}): Promise<ServerArgs> {
  const text = (deps.readConfig ?? readGitConfig)(cwd);
  const origin = text ? originUrl(text) : null;
  // No repo or no origin (a temp folder, a group's root): gh api's own default, as gh pr would have none either.
  if (!origin || onGithub(origin)) return { ok: true, args: [] };
  const now = deps.now ?? Date.now;
  const key = `${cwd}\n${origin}`;
  const was = known.get(key);
  if (was && now() < was.until) return was.value;
  const inflight = asking.get(key);
  if (inflight) return inflight;
  const p = lookUp(run, cwd, origin)
    .then((value) => {
      known.set(key, { value, until: value.ok ? Infinity : now() + FAILED_LOOKUP_MS });
      return value;
    })
    .finally(() => asking.delete(key));
  asking.set(key, p);
  return p;
}

async function lookUp(run: CommandRunner, cwd: string, origin: string): Promise<ServerArgs> {
  const r = await run('gh', ['repo', 'view', '--json', 'url', '--jq', '.url'], cwd).catch(() => null);
  const url = r?.code === 0 ? r.stdout.trim() : '';
  const server = url ? originHostname(url) : null;
  if (!server || !HOSTNAME.test(server)) {
    const why = r?.stderr.trim().split('\n')[0] || 'gh gave no answer';
    return { ok: false, error: `couldn't tell which GitHub server ${originHostname(origin) ?? origin} is (${why})` };
  }
  return { ok: true, args: server === 'github.com' ? [] : ['--hostname', server] };
}

/** `gh api <args>` on the repo's own server; a failed run (code 1, the reason in stderr) when it isn't known. */
export async function ghApi(run: CommandRunner, cwd: string, args: string[], deps?: ServerDeps) {
  const server = await githubServerArgs(run, cwd, deps);
  if (!server.ok) return { code: 1, stdout: '', stderr: server.error, serverUnknown: true as const };
  return run('gh', ['api', ...args, ...server.args], cwd);
}
