import { createContext, useContext, useMemo, type ReactNode } from 'react';
import { fetchFileLines, type FileLinesResult } from '../api/client.js';

/**
 * Supplies the diff viewer with a way to read unchanged file lines so it
 * can reveal context around hunks ("expand lines", GitHub-style). The
 * provider knows how to reach the right server endpoint (scope-mounted vs
 * standalone); the diff components just call `loadLines`.
 *
 * When no provider is mounted — static `wd --static` files, which have no
 * server — `useExpandOptional()` returns null and the expand UI is hidden.
 */
export interface ExpandContextValue {
  loadLines: (
    repo: string,
    filePath: string,
    start: number,
    end: number,
  ) => Promise<FileLinesResult>;
  /** URL of the standalone "whole file" view for this repo/file, opened in
   *  a new tab. Routes to the scope-mounted `/file/<hash>` page (or `/file`
   *  on the standalone server). */
  fileHref: (repo: string, filePath: string) => string;
}

const ExpandCtx = createContext<ExpandContextValue | null>(null);

interface ExpandProviderProps {
  children: ReactNode;
  /** Scope hash for the `work web` endpoint; undefined → standalone server. */
  scopeHash?: string;
}

export function ExpandProvider({ children, scopeHash }: ExpandProviderProps) {
  const value = useMemo<ExpandContextValue>(
    () => ({
      loadLines: (repo, filePath, start, end) =>
        fetchFileLines(scopeHash, repo, filePath, start, end),
      fileHref: (repo, filePath) => {
        const params = new URLSearchParams({ repo, path: filePath });
        const base = scopeHash
          ? `/file/${encodeURIComponent(scopeHash)}`
          : '/file';
        return `${base}?${params.toString()}`;
      },
    }),
    [scopeHash],
  );
  return <ExpandCtx.Provider value={value}>{children}</ExpandCtx.Provider>;
}

export function useExpandOptional(): ExpandContextValue | null {
  return useContext(ExpandCtx);
}
