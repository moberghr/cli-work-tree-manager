import fs from 'node:fs';
import { getConfigPath } from '../platform/config.js';
import { editConfig, RepoAdminError } from '../worktree/repo-admin.js';
import path from 'node:path';
import { hostForRepo } from '../hosts/index.js';
import { chooseWorktreesRoot, expandHome } from '../worktree/worktrees-root.js';
import { hostName } from '../hosts/commands.js';
import type { RepoSettingsWire, SettingsWire } from '../api-types.js';
import type { SettingsSource } from './settings-source.js';
import {
  checkRepoSetting,
  checkSetting,
  REPO_SETTING_PATH,
  repoSettingsOf,
  setValueAt,
  settingAt,
  SETTINGS,
  SettingsError,
  valueAt,
  type RepoSettingKey,
} from './settings-schema.js';

export { SettingsError };

/**
 * The Settings page and a repo's settings, over config.json (settings-schema.ts says which settings and how each is
 * checked). Read from the file as it is — so a setting not written reads as its default, not as a value — and only
 * the schema's settings ever leave it: nothing else in config.json (a token) reaches the page. Written one setting at
 * a time under config.json's lock, keys the schema doesn't know kept (repo-admin.ts `editConfig`).
 */

/** config.json as JSON; {} when there is none or it doesn't read. */
function rawConfig(file = getConfigPath()): Record<string, unknown> {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf-8')) as unknown;
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** What the Settings page shows: each setting written in config.json, by its path (the rest are their defaults). */
export function readSettings(): SettingsWire {
  const raw = rawConfig();
  const values: Record<string, unknown> = {};
  for (const f of SETTINGS) {
    const v = valueAt(raw, f.path);
    if (v !== undefined) values[f.path] = v;
  }
  return { values, configPath: getConfigPath() };
}

/** Change one setting (`null`: back to its default). Refused: a path not on the page, a value that doesn't fit. */
export async function writeSetting(path: string, value: unknown): Promise<SettingsWire> {
  const field = settingAt(path);
  if (!field) throw new SettingsError(`no setting ${path}`, 404);
  const checked = checkSetting(field, value);
  if (!checked.ok) throw new SettingsError(`${field.label}: ${checked.error}`);
  const toWrite = checkedFolders(path, checked.value);
  await editConfig((raw) => setValueAt(raw, path, toWrite)).catch((err: unknown) => {
    throw err instanceof RepoAdminError ? new SettingsError(err.message) : err;
  });
  return readSettings();
}

/**
 * The folders as `work init` takes them: `~` for the home folder, a full path, made (the worktrees folder) or there
 * (a folder to scan). Others are as checked. Throws why not.
 */
function checkedFolders(at: string, value: unknown): unknown {
  if (at === 'worktreesRoot' && typeof value === 'string') {
    const got = chooseWorktreesRoot(value);
    if ('problem' in got) throw new SettingsError(`Worktrees folder: ${got.problem}`);
    return got.root;
  }
  if (at === 'scanRoots' && Array.isArray(value))
    return value.map((v: string) => {
      const p = expandHome(v);
      if (!path.isAbsolute(p))
        throw new SettingsError(`Folders scanned for repos: ${v} isn't a full path (start it from the drive, / or ~)`);
      const full = path.resolve(p);
      if (!fs.statSync(full, { throwIfNoEntry: false })?.isDirectory())
        throw new SettingsError(`Folders scanned for repos: ${full} isn't a folder`);
      return full;
    });
  return value;
}

/** A repo's origin without what it may carry to sign in (`https://user:token@host/…`): never on the page. Pure. */
export function originShown(origin: string | null): string | null {
  if (!origin) return null;
  return origin.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/@]*@/i, '$1');
}

/** A repo's settings, with what is known of it (its folder, origin and host). */
export function readRepoSettings(alias: string): RepoSettingsWire {
  const raw = rawConfig();
  const repos = valueAt(raw, 'repos');
  // Own keys only: `constructor` isn't a repo.
  const repoPath =
    repos && typeof repos === 'object' && Object.hasOwn(repos, alias) ? (repos as Record<string, unknown>)[alias] : undefined;
  if (typeof repoPath !== 'string') throw new SettingsError(`${alias} isn't one of your repos`, 404);
  let origin: string | null = null;
  let host: string | null = null;
  try {
    const found = hostForRepo(repoPath);
    origin = originShown(found.origin);
    host = hostName(found.host.id);
  } catch {
    /* a folder that's gone: its settings still show */
  }
  return { alias, path: repoPath, origin, host, ...repoSettingsOf(raw, alias) };
}

/** Change one of a repo's settings (`null`: take it out). */
export async function writeRepoSetting(alias: string, key: string, value: unknown): Promise<RepoSettingsWire> {
  if (!Object.hasOwn(REPO_SETTING_PATH, key)) throw new SettingsError(`no repo setting ${key}`, 404);
  const k = key as RepoSettingKey;
  const checked = checkRepoSetting(k, value);
  if (!checked.ok) throw new SettingsError(checked.error);
  await editConfig((raw) => {
    if (!raw.repos || !Object.hasOwn(raw.repos, alias) || !raw.repos[alias]) throw new RepoAdminError(`${alias} isn't one of your repos`);
    // The map under its path, keyed by the alias (not a dotted path: an alias may hold a dot).
    const at = valueAt(raw, REPO_SETTING_PATH[k]);
    const map = at && typeof at === 'object' && !Array.isArray(at) ? { ...(at as Record<string, unknown>) } : {};
    if (checked.value === null) delete map[alias];
    else map[alias] = checked.value;
    setValueAt(raw, REPO_SETTING_PATH[k], Object.keys(map).length ? map : null);
  }).catch((err: unknown) => {
    throw err instanceof RepoAdminError ? new SettingsError(err.message, 404) : err;
  });
  return readRepoSettings(alias);
}

/** work web's settings: config.json. */
export const configSettings: SettingsSource = {
  read: readSettings,
  write: writeSetting,
  readRepo: readRepoSettings,
  writeRepo: writeRepoSetting,
};
