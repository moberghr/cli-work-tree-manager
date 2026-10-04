import { useEffect, useRef } from 'react';
import { shortcutGroups } from '../../state/shortcuts.js';

/**
 * `?`: every keyboard shortcut, by where it works (state/shortcuts.ts). A
 * popover, not a dialog: the shortcuts keep working while it's open, and
 * `?`, Esc or a click elsewhere closes it.
 */
export function ShortcutsHelp({ onClose }: { onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('mousedown', onDown);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('mousedown', onDown);
    };
  }, [onClose]);
  return (
    <div ref={ref} className="wd-shortcuts" role="dialog" data-popover aria-label="Keyboard shortcuts">
      <header className="wd-shortcuts-head">
        <h2>Keyboard shortcuts</h2>
        <button type="button" className="wd-modal-close" onClick={onClose} aria-label="Close">
          ×
        </button>
      </header>
      <p className="wd-shortcuts-note">Not while typing in a field or a terminal, nor with a dialog open.</p>
      <div className="wd-shortcuts-groups">
        {shortcutGroups().map((g) => (
          <section key={g.title} className="wd-shortcuts-group">
            <h3 className="wd-legend-title">{g.title}</h3>
            <dl>
              {g.rows.map((r) => (
                <div key={r.keys + r.label} className="wd-shortcuts-row">
                  <dt>
                    <kbd>{r.keys}</kbd>
                  </dt>
                  <dd>{r.label}</dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
      </div>
    </div>
  );
}
