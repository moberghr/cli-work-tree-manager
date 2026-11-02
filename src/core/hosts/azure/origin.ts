import type { PrLink } from '../types.js';

/**
 * Azure DevOps origins, pull request links and review-thread ids. Pure and
 * import-free (types only): the SPA reads links and thread ids with it too
 * (`core/hosts/links.ts`).
 *
 * A repo is `org/project/repo` (lower case: its id here). Origins:
 *   https://dev.azure.com/{org}/{project}/_git/{repo}   (also `{user}@dev.azure.com`)
 *   https://{org}.visualstudio.com/[DefaultCollection/]{project}/_git/{repo}
 *   git@ssh.dev.azure.com:v3/{org}/{project}/{repo}
 *   {org}@vs-ssh.visualstudio.com:v3/{org}/{project}/{repo}
 */

export interface AzureRepo {
  org: string;
  project: string;
  repo: string;
  /** The org's URL, as `az --org` takes it. */
  orgUrl: string;
}

const dec = (s: string) => {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
};
const strip = (s: string) => s.replace(/\.git$/, '').replace(/\/+$/, '');

/** An origin on Azure DevOps, read; null for anything else. */
export function parseAzureOrigin(origin: string): AzureRepo | null {
  const o = origin.trim();
  let m = /^https?:\/\/(?:[^@/]+@)?dev\.azure\.com\/([^/]+)\/([^/]+)\/_git\/([^/?#]+)/i.exec(o);
  if (m) return { org: dec(m[1]), project: dec(m[2]), repo: dec(strip(m[3])), orgUrl: `https://dev.azure.com/${m[1]}` };
  m = /^https?:\/\/(?:[^@/]+@)?([^./]+)\.visualstudio\.com\/(?:DefaultCollection\/)?([^/]+)\/_git\/([^/?#]+)/i.exec(o);
  if (m) return { org: dec(m[1]), project: dec(m[2]), repo: dec(strip(m[3])), orgUrl: `https://${m[1]}.visualstudio.com` };
  m = /^(?:ssh:\/\/)?[^@]+@ssh\.dev\.azure\.com[:/]v3\/([^/]+)\/([^/]+)\/([^/]+)$/i.exec(o);
  if (m) return { org: dec(m[1]), project: dec(m[2]), repo: dec(strip(m[3])), orgUrl: `https://dev.azure.com/${m[1]}` };
  m = /^(?:ssh:\/\/)?[^@]+@vs-ssh\.visualstudio\.com[:/]v3\/([^/]+)\/([^/]+)\/([^/]+)$/i.exec(o);
  if (m) return { org: dec(m[1]), project: dec(m[2]), repo: dec(strip(m[3])), orgUrl: `https://${m[1]}.visualstudio.com` };
  return null;
}

/** An origin on Azure DevOps. */
export const onAzure = (origin: string) => parseAzureOrigin(origin) !== null;

/** `org/project/repo` (lower case) of an Azure DevOps origin; null for another host. */
export function azureRepoId(origin: string): string | null {
  const r = parseAzureOrigin(origin);
  return r ? `${r.org}/${r.project}/${r.repo}`.toLowerCase() : null;
}

/** The repo's web address (its PRs live under `/pullrequest/<id>`). */
export function azureWebUrl(r: Pick<AzureRepo, 'orgUrl' | 'project' | 'repo'>): string {
  return `${r.orgUrl}/${encodeURIComponent(r.project)}/_git/${encodeURIComponent(r.repo)}`;
}

/** An Azure DevOps pull request link (any tail); null for anything else. */
export function parseAzurePrUrl(text: string): (PrLink & { repo: AzureRepo }) | null {
  const t = text.trim();
  const m = /^(https?:\/\/[^?#]+\/_git\/[^/?#]+)\/pullrequest\/(\d+)(?:[/?#].*)?$/i.exec(t);
  if (!m) return null;
  const repo = parseAzureOrigin(m[1]);
  if (!repo) return null;
  const number = Number(m[2]);
  return {
    repoId: `${repo.org}/${repo.project}/${repo.repo}`.toLowerCase(),
    number,
    url: `${azureWebUrl(repo)}/pullrequest/${number}`,
    label: `${repo.repo}!${number}`,
    repo,
  };
}

/**
 * A review thread's id here: Azure DevOps numbers threads per pull request,
 * so the id carries where it is — `AZT_<org/project/repo, base64url>_<pr>_<thread>` —
 * and any thread can be answered from any folder, like GitHub's global ids.
 */
export const AZURE_THREAD_ID = /^AZT_[A-Za-z0-9_-]{2,400}_\d{1,9}_\d{1,9}$/;

const b64url = (s: string) => {
  const bytes = new TextEncoder().encode(s);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
const unb64url = (s: string) => {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
};

export function azureThreadId(r: Pick<AzureRepo, 'orgUrl' | 'project' | 'repo'>, pr: number, thread: number): string {
  return `AZT_${b64url(JSON.stringify([r.orgUrl, r.project, r.repo]))}_${pr}_${thread}`;
}

/** A thread id read back: its repo, PR and thread; null when it isn't one. */
export function parseAzureThreadId(
  id: string,
): { repo: Pick<AzureRepo, 'orgUrl' | 'project' | 'repo'>; pr: number; thread: number } | null {
  if (!AZURE_THREAD_ID.test(id)) return null;
  const m = /^AZT_(.+)_(\d+)_(\d+)$/.exec(id);
  if (!m) return null;
  try {
    const v: unknown = JSON.parse(unb64url(m[1]));
    if (!Array.isArray(v) || v.length !== 3 || !v.every((x) => typeof x === 'string')) return null;
    return { repo: { orgUrl: v[0] as string, project: v[1] as string, repo: v[2] as string }, pr: Number(m[2]), thread: Number(m[3]) };
  } catch {
    return null;
  }
}
