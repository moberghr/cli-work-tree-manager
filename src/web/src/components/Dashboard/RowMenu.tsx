import { useEffect, useLayoutEffect, useRef, useState } from 'react';

/** One entry of a row's menu. */
export interface MenuItem {
  label: string;
  hint?: string;
  run: () => void;
  /** Deletes or otherwise can't be undone in one click: shown in red. */
  danger?: boolean;
  /** A line above it, to set a group apart. */
  separated?: boolean;
}

/** One pick of a row of swatches (the rail's colors): its name is its tooltip and what a screen reader says. */
export interface MenuSwatch {
  key: string;
  label: string;
  /** Sets its color (`wd-tag-<color>`); none: the "no color" swatch. */
  className?: string;
  /** What the session has now. */
  current?: boolean;
  run: () => void;
}

/** A row of swatches in place of an item: "Color  ● ● ● ● ● ● ⊘". */
export interface MenuSwatches {
  label: string;
  swatches: MenuSwatch[];
  separated?: boolean;
}

/** What a menu lists: items, and rows of swatches. */
export type MenuEntry = MenuItem | MenuSwatches;

interface RowMenuProps {
  x: number;
  y: number;
  items: MenuEntry[];
  onClose: () => void;
  /** A muted line under the items (the session header's: how full its context is). */
  footer?: string;
  /** 'right': x is the menu's right edge (opened from a button at the right). */
  anchor?: 'left' | 'right';
}

/**
 * A row's right-click menu (session rail, Tasks) at the pointer, or a
 * button's (the session header's ⋯) — kept inside the window when opened
 * near an edge. ↑/↓ move (through a row of swatches one by one, ←/→ too),
 * Enter picks; closes on a pick, Esc, Tab, a click elsewhere, the window
 * losing focus or resizing.
 *
 * Focuses its first item once, on opening: the parent re-renders on every
 * background refresh, and re-running that would snap ↑/↓ back to the top.
 */
export function RowMenu({ x, y, items, onClose, footer, anchor = 'left' }: RowMenuProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: x, top: y });
  // Opened near the bottom or right edge: shift it back in, once it has a size.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const left = anchor === 'right' ? x - r.width : x;
    setPos({
      left: Math.max(4, Math.min(left, window.innerWidth - r.width - 4)),
      top: Math.max(4, Math.min(y, window.innerHeight - r.height - 4)),
    });
  }, [x, y, anchor]);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    ref.current?.querySelector<HTMLButtonElement>('button')?.focus();
  }, []);
  useEffect(() => {
    const onClose = () => closeRef.current();
    const away = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    const keys = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      // Tab would move focus behind the open menu: close it instead.
      if (e.key === 'Tab') {
        e.preventDefault();
        onClose();
      }
      // ←/→ only within a row of swatches.
      const sideways =
        (e.key === 'ArrowLeft' || e.key === 'ArrowRight') &&
        !!(document.activeElement as HTMLElement | null)?.closest('.wd-row-menu-swatches');
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp' && !sideways) return;
      const buttons = [...(ref.current?.querySelectorAll<HTMLButtonElement>('button') ?? [])];
      if (buttons.length === 0) return;
      e.preventDefault();
      const i = buttons.indexOf(document.activeElement as HTMLButtonElement);
      const forward = e.key === 'ArrowDown' || e.key === 'ArrowRight';
      const next = forward ? (i + 1) % buttons.length : (i - 1 + buttons.length) % buttons.length;
      buttons[next].focus();
    };
    window.addEventListener('mousedown', away);
    window.addEventListener('keydown', keys);
    window.addEventListener('blur', onClose);
    window.addEventListener('resize', onClose);
    return () => {
      window.removeEventListener('mousedown', away);
      window.removeEventListener('keydown', keys);
      window.removeEventListener('blur', onClose);
      window.removeEventListener('resize', onClose);
    };
  }, []);
  return (
    <div ref={ref} className="wd-row-menu" role="menu" style={pos}>
      {items.map((it) =>
        'swatches' in it ? (
          <div
            key={it.label}
            className={'wd-row-menu-swatches' + (it.separated ? ' wd-row-menu-item-separated' : '')}
            role="group"
            aria-label={it.label}
          >
            <span className="wd-row-menu-swatches-label">{it.label}</span>
            {it.swatches.map((sw) => (
              <button
                key={sw.key}
                type="button"
                role="menuitemradio"
                aria-checked={!!sw.current}
                aria-label={sw.label}
                title={sw.label}
                className={
                  'wd-row-menu-swatch ' + (sw.className ?? 'wd-row-menu-swatch-none') + (sw.current ? ' wd-row-menu-swatch-current' : '')
                }
                onClick={() => {
                  onClose();
                  sw.run();
                }}
              />
            ))}
          </div>
        ) : (
          <button
            key={it.label}
            type="button"
            role="menuitem"
            className={
              'wd-row-menu-item' + (it.danger ? ' wd-row-menu-item-danger' : '') + (it.separated ? ' wd-row-menu-item-separated' : '')
            }
            onClick={() => {
              onClose();
              it.run();
            }}
          >
            <span>{it.label}</span>
            {it.hint && <kbd className="wd-row-menu-hint">{it.hint}</kbd>}
          </button>
        ),
      )}
      {footer && <p className="wd-row-menu-footer">{footer}</p>}
    </div>
  );
}
