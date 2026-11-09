import type { RepoSettingsWire, SettingsWire } from '../api-types.js';

/** Where the settings routes read and write: work web's is config.json (settings-admin.ts); the demo's, its own in memory. */
export interface SettingsSource {
  read(): SettingsWire;
  write(path: string, value: unknown): Promise<SettingsWire>;
  readRepo(alias: string): RepoSettingsWire;
  writeRepo(alias: string, key: string, value: unknown): Promise<RepoSettingsWire>;
}
