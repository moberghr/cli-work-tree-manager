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
  loadLines: (repo: string, filePath: string, start: number, end: number) => Promise<FileLinesResult>;
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
  /**
   * The version the diff's newer side is, per repo: undefined = the working
   * tree (the default); a ref (a commit, `HEAD`) = lines read from it — a
   * commit or a turn shown in the dashboard's Diff tab; null = none to read
   * (that side has no version for this repo), so expanding says so.
   */
  refFor?: (repo: string) => string | null | undefined;
  /**
   * False: nothing to read lines through yet (the Diff tab before its scope answered) — no arrows. The provider stays
   * mounted either way: swapping it in would change the tree's root and rebuild the diff (a half-typed comment lost).
   */
  ready?: boolean;
}

export function ExpandProvider({ children, scopeHash, refFor, ready = true }: ExpandProviderProps) {
  const value = useMemo<ExpandContextValue | null>(
    () =>
      !ready
        ? null
        : {
            loadLines: (repo, filePath, start, end) => {
              const ref = refFor?.(repo);
              if (ref === null) return Promise.reject(new Error('no version of this file to read here'));
              return fetchFileLines(scopeHash, repo, filePath, start, end, ref);
            },
            fileHref: (repo, filePath) => {
              const params = new URLSearchParams({ repo, path: filePath });
              const ref = refFor?.(repo);
              if (ref) params.set('ref', ref);
              const base = scopeHash ? `/file/${encodeURIComponent(scopeHash)}` : '/file';
              return `${base}?${params.toString()}`;
            },
          },
    [scopeHash, refFor, ready],
  );
  return <ExpandCtx.Provider value={value}>{children}</ExpandCtx.Provider>;
}

export function useExpandOptional(): ExpandContextValue | null {
  return useContext(ExpandCtx);
}
