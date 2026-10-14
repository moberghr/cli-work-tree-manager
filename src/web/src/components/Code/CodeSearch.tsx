import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { CodeFilesWire, CodeSearchWire } from '../../../../core/api-types.js';
import { fetchCodeFiles, fetchCodeSearch } from '../../api/client.js';
import { codeEntries, filterEntries } from '../../state/code-tree.js';
import { matchRange, searchGroups, type CodePlace, type SearchRow } from '../../state/code-search-view.js';

/** A pause in typing before the server is asked (each keystroke would start a search). */
const TYPING_PAUSE_MS = 180;
/** Fewer letters than this: no search (the server's MIN_SEARCH_CHARS). */
const MIN_CHARS = 2;

/**
 * Ctrl+T in a session, as Visual Studio's: one box for types and members by
 * name (`AccKeys` finds AccountingKeys), files by path, and lines with the
 * text in them, across every repo of the session. Enter opens the place in
 * the Code tab at its line. ↑/↓ move, Esc closes.
 */
export function CodeSearch({ sessionId, onPick, onClose }: { sessionId: string; onPick: (p: CodePlace) => void; onClose: () => void }) {
  const [query, setQuery] = useState('');
  const [wire, setWire] = useState<CodeSearchWire | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [listing, setListing] = useState<CodeFilesWire | null>(null);
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const listId = useId();

  useEffect(() => inputRef.current?.focus(), []);
  useEffect(() => {
    fetchCodeFiles(sessionId).then(setListing, () => {});
  }, [sessionId]);

  // Asked a moment after the last keystroke; a newer search drops the older (and git stops with it).
  useEffect(() => {
    const q = query.trim();
    if (q.length < MIN_CHARS) {
      setWire(null);
      setBusy(false);
      return;
    }
    const ac = new AbortController();
    setBusy(true);
    const t = setTimeout(() => {
      fetchCodeSearch(sessionId, q, ac.signal).then(
        (w) => {
          setWire(w);
          setError(null);
          setBusy(false);
        },
        (err: Error) => {
          if (ac.signal.aborted) return;
          setError(err.message);
          setBusy(false);
        },
      );
    }, TYPING_PAUSE_MS);
    return () => {
      clearTimeout(t);
      ac.abort();
    };
  }, [sessionId, query]);

  const entries = useMemo(() => (listing ? codeEntries(listing) : []), [listing]);
  const files = useMemo(() => (query.trim().length >= MIN_CHARS ? filterEntries(entries, query) : []), [entries, query]);
  // The server's answer is for what was typed then; files follow the box at once.
  const groups = useMemo(
    () => searchGroups(wire && wire.query === query.trim() ? wire : null, files, !!listing?.group),
    [wire, files, query, listing],
  );
  const rows = useMemo(() => groups.flatMap((g) => g.rows), [groups]);
  useEffect(() => setActive(0), [query]);
  useEffect(() => {
    listRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  const pick = (r: SearchRow | undefined) => {
    if (!r) return;
    onClose();
    onPick({ repo: r.repo, path: r.path, line: r.line });
  };

  let i = -1;
  return (
    <div className="wd-switcher-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="wd-switcher wd-code-search" role="dialog" aria-modal="true" aria-label="Search the code">
        <input
          ref={inputRef}
          className="wd-switcher-input"
          type="text"
          role="combobox"
          aria-expanded="true"
          aria-controls={listId}
          aria-activedescendant={rows[active] ? `${listId}-${active}` : undefined}
          placeholder="Search the code: a type or member (AccKeys), a file, or any text…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              setActive((x) => Math.min(x + 1, rows.length - 1));
            } else if (e.key === 'ArrowUp') {
              e.preventDefault();
              setActive((x) => Math.max(x - 1, 0));
            } else if (e.key === 'Enter') {
              e.preventDefault();
              pick(rows[active]);
            } else if (e.key === 'Escape') {
              e.preventDefault();
              onClose();
            } else if (e.key === 'Tab') {
              e.preventDefault();
            }
          }}
        />
        <ul id={listId} ref={listRef} className="wd-switcher-list wd-code-search-list" role="listbox">
          {query.trim().length < MIN_CHARS ? (
            <li className="wd-switcher-empty">Type at least two letters.</li>
          ) : error ? (
            <li className="wd-switcher-empty">{error}</li>
          ) : rows.length === 0 ? (
            <li className="wd-switcher-empty">{busy ? 'Searching…' : `Nothing has “${query.trim()}”.`}</li>
          ) : (
            groups.map((g) => (
              <li key={g.title} role="presentation">
                <div className="wd-code-search-heading">{g.title}</div>
                <ul role="presentation">
                  {g.rows.map((r) => {
                    i++;
                    const at = i;
                    return (
                      <li
                        key={r.key}
                        id={`${listId}-${at}`}
                        role="option"
                        aria-selected={at === active}
                        className={'wd-switcher-item wd-code-search-item' + (at === active ? ' wd-switcher-item-active' : '')}
                        onMouseDown={(e) => {
                          e.preventDefault();
                          pick(r);
                        }}
                        onMouseEnter={() => setActive(at)}
                      >
                        {r.symbolKind && <span className={`wd-code-kind wd-code-kind-${r.symbolKind}`}>{r.symbolKind}</span>}
                        <span className={'wd-switcher-name' + (r.kind === 'text' ? ' wd-code-search-line' : '')}>
                          {r.kind === 'text' ? <Marked text={r.label} query={query} /> : r.label}
                        </span>
                        <span className="wd-switcher-sub">{r.kind === 'symbol' ? r.sub.slice(r.sub.indexOf(' · ') + 3) : r.sub}</span>
                      </li>
                    );
                  })}
                </ul>
              </li>
            ))
          )}
        </ul>
        <p className="wd-switcher-hint">
          {busy && rows.length > 0 ? 'Searching… · ' : ''}
          <kbd>↑</kbd> <kbd>↓</kbd> to move · <kbd>Enter</kbd> to open at the line · <kbd>Esc</kbd> to close
        </p>
      </div>
    </div>
  );
}

/** The line with what was searched for marked. */
function Marked({ text, query }: { text: string; query: string }) {
  const r = matchRange(text, query);
  if (!r) return <>{text}</>;
  return (
    <>
      {text.slice(0, r[0])}
      <mark>{text.slice(r[0], r[1])}</mark>
      {text.slice(r[1])}
    </>
  );
}
