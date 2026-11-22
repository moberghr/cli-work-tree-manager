import type { RepoSettingsWire, SettingsWire } from '../api-types.js';

/** Where the settings routes read and write: work web's is config.json (settings-admin.ts); the demo's, its own in memory. */
export interface SettingsSource {
  read(): SettingsWire;
  write(path: string, value: unknown): Promise<SettingsWire>;
  readRepo(alias: string): RepoSettingsWire;
  writeRepo(alias: string, key: string, value: unknown): Promise<RepoSettingsWire>;
}

/** `source`, its reads saying whether the user has a status line of their own (`SettingsWire.ownStatusLine`). */
export function withOwnStatusLine(source: SettingsSource, own: () => boolean): SettingsSource {
  return { ...source, read: () => ({ ...source.read(), ownStatusLine: own() }) };
}
