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
 * Light / dark theme, applied by stamping `data-theme` on <html> so the
 * whole SPA re-themes through the CSS-variable cascade (see tokens.css).
 *
 * Default follows the OS (`prefers-color-scheme`); a user toggle overrides
 * it and persists to localStorage (`wd:theme`). While no explicit choice is
 * stored, the theme tracks OS changes live. The choice is global and
 * cross-session — shared by every view (`wd`, `wd -c`, `work web`) through
 * this context, mounted once at the app root.
 *
 * The initial paint is handled by the inline boot script in index.html; this
 * provider just keeps React in sync and owns runtime changes.
 */
export type Theme = 'light' | 'dark';

const STORAGE_KEY = 'wd:theme';

interface ThemeValue {
  theme: Theme;
  /** True when the user has explicitly chosen (localStorage set). */
  explicit: boolean;
  setTheme: (t: Theme) => void;
  toggle: () => void;
}

const ThemeCtx = createContext<ThemeValue | null>(null);

function osPrefersDark(): boolean {
  try {
    return window.matchMedia('(prefers-color-scheme: dark)').matches;
  } catch {
    return false;
  }
}

function readStored(): Theme | null {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    return v === 'light' || v === 'dark' ? v : null;
  } catch {
    return null;
  }
}

function apply(theme: Theme): void {
  try {
    document.documentElement.dataset.theme = theme;
  } catch {
    /* no document (test env) — nothing to stamp */
  }
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [stored, setStored] = useState<Theme | null>(readStored);
  const [osDark, setOsDark] = useState<boolean>(osPrefersDark);

  const theme: Theme = stored ?? (osDark ? 'dark' : 'light');

  // Reflect the resolved theme onto <html> whenever it changes.
  useEffect(() => {
    apply(theme);
  }, [theme]);

  const setTheme = useCallback((t: Theme) => {
    setStored(t);
    try {
      localStorage.setItem(STORAGE_KEY, t);
    } catch {
      /* private-mode / quota — preference just won't persist */
    }
  }, []);

  const toggle = useCallback(() => {
    setStored((prev) => {
      const current = prev ?? (osPrefersDark() ? 'dark' : 'light');
      const next: Theme = current === 'dark' ? 'light' : 'dark';
      try {
        localStorage.setItem(STORAGE_KEY, next);
      } catch {
        /* ignore */
      }
      return next;
    });
  }, []);

  // Follow OS changes while no explicit choice is stored.
  useEffect(() => {
    let mq: MediaQueryList;
    try {
      mq = window.matchMedia('(prefers-color-scheme: dark)');
    } catch {
      return;
    }
    const onChange = (e: MediaQueryListEvent) => setOsDark(e.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  // Keep tabs in sync: another tab flipping the preference updates this one
  // (the `storage` event only fires in OTHER documents, so no loop).
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === STORAGE_KEY) setStored(readStored());
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  const value = useMemo<ThemeValue>(
    () => ({ theme, explicit: stored !== null, setTheme, toggle }),
    [theme, stored, setTheme, toggle],
  );
  return <ThemeCtx.Provider value={value}>{children}</ThemeCtx.Provider>;
}

/** Full controls for the toggle UI. Null when no provider is mounted. */
export function useThemeControls(): ThemeValue | null {
  return useContext(ThemeCtx);
}
