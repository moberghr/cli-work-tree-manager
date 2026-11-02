import { githubCommands } from './github/commands.js';
import { azureCommands } from './azure/commands.js';

export type { PrCommands } from './command-types.js';
import type { PrCommands } from './command-types.js';

const TABLE: Record<string, PrCommands> = { github: githubCommands, azure: azureCommands };

/** The default host: a repo no adapter claims is asked as GitHub (as before hosts existed; `gh` decides). */
export const DEFAULT_HOST = 'github';

/** A host's prompt commands; the default host's for an unknown or missing id (a row from an older server). */
export function commandsFor(hostId?: string | null): PrCommands {
  return TABLE[hostId ?? DEFAULT_HOST] ?? TABLE[DEFAULT_HOST];
}

/** Add a host's commands (registerHost does, for a host added at run time). Returns its removal. */
export function addCommands(hostId: string, commands: PrCommands): () => void {
  TABLE[hostId] = commands;
  return () => {
    if (TABLE[hostId] === commands) delete TABLE[hostId];
  };
}

/** How the UI names a host ("GitHub"), from its id on the wire. */
export function hostName(hostId?: string | null): string {
  return commandsFor(hostId).host;
}
