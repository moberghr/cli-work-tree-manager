import type { WorkConfig } from './config.js';

export interface ProjectTarget {
  isGroup: boolean;
  name: string;
  repoAliases: string[];
}

/**
 * Resolve whether a name is a group or single repo.
 * Returns null if the name is not found in either.
 */
export function resolveProjectTarget(
  name: string,
  config: WorkConfig,
): ProjectTarget | null {
  // Check if it's a group
  if (name in config.groups) {
    return {
      isGroup: true,
      name,
      repoAliases: [...config.groups[name]],
    };
  }

  // Check if it's a repo
  if (name in config.repos) {
    return {
      isGroup: false,
      name,
      repoAliases: [name],
    };
  }

  return null;
}

/** Get all available project/group names. */
export function getAllTargetNames(config: WorkConfig): string[] {
  return [
    ...Object.keys(config.repos),
    ...Object.keys(config.groups),
  ];
}
