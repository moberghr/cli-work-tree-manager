import { useEffect, useRef, useState } from 'react';
import type { UpdateWire } from '../../../../core/api-types.js';
import { VERSION } from '../../version.js';

export interface HelpMenuProps {
  updates?: UpdateWire | null;
  onCheck?: () => void;
  checking?: boolean;
  /** How the last check went. */
  note?: string | null;
  onWhatsNew?: () => void;
  onShortcuts?: () => void;
  /** The desktop app has an update downloaded: restart onto it. */
  onRestart?: () => void;
}

/** Where an update stands, in a few words ("2.1.0 is ready to install"), or null when there's nothing to say. Pure. */
export function updateStatus(updates: UpdateWire | null | undefined): string | null {
  const a = updates?.available;
  if (a)
    return a.how === 'restart'
      ? `${a.version} is ready to install`
      : a.how === 'downloading'
        ? `downloading ${a.version}`
        : `${a.version} is out`;
  const d = updates?.desktop;
  return d?.state === 'failed' ? `couldn't update: ${d.error ?? 'unknown'}` : null;
}

/**
 * The top bar's version, a button (as bearing's Help menu): which work runs and
 * where an update stands, Check for updates, What's new, the keyboard
 * shortcuts. A dot on the button when an update is there. A popover
 * (`data-popover`): Esc or a click elsewhere closes it, shortcuts keep working.
 */
export function HelpMenu({ updates, onCheck, checking, note, onWhatsNew, onShortcuts, onRestart }: HelpMenuProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('mousedown', onDown);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('mousedown', onDown);
    };
  }, [open]);

  const running = updates?.running ?? VERSION;
  const status = updateStatus(updates);
  const canRestart = updates?.available?.how === 'restart' && !!onRestart;
  const pick = (fn?: () => void) => () => {
    setOpen(false);
    fn?.();
  };
  return (
    <div className="wd-help" ref={ref}>
      <button
        type="button"
        className={'wd-help-btn' + (updates?.available ? ' wd-help-btn-update' : '')}
        aria-expanded={open}
        aria-label={`Help: work v${running}${status ? `, ${status}` : ''}`}
        title={`work v${running}${status ? ` · ${status}` : ''}\nHelp: updates, what's new, keyboard shortcuts`}
        onClick={() => setOpen((o) => !o)}
      >
        v{running}
      </button>
      {open && (
        <div className="wd-help-panel" role="dialog" data-popover aria-label="Help">
          <p className="wd-help-version">
            work v{running}
            {status && <span className="wd-help-status"> · {status}</span>}
          </p>
          {canRestart && (
            <button type="button" className="wd-row-menu-item wd-help-restart" onClick={pick(onRestart)}>
              Restart to update
            </button>
          )}
          {onCheck && (
            <button type="button" className="wd-row-menu-item" disabled={checking} onClick={onCheck}>
              {checking ? 'Checking…' : 'Check for updates'}
            </button>
          )}
          {note && <p className="wd-help-note">{note}</p>}
          {onWhatsNew && (
            <button type="button" className="wd-row-menu-item" onClick={pick(onWhatsNew)}>
              What&apos;s new
            </button>
          )}
          {onShortcuts && (
            <button type="button" className="wd-row-menu-item" onClick={pick(onShortcuts)}>
              Keyboard shortcuts <kbd>?</kbd>
            </button>
          )}
        </div>
      )}
    </div>
  );
}
