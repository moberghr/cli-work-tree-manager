import { useEffect, useRef, useState } from 'react';
import { MAX_SNOOZE_MS, parseWhen } from '../../../../core/rail/snooze.js';

/** What the typed time means, in words ("Fri 3 Oct, 14:00"), or why it isn't one. */
export function whenPreview(text: string, now = new Date()): { at: Date | null; text: string } {
  if (!text.trim()) return { at: null, text: 'e.g. 14:00 · fri · fri 14:00 · +3h · 2026-10-05 17:00' };
  const at = parseWhen(text, now);
  if (!at) return { at: null, text: 'Not a time I know: try 14:00, fri, "fri 14:00", +3h or a date' };
  if (at.getTime() <= now.getTime()) return { at: null, text: 'That is in the past' };
  if (at.getTime() - now.getTime() > MAX_SNOOZE_MS) return { at: null, text: 'At most 30 days ahead (archive it instead?)' };
  return { at, text: at.toLocaleString([], { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) };
}

/**
 * "Snooze until…": a time of your choosing, typed as `work snooze --until`
 * takes it (snooze.ts parseWhen), with what it understood shown before you
 * confirm. `count` names how many it is for (the bulk bar).
 */
export function SnoozeUntilDialog({ count = 1, onPick, onClose }: { count?: number; onPick: (untilIso: string) => void; onClose: () => void }) {
  // Tomorrow morning, as a starting point to change.
  const [text, setText] = useState(() => `${['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'][(new Date().getDay() + 1) % 7]} 9:00`);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);
  const preview = whenPreview(text);
  const pick = () => {
    if (preview.at) onPick(preview.at.toISOString());
  };
  return (
    <div className="wd-modal-backdrop" role="dialog" aria-modal="true" aria-label="Snooze until" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <form
        className="wd-modal wd-snooze-until"
        onSubmit={(e) => {
          e.preventDefault();
          pick();
        }}
        onKeyDown={(e) => e.key === 'Escape' && onClose()}
      >
        <header className="wd-modal-header">
          <h2>Snooze {count > 1 ? `${count} sessions ` : ''}until…</h2>
          <button type="button" className="wd-modal-close" onClick={onClose} aria-label="Close">
            ×
          </button>
        </header>
        <div className="wd-modal-body">
          <label className="wd-modal-row">
            <span>When</span>
            <input ref={inputRef} type="text" value={text} onChange={(e) => setText(e.target.value)} aria-describedby="wd-snooze-until-preview" />
          </label>
          <p id="wd-snooze-until-preview" className={'wd-snooze-until-preview' + (preview.at ? '' : ' wd-tab-error')} role="status">
            {preview.at ? `Until ${preview.text}` : preview.text}
          </p>
        </div>
        <footer className="wd-modal-footer">
          <button type="button" className="wd-btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="wd-btn-primary" disabled={!preview.at}>
            Snooze
          </button>
        </footer>
      </form>
    </div>
  );
}
