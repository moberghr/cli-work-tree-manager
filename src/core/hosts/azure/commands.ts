import type { PrCommands } from '../command-types.js';

/**
 * The commands a prompt tells an agent to run for an Azure DevOps PR: the
 * `az repos` commands (the azure-devops extension), and git for the diff —
 * Azure DevOps keeps a PR's code at `refs/pull/<id>/merge`, whose first
 * parent is its target. Pure, import-free (the SPA builds prompts with it).
 */
export const azureCommands: PrCommands = {
  host: 'Azure DevOps',
  cli: 'az',
  view: (n) => `az repos pr show --id ${n}`,
  comments: (n) => `az repos pr show --id ${n} (and its threads: az devops invoke --area git --resource pullRequestThreads)`,
  diff: (n) => `git fetch origin refs/pull/${n}/merge && git diff FETCH_HEAD^1 FETCH_HEAD`,
  checks: (n) => `az repos pr policy list --id ${n}`,
  failedLog: 'az pipelines runs show --id <run-id>',
  checkout: (n) => `az repos pr checkout --id ${n}`,
  create: 'az repos pr create',
};
