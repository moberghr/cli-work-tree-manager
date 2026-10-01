import { useEffect, useRef } from 'react';

/**
 * A row's right-click menu (session rail: Rename; Tasks: Edit), at the
 * pointer. Closes on a pick, Esc, a click elsewhere, the window losing focus
 * or resizing.
 */
/** A small right-click menu at the pointer; closes on a pick, Esc, or a click elsewhere. */
export function RowMenu({
  x,
  y,
  items,
  onClose,
}: {
  x: number;
  y: number;
  items: Array<{ label: string; hint?: string; run: () => void }>;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.querySelector<HTMLButtonElement>('button')?.focus();
    const away = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('mousedown', away);
    window.addEventListener('keydown', esc);
    window.addEventListener('blur', onClose);
    window.addEventListener('resize', onClose);
    return () => {
      window.removeEventListener('mousedown', away);
      window.removeEventListener('keydown', esc);
      window.removeEventListener('blur', onClose);
      window.removeEventListener('resize', onClose);
    };
  }, [onClose]);
  return (
    <div ref={ref} className="wd-row-menu" role="menu" style={{ left: x, top: y }}>
      {items.map((it) => (
        <button
          key={it.label}
          type="button"
          role="menuitem"
          className="wd-row-menu-item"
          onClick={() => {
            onClose();
            it.run();
          }}
        >
          <span>{it.label}</span>
          {it.hint && <kbd className="wd-row-menu-hint">{it.hint}</kbd>}
        </button>
      ))}
    </div>
  );
}
