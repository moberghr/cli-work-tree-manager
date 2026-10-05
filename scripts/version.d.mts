/** Types for scripts/version.mjs (the build configs and tests import it). */

/** `git describe --tags --long` output → a version, or null for anything else. */
export function versionFromDescribe(described: string | null | undefined): string | null;

/** The version of the work in `root`: WORK_VERSION, else git describe, else package.json. */
export function workVersion(
  root?: string,
  opts?: { env?: Record<string, string | undefined>; describe?: (root: string) => string | null },
): string;
