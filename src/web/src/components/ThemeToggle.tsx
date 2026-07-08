import { useThemeControls } from '../state/ThemeProvider.js';

/**
 * Light/dark theme toggle. A single icon button that flips the global,
 * persisted theme preference. Renders nothing when no ThemeProvider is
 * mounted (defensive — every real view mounts one at the app root).
 */
export function ThemeToggle() {
  const ctrl = useThemeControls();
  if (!ctrl) return null;
  const { theme, toggle } = ctrl;
  const dark = theme === 'dark';
  return (
    <button
      type="button"
      className="wd-theme-toggle"
      onClick={toggle}
      aria-label={dark ? 'Switch to light theme' : 'Switch to dark theme'}
      title={dark ? 'Switch to light theme' : 'Switch to dark theme'}
    >
      {dark ? (
        // Sun (click → go light)
        <svg width="15" height="15" viewBox="0 0 16 16" aria-hidden="true">
          <circle cx="8" cy="8" r="3.25" fill="currentColor" />
          <g stroke="currentColor" strokeWidth="1.4" strokeLinecap="round">
            <path d="M8 1v1.75M8 13.25V15M15 8h-1.75M2.75 8H1M12.95 3.05l-1.24 1.24M4.29 11.71l-1.24 1.24M12.95 12.95l-1.24-1.24M4.29 4.29L3.05 3.05" />
          </g>
        </svg>
      ) : (
        // Moon (click → go dark)
        <svg width="15" height="15" viewBox="0 0 16 16" aria-hidden="true">
          <path
            fill="currentColor"
            d="M9.6 2.2a6 6 0 1 0 4.2 8.9A5 5 0 0 1 9.6 2.2z"
          />
        </svg>
      )}
    </button>
  );
}
