/**
 * An origin URL's hostname, lower case (https, ssh://, and scp-like `git@host:path`); null when it has none.
 * Pure and import-free: the registry reads `gitHosts` by it, and a host's adapter which server to ask
 * (GitHub's: a GitHub Enterprise origin's `gh api --hostname`).
 */
export function originHostname(origin: string): string | null {
  const s = origin.trim();
  const url = /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/]*@)?([^/:]+)/i.exec(s);
  if (url) return url[1].toLowerCase();
  const scp = /^(?:[^@/]+@)?([^/:]+):(?!\/\/)/.exec(s);
  return scp ? scp[1].toLowerCase() : null;
}
