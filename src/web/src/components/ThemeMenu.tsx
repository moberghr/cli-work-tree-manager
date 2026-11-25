import { useState } from 'react';
import { APP_THEMES, type AppThemeId } from '../../../core/settings/app-theme.js';
import { useThemeControls } from '../state/ThemeProvider.js';
import { Menu, type MenuItem } from '../ui/Menu.js';

const THEMES: readonly { id: AppThemeId; label: string }[] = [{ id: 'system', label: 'System' }, ...APP_THEMES];
/** What `wd` offers: it has no settings, so this browser keeps the choice; the named themes are work web's. */
const WD_THEMES: readonly AppThemeId[] = ['system', 'light', 'dark'];

/**
 * The app's theme, picked from a menu under a palette button (the top bar's, the review page's): every app theme where
 * it is a setting (work web: saved to config.json at once), System / Light / Dark in `wd`. `onSettings` adds "More in
 * Settings…" (the dashboard's: the terminal's theme, font and size are there). Renders nothing without a ThemeProvider.
 */
export function ThemeMenu({ onSettings }: { onSettings?: () => void }) {
  const ctrl = useThemeControls();
  const [at, setAt] = useState<{ x: number; y: number } | null>(null);
  if (!ctrl) return null;
  const { choice, setting, setTheme } = ctrl;
  const items: MenuItem[] = THEMES.filter((t) => setting || WD_THEMES.includes(t.id)).map((t) => ({
    label: t.label,
    checked: t.id === choice,
    run: () => setTheme(t.id),
  }));
  if (onSettings && setting) items.push({ label: 'More in Settings…', separated: true, run: onSettings });
  const label = `Theme: ${THEMES.find((t) => t.id === choice)?.label ?? 'System'}`;
  return (
    <>
      <button
        type="button"
        className="wd-theme-btn"
        aria-haspopup="menu"
        aria-expanded={at !== null}
        aria-label={label}
        title={label}
        // A click on the button while its menu is open closes it (the menu's own outside-click handler would otherwise
        // close it and this reopen it).
        onMouseDown={(e) => {
          if (at) e.stopPropagation();
        }}
        onClick={(e) => {
          if (at) return setAt(null);
          const r = e.currentTarget.getBoundingClientRect();
          setAt({ x: r.right, y: r.bottom + 4 });
        }}
      >
        {/* A painter's palette. */}
        <svg width="15" height="15" viewBox="0 0 16 16" aria-hidden="true">
          <path
            fill="none"
            stroke="currentColor"
            strokeWidth="1.3"
            strokeLinejoin="round"
            d="M8 1.75C4.5 1.75 1.75 4.4 1.75 7.8c0 3.4 2.8 6.45 6 6.45.85 0 1.3-.55 1.3-1.2 0-.75-.6-1-.6-1.75 0-.7.55-1.15 1.25-1.15h1.6c1.65 0 2.95-1.15 2.95-3.05 0-3.05-2.85-5.35-6.25-5.35z"
          />
          <circle cx="5" cy="7.6" r="1" fill="currentColor" />
          <circle cx="7" cy="4.9" r="1" fill="currentColor" />
          <circle cx="10.2" cy="5.1" r="1" fill="currentColor" />
        </svg>
      </button>
      {at && <Menu x={at.x} y={at.y} anchor="right" items={items} onClose={() => setAt(null)} />}
    </>
  );
}
