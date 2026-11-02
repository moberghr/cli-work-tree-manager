/**
 * What a prompt tells an agent to run for a pull request, per host — so a
 * session on another host is never told to run `gh`. Pure and import-free
 * past the hosts' own command tables: the SPA builds its Start prompts with
 * it (`start-prompts.ts`), core its notes (the PR watch, saved prompts).
 */
export interface PrCommands {
  /** The host's name, as prompts say it ("GitHub"). */
  host: string;
  /** Its CLI's name. */
  cli: string;
  view(n: number | string): string;
  comments(n: number | string): string;
  diff(n: number | string): string;
  checks(n: number | string): string;
  /** How to read a failed CI run's log. */
  failedLog: string;
  checkout(n: number | string, detach?: boolean): string;
  /** How to open a PR from the current branch. */
  create: string;
}
