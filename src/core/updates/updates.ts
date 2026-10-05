/**
 * Updates and release notes, the pure part (the I/O is update-source.ts):
 * which release is newer, the GitHub Releases answer as notes, and what the
 * dashboard says — "work 2.2.0 is ready · Restart" from the desktop app's
 * updater, the command to run for an npm or git install, and the release
 * notes to show once after an upgrade. Import-free: the SPA and the demo
 * use it too.
 */

/** One release's notes (GitHub Releases: its tag and body). */
export interface ReleaseNote {
  version: string;
  name: string;
  /** Markdown, as written on the release. */
  body: string;
  publishedAt: string;
  url: string;
}

/** How this work was installed, which says how it updates. */
export type InstallKind = 'desktop' | 'npm' | 'dev';

/** The desktop app's updater, as it reports itself (desktop-update.json). */
export interface DesktopUpdate {
  appVersion: string;
  state: 'unmanaged' | 'checking' | 'current' | 'downloading' | 'ready' | 'failed';
  target?: string;
  error?: string;
  at?: number;
}

/** "v2.10.1" → [2, 10, 1]; null for anything that isn't a version. */
export function parseVersion(v: string): number[] | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(v.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** Above 0 when `a` is newer. A pre-release suffix sorts below its release; something that isn't a version is never newer. */
export function compareVersions(a: string, b: string): number {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (!x || !y) return x ? 1 : y ? -1 : 0;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  const pa = /-/.test(a);
  const pb = /-/.test(b);
  return pa === pb ? 0 : pa ? -1 : 1;
}

/**
 * GitHub's `GET /repos/{repo}/releases` answer as notes, newest first:
 * published ones only (no drafts, no pre-releases), each with a version tag.
 */
export function parseReleases(json: unknown): ReleaseNote[] {
  if (!Array.isArray(json)) return [];
  const out: ReleaseNote[] = [];
  for (const r of json as Array<Record<string, unknown>>) {
    if (!r || typeof r !== 'object' || r.draft === true || r.prerelease === true) continue;
    const tag = typeof r.tag_name === 'string' ? r.tag_name : '';
    if (!parseVersion(tag)) continue;
    const version = tag.replace(/^v/, '');
    out.push({
      version,
      name: typeof r.name === 'string' && r.name.trim() ? r.name.trim() : `work ${version}`,
      body: typeof r.body === 'string' ? r.body : '',
      publishedAt: typeof r.published_at === 'string' ? r.published_at : '',
      url: typeof r.html_url === 'string' ? r.html_url : '',
    });
  }
  return out.sort((a, b) => compareVersions(b.version, a.version));
}

/** What an available update asks of you. */
export interface AvailableUpdate {
  version: string;
  /** restart: the desktop app has it; downloading: the app is getting it; command: run this. */
  how: 'restart' | 'downloading' | 'command';
  command?: string;
}

export const NPM_UPDATE = 'npm install -g @moberg_hr/work-tree@latest';
export const DEV_UPDATE = 'git pull && npm install && npm run build';

/**
 * The update to offer, if any. The desktop app's own updater says best
 * (it downloads, then Restart applies); without it, the newest release
 * against the running version, with the command for this install. A dev
 * build ("dev") is never behind.
 */
export function availableUpdate(i: {
  running: string;
  install: InstallKind;
  latest: string | null;
  desktop: DesktopUpdate | null;
}): AvailableUpdate | null {
  const d = i.desktop;
  if (d?.state === 'ready' && d.target && compareVersions(d.target, d.appVersion || i.running) > 0)
    return { version: d.target, how: 'restart' };
  if (d?.state === 'downloading' && d.target) return { version: d.target, how: 'downloading' };
  if (!i.latest || !parseVersion(i.running) || compareVersions(i.latest, i.running) <= 0) return null;
  if (i.install === 'desktop') return { version: i.latest, how: 'downloading' };
  return { version: i.latest, how: 'command', command: i.install === 'npm' ? NPM_UPDATE : DEV_UPDATE };
}

/**
 * The release whose notes to open by themselves, once, after an upgrade:
 * the running version, when it's newer than the one you last saw notes for
 * and it has notes. With none seen yet, only someone who used work before
 * this version gets them (a first install doesn't need "what's new").
 */
export function whatsNewFor(i: { running: string; seen: string | null; usedBefore: boolean; notes: ReleaseNote[] }): string | null {
  if (!parseVersion(i.running)) return null;
  if (i.seen ? compareVersions(i.running, i.seen) <= 0 : !i.usedBefore) return null;
  return i.notes.some((n) => n.version === i.running) ? i.running : null;
}

/** How an install kind is told, from where work's package sits. Pure: paths as given. */
export function installKindOf(packageRoot: string | null, configDir: string, hasGit: boolean): InstallKind {
  if (!packageRoot) return 'npm';
  const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  if (norm(packageRoot).startsWith(`${norm(configDir)}/runtime/`)) return 'desktop';
  return hasGit ? 'dev' : 'npm';
}

/** A desktop-update.json text, shape-checked; null when it isn't one. */
export function parseDesktopUpdate(text: string): DesktopUpdate | null {
  let o: unknown;
  try {
    o = JSON.parse(text);
  } catch {
    return null;
  }
  const d = o as Partial<DesktopUpdate> | null;
  const states = ['unmanaged', 'checking', 'current', 'downloading', 'ready', 'failed'];
  if (!d || typeof d !== 'object' || typeof d.state !== 'string' || !states.includes(d.state)) return null;
  return {
    appVersion: typeof d.appVersion === 'string' ? d.appVersion : '',
    state: d.state,
    ...(typeof d.target === 'string' ? { target: d.target } : {}),
    ...(typeof d.error === 'string' ? { error: d.error } : {}),
    ...(typeof d.at === 'number' ? { at: d.at } : {}),
  };
}
