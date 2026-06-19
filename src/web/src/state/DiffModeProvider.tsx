import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';

/**
 * How the diff is laid out:
 *   'split'   — side-by-side (old | new), the default.
 *   'unified' — one column with deletions and additions interleaved,
 *               GitHub's "unified" view.
 *
 * The choice is a global, cross-session preference (not per-scope): a
 * reviewer who prefers unified wants it everywhere. It's persisted to
 * localStorage and shared by every view (`wd`, `wd -c`, `work web`) through
 * this context, mounted once at the app root.
 */
export type DiffMode = 'split' | 'unified';

const STORAGE_KEY = 'wd:diff-mode';

interface DiffModeValue {
  mode: DiffMode;
  setMode: (m: DiffMode) => void;
}

const DiffModeCtx = createContext<DiffModeValue | null>(null);

function readStored(): DiffMode {
  try {
    return localStorage.getItem(STORAGE_KEY) === 'unified'
      ? 'unified'
      : 'split';
  } catch {
    return 'split';
  }
}

export function DiffModeProvider({ children }: { children: ReactNode }) {
  const [mode, setModeState] = useState<DiffMode>(readStored);

  const setMode = useCallback((m: DiffMode) => {
    setModeState(m);
    try {
      localStorage.setItem(STORAGE_KEY, m);
    } catch {
      /* private-mode / quota — preference just won't persist */
    }
  }, []);

  // Keep tabs in sync: another tab flipping the preference updates this one
  // (the `storage` event only fires in OTHER documents, so no loop).
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === STORAGE_KEY) setModeState(readStored());
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  const value = useMemo<DiffModeValue>(() => ({ mode, setMode }), [mode, setMode]);
  return <DiffModeCtx.Provider value={value}>{children}</DiffModeCtx.Provider>;
}

/** Read the current diff mode. Returns 'split' when no provider is mounted
 *  (e.g. an isolated component test) so callers never need a null check. */
export function useDiffMode(): DiffMode {
  return useContext(DiffModeCtx)?.mode ?? 'split';
}

/** Full controls for the toggle UI. Null when no provider is mounted. */
export function useDiffModeControls(): DiffModeValue | null {
  return useContext(DiffModeCtx);
}
