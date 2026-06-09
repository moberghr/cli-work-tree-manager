/**
 * Parsing for `work tree --base`. A base can be specified two ways, and
 * they compose:
 *
 *   --base dev                         → default base for every repo
 *   --base backend=dev --base front=x  → per-repo overrides
 *   --base dev --base front=x          → dev for all, front overridden to x
 *
 * yargs collects repeated `--base` flags into an array (a single flag stays
 * a string), so this accepts `string | string[] | undefined`.
 */

export interface BaseSpec {
  /** Base applied to any repo without a per-repo override. */
  default?: string;
  /** alias → base branch overrides. */
  perRepo: Record<string, string>;
}

/** Thrown by {@link parseBaseSpec} on malformed or conflicting input. */
export class BaseSpecError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BaseSpecError';
  }
}

/**
 * Parse raw `--base` values into a {@link BaseSpec}. A value containing `=`
 * is treated as an `alias=branch` override; anything else is a bare default.
 * Throws {@link BaseSpecError} on empty halves or conflicting duplicates.
 */
export function parseBaseSpec(raw: string | string[] | undefined): BaseSpec {
  const spec: BaseSpec = { perRepo: {} };
  if (raw === undefined) return spec;
  const values = Array.isArray(raw) ? raw : [raw];

  for (const value of values) {
    const v = value.trim();
    if (!v) continue;
    const eq = v.indexOf('=');
    if (eq === -1) {
      if (spec.default !== undefined && spec.default !== v) {
        throw new BaseSpecError(
          `Conflicting default --base values: '${spec.default}' and '${v}'`,
        );
      }
      spec.default = v;
    } else {
      const alias = v.slice(0, eq).trim();
      const branch = v.slice(eq + 1).trim();
      if (!alias || !branch) {
        throw new BaseSpecError(
          `Invalid --base '${value}'. Use 'alias=branch' or a bare 'branch'.`,
        );
      }
      const prior = spec.perRepo[alias];
      if (prior !== undefined && prior !== branch) {
        throw new BaseSpecError(
          `Conflicting --base for '${alias}': '${prior}' and '${branch}'`,
        );
      }
      spec.perRepo[alias] = branch;
    }
  }

  return spec;
}

/** The resolved base for one repo alias: its override, else the default. */
export function baseForAlias(spec: BaseSpec, alias: string): string | undefined {
  return spec.perRepo[alias] ?? spec.default;
}

/** True when no base was requested at all (plain HEAD-fork behavior). */
export function isEmptyBaseSpec(spec: BaseSpec): boolean {
  return spec.default === undefined && Object.keys(spec.perRepo).length === 0;
}

/** The alias keys carrying a per-repo override. */
export function baseSpecOverrideAliases(spec: BaseSpec): string[] {
  return Object.keys(spec.perRepo);
}

/** Normalize the loose `setupWorktree` parameter into a {@link BaseSpec}. */
export function toBaseSpec(base: string | BaseSpec | undefined): BaseSpec {
  if (base === undefined) return { perRepo: {} };
  if (typeof base === 'string') return { default: base, perRepo: {} };
  return base;
}
