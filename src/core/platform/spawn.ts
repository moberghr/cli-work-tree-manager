import { createRequire } from 'node:module';
import type CrossSpawnModule from 'cross-spawn';

/**
 * cross-spawn, loaded on first use. core's modules all spawn through it, and
 * importing it up front put it (and its dependencies) on every `work hook`
 * — which runs twice per turn of every Claude — whether the hook spawned
 * anything or not. Same function, same `.sync`.
 */
type CrossSpawn = typeof CrossSpawnModule;

let loaded: CrossSpawn | null = null;
const load = (): CrossSpawn => (loaded ??= createRequire(import.meta.url)('cross-spawn') as CrossSpawn);

const spawn = Object.assign((...args: unknown[]) => (load() as unknown as (...a: unknown[]) => unknown)(...args), {
  sync: (...args: unknown[]) => (load().sync as unknown as (...a: unknown[]) => unknown)(...args),
}) as unknown as CrossSpawn;

export default spawn;
