import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import type { SessionSummary } from '../../api/client.js';
import { displayStatus } from '../../state/session-display.js';
import { switcherLabel, switcherResults } from '../../state/quick-switch.js';
import { StatusIcon } from './StatusIcon.js';

/**
 * Ctrl+P: type a few letters of a session's name, branch or repo and press
 * Enter to open it — from anywhere, a terminal included. Nothing typed, it
 * lists the sessions you used last. ↑/↓ move, Esc closes.
 */
export function QuickSwitcher({ sessions, onOpen, onClose }: { sessions: SessionSummary[]; onOpen: (id: string) => void; onClose: (picked: boolean) => void }) {
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const listId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const results = useMemo(() => switcherResults(sessions, query), [sessions, query]);
  useEffect(() => inputRef.current?.focus(), []);
  useEffect(() => setActive(0), [query]);
  const open = (s: SessionSummary | undefined) => {
    if (!s) return;
    onClose(true);
    onOpen(s.id);
  };
  return (
    <div className="wd-switcher-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose(false)}>
      <div className="wd-switcher" role="dialog" aria-modal="true" aria-label="Go to a session">
        <input
          ref={inputRef}
          className="wd-switcher-input"
          type="text"
          role="combobox"
          aria-expanded="true"
          aria-controls={listId}
          aria-activedescendant={results[active] ? `${listId}-${active}` : undefined}
          placeholder="Go to a session: name, branch, repo, Jira key…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              setActive((i) => Math.min(i + 1, results.length - 1));
            } else if (e.key === 'ArrowUp') {
              e.preventDefault();
              setActive((i) => Math.max(i - 1, 0));
            } else if (e.key === 'Enter') {
              e.preventDefault();
              open(results[active]);
            } else if (e.key === 'Escape') {
              e.preventDefault();
              onClose(false);
            } else if (e.key === 'Tab') {
              // The only thing to type in: Tab stays here, not on the page behind.
              e.preventDefault();
            }
          }}
        />
        <ul id={listId} className="wd-switcher-list" role="listbox">
          {results.length === 0 && <li className="wd-switcher-empty">No session matches “{query.trim()}”.</li>}
          {results.map((s, i) => (
            <li
              key={s.id}
              id={`${listId}-${i}`}
              role="option"
              aria-selected={i === active}
              className={'wd-switcher-item' + (i === active ? ' wd-switcher-item-active' : '')}
              onMouseDown={(e) => {
                e.preventDefault();
                open(s);
              }}
              onMouseEnter={() => setActive(i)}
            >
              <StatusIcon kind={displayStatus(s)} />
              <span className="wd-switcher-name">{switcherLabel(s)}</span>
              <span className="wd-switcher-sub">
                {s.target}
                {switcherLabel(s) !== s.branch ? ` · ${s.branch}` : ''}
                {s.archivedAt ? ' · archived' : ''}
              </span>
            </li>
          ))}
        </ul>
        <p className="wd-switcher-hint">
          <kbd>↑</kbd> <kbd>↓</kbd> to move · <kbd>Enter</kbd> to open · <kbd>Esc</kbd> to close
        </p>
      </div>
    </div>
  );
}

/**
 * Ctrl+P opens and closes it — from anywhere, a terminal included (caught in
 * the capture phase, like Ctrl+K; there it stands in for the shell's Ctrl+P,
 * which ↑ also does), and never the desktop app's print dialog. Not over
 * another dialog (New worktree, Delete, Ship): a pick would navigate out from
 * under a confirmation in progress. Closed without a pick, focus goes back
 * where it was (the terminal).
 */
export function useQuickSwitcher(): { open: boolean; close: (picked: boolean) => void } {
  const [open, setOpen] = useState(false);
  const openRef = useRef(false);
  const focusBefore = useRef<HTMLElement | null>(null);
  const close = useCallback((picked: boolean) => {
    openRef.current = false;
    setOpen(false);
    const before = focusBefore.current;
    focusBefore.current = null;
    if (!picked && before?.isConnected) setTimeout(() => before.focus(), 0);
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey || e.key.toLowerCase() !== 'p') return;
      e.preventDefault(); // never the print dialog
      e.stopPropagation();
      if (openRef.current) return close(false);
      if (document.querySelector('[role="dialog"], [role="alertdialog"], [aria-modal="true"]')) return;
      focusBefore.current = document.activeElement as HTMLElement | null;
      openRef.current = true;
      setOpen(true);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [close]);
  return { open, close };
}
