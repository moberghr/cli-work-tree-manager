import type { PrCommands } from '../command-types.js';

/** The `gh` commands a prompt tells an agent to run for a GitHub PR. Pure, import-free (the SPA builds prompts with it). */
export const githubCommands: PrCommands = {
  host: 'GitHub',
  cli: 'gh',
  view: (n) => `gh pr view ${n}`,
  comments: (n) => `gh pr view ${n} --comments`,
  diff: (n) => `gh pr diff ${n}`,
  checks: (n) => `gh pr checks ${n}`,
  failedLog: 'gh run view <run-id> --log-failed',
  checkout: (n, detach) => `gh pr checkout ${n}${detach ? ' --detach' : ''}`,
  create: 'gh pr create',
};
