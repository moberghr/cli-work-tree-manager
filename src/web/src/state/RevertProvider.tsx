import { createContext, useContext } from 'react';

/**
 * Revert actions for the diff: present only where reverting makes sense
 * (a session's Uncommitted diff), so file/hunk headers show their Revert
 * buttons only there.
 */
export interface RevertApi {
  /** Undo a whole file, or new-side lines [start, end] of it. Resolves
   *  once the diff has been reloaded; rejects with a readable reason. */
  revert(repo: string, path: string, lines?: { start: number; end: number }): Promise<void>;
}

export const RevertContext = createContext<RevertApi | null>(null);

export function useRevertOptional(): RevertApi | null {
  return useContext(RevertContext);
}
