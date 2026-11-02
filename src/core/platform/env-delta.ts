/**
 * A change to an environment: a name set to a value, or `null` to take it out of the environment. JSON-safe, so it
 * crosses to the PTY host in a spawn spec (an `undefined` would be dropped on the way and leave the variable as it was).
 */
export type EnvDelta = Record<string, string | null>;

/** `env` with `delta` applied, as a new object. Names are matched case-blind on Windows, where the environment is. Pure. */
export function applyEnvDelta(
  env: Record<string, string | undefined>,
  delta: EnvDelta | undefined,
  platform: NodeJS.Platform = process.platform,
): Record<string, string | undefined> {
  if (!delta) return { ...env };
  const fold = (k: string) => (platform === 'win32' ? k.toUpperCase() : k);
  const names = new Set(Object.keys(delta).map(fold));
  const out: Record<string, string | undefined> = Object.fromEntries(Object.entries(env).filter(([k]) => !names.has(fold(k))));
  for (const [k, v] of Object.entries(delta)) if (v !== null) out[k] = v;
  return out;
}

/** Whether a delta has anything in it. */
export const hasEnvDelta = (delta: EnvDelta | undefined): delta is EnvDelta => !!delta && Object.keys(delta).length > 0;

/** Shape check for a delta read back from storage or the wire. */
export const isEnvDelta = (x: unknown): x is EnvDelta =>
  !!x && typeof x === 'object' && !Array.isArray(x) && Object.values(x).every((v) => v === null || typeof v === 'string');

/** The trailing argument for `launchAi`: the delta when it changes anything, else none at all (a launch with nothing to change passes nothing extra). */
export const envArgs = (delta: EnvDelta | undefined): [EnvDelta] | [] => (hasEnvDelta(delta) ? [delta] : []);
