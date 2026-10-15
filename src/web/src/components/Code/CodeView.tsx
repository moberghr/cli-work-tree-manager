import { useEffect, useMemo, useRef, useState } from 'react';
import type { CodeFileWire, CodeFilesWire } from '../../../../core/api-types.js';
import { fetchCodeFile, fetchCodeFiles, type SessionSummary } from '../../api/client.js';
import { openInEditor } from '../../api/panes.js';
import { useSse } from '../../api/events.js';
import { codeEntries, codeKey, entryOf, filterEntries, foldersOf, indexFolders, type CodeEntry } from '../../state/code-tree.js';
import type { CodePlace } from '../../state/code-search-view.js';
import { highlightBlock, resolveHighlightLang } from '../../utils/highlight.js';

/** Highlighted up to this many lines; plain past it (a generated file shouldn't stall the page). */
const HIGHLIGHT_MAX_LINES = 8000;

/** Per session, for this page: the open file and folders, so a look at another tab comes back to them. */
const remembered = new Map<string, { open: string | null; folders: Set<string>; picked: number; unfolded: number }>();
const memoryOf = (id: string) => {
  let m = remembered.get(id);
  // picked / unfolded: the last search pick applied, and the last whose folders were opened (a pick is applied
  // once: coming back to the tab keeps the file you opened since).
  if (!m) remembered.set(id, (m = { open: null, folders: new Set(), picked: 0, unfolded: 0 }));
  return m;
};

/**
 * The Code tab: the session's files, to read the rest of the code around a
 * change. A tree (a group's repos as folders), a filter over every file, and
 * the open file read only with its highlighting. Files changed on the branch
 * carry a dot and "See the change". A file Claude changes while it's open
 * isn't swapped under you: "Changed · Reload" (as the Diff tab stages its
 * updates).
 */
export function CodeView({
  session,
  onShowDiff,
  goto,
  onSearch,
}: {
  session: SessionSummary;
  onShowDiff: () => void;
  /** Open this place (a search's pick): its file, scrolled to its line and marked. `seq` tells a second pick of the same place apart. */
  goto?: (CodePlace & { seq: number }) | null;
  /** Ctrl+T's box: types, members, files and text. */
  onSearch?: () => void;
}) {
  const memory = memoryOf(session.id);
  const [listing, setListing] = useState<CodeFilesWire | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [open, setOpenState] = useState<string | null>(memory.open);
  const [folders, setFolders] = useState<Set<string>>(memory.folders);
  const [file, setFile] = useState<CodeFileWire | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  // A newer version of the open file, held back until you reload it.
  const [newer, setNewer] = useState<CodeFileWire | null>(null);
  // The line a search picked: marked, and scrolled to once the file is drawn.
  const [mark, setMark] = useState<{ key: string; line: number; seq: number } | null>(null);
  // Why the editor didn't open (not installed, the demo), for the file it was asked for.
  const [editorError, setEditorError] = useState<{ key: string; text: string } | null>(null);

  const entries = useMemo(() => (listing ? codeEntries(listing) : []), [listing]);
  const byKey = useMemo(() => new Map(entries.map((e) => [e.key, e])), [entries]);
  const index = useMemo(() => indexFolders(entries), [entries]);
  const matches = useMemo(() => filterEntries(entries, query), [entries, query]);
  // Not in the listing (new since it was read, or past a big repo's cut): a search's pick still opens.
  const openEntry = open && listing ? entryOf(listing, open, byKey) : null;

  // Shared with Ctrl+T's box for a while (client.ts); `fresh` when the worktree changed.
  const loadList = (fresh = false) => {
    fetchCodeFiles(session.id, { fresh }).then(
      (w) => {
        setListing(w);
        setListError(null);
      },
      (err: Error) => setListError(err.message),
    );
  };
  useEffect(() => loadList(), [session.id]); // eslint-disable-line react-hooks/exhaustive-deps -- once per session; the stream reloads it

  // A search's pick: its file opens at its line, once (a later visit to the tab keeps what you opened since);
  // its folders open once the listing has it.
  useEffect(() => {
    if (!goto) return;
    const key = codeKey(goto.repo, goto.path);
    if (memory.picked !== goto.seq) {
      memory.picked = goto.seq;
      setOpen(key);
      setMark(goto.line ? { key, line: goto.line, seq: goto.seq } : null);
    }
    const entry = byKey.get(key);
    if (entry && memory.unfolded !== goto.seq) {
      memory.unfolded = goto.seq;
      const next = new Set(folders);
      for (const d of foldersOf(entry.display)) next.add(d);
      memory.folders = next;
      setFolders(next);
    }
  }, [goto?.seq, byKey.size > 0]); // eslint-disable-line react-hooks/exhaustive-deps -- a new pick, or the listing it needed arriving

  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!mark || mark.key !== open || !file) return;
    scrollRef.current?.querySelector(`[data-line="${mark.line}"]`)?.scrollIntoView({ block: 'center' });
  }, [mark, open, file]);

  const setOpen = (key: string | null) => {
    memory.open = key;
    setOpenState(key);
  };
  const toggleFolder = (dir: string) => {
    const next = new Set(folders);
    if (next.has(dir)) next.delete(dir);
    else next.add(dir);
    memory.folders = next;
    setFolders(next);
  };
  const pick = (e: CodeEntry) => {
    setOpen(e.key);
    // Opened from the filter: its folders open too, so the tree shows where it is.
    const next = new Set(folders);
    for (const d of foldersOf(e.display)) next.add(d);
    memory.folders = next;
    setFolders(next);
  };

  // The open file: read when picked; read again (staged, not swapped) when the worktree changes.
  const fileFor = useRef<string | null>(null);
  useEffect(() => {
    setFile(null);
    setFileError(null);
    setNewer(null);
    fileFor.current = openEntry?.key ?? null;
    if (!openEntry) return;
    const key = openEntry.key;
    fetchCodeFile(session.id, openEntry.repo, openEntry.path).then(
      (f) => fileFor.current === key && setFile(f),
      (err: Error) => fileFor.current === key && setFileError(err.message),
    );
  }, [session.id, openEntry?.key]); // eslint-disable-line react-hooks/exhaustive-deps -- the entry object changes with every listing

  const recheck = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => void (recheck.current && clearTimeout(recheck.current)), []);
  useSse(`/events?session=${encodeURIComponent(session.id)}`, {
    events: {
      'diff-changed': () => {
        // A burst of writes (a turn) reads once, a moment after.
        if (recheck.current) clearTimeout(recheck.current);
        recheck.current = setTimeout(() => {
          loadList(true);
          const e = openEntry;
          if (!e || !file) return;
          const key = e.key;
          fetchCodeFile(session.id, e.repo, e.path).then(
            (f) => fileFor.current === key && f.text !== file.text && setNewer(f),
            () => {},
          );
        }, 800);
      },
    },
  });

  // The open file in the editor, where you are in it: the line a search marked, else the top one on screen.
  const openFileInEditor = () => {
    if (!openEntry) return;
    const key = openEntry.key;
    const line = mark && mark.key === key ? mark.line : lineAtTop(scrollRef.current);
    setEditorError(null);
    openInEditor(session.id, { repo: openEntry.repo, path: openEntry.path, line }).catch((err: Error) =>
      setEditorError({ key, text: `Couldn't open the editor: ${err.message}` }),
    );
  };

  const lines = useMemo(() => (file?.text != null ? file.text.replace(/\r?\n$/, '').split(/\r?\n/) : null), [file]);
  const html = useMemo(() => {
    if (!lines || !openEntry || lines.length > HIGHLIGHT_MAX_LINES) return null;
    const lang = resolveHighlightLang(openEntry.path);
    return lang ? highlightBlock(lines, lang) : null;
  }, [lines, openEntry]);

  return (
    <div className="wd-code">
      <aside className="wd-code-side" aria-label="Files">
        {onSearch && (
          <button
            type="button"
            className="wd-code-search-btn"
            onClick={onSearch}
            title="Types and members by name, files, and text in them"
          >
            <span>Search the code…</span>
            <kbd>Ctrl+T</kbd>
          </button>
        )}
        <input
          className="wd-code-filter"
          type="search"
          placeholder={listing ? `Find a file (${entries.length.toLocaleString()})…` : 'Find a file…'}
          aria-label="Find a file"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') setQuery('');
            if (e.key === 'Enter' && matches[0]) pick(matches[0]);
          }}
        />
        <div className="wd-code-tree" role="tree">
          {listError && <p className="wd-code-note">{listError}</p>}
          {!listing && !listError && <p className="wd-code-note">Loading files…</p>}
          {listing && query.trim() ? (
            matches.length === 0 ? (
              <p className="wd-code-note">No file matches.</p>
            ) : (
              matches.map((e) => <FileRow key={e.key} entry={e} label={e.display} depth={0} open={e.key === open} onPick={() => pick(e)} />)
            )
          ) : (
            listing && <FolderRows dir="" depth={0} index={index} open={open} folders={folders} onToggle={toggleFolder} onPick={pick} />
          )}
          {listing?.repos.some((r) => r.truncated) && <p className="wd-code-note">Only the first 50,000 files of a repo are listed.</p>}
        </div>
      </aside>
      <section className="wd-code-main" aria-label="File">
        {!openEntry ? (
          <p className="wd-code-empty">
            Pick a file to read it{entries.some((e) => e.changed) ? ' — the ones with a dot changed on this branch' : ''}.
          </p>
        ) : (
          <>
            <header className="wd-code-head">
              <span className="wd-code-path" title={openEntry.display}>
                {openEntry.display}
              </span>
              {lines && (
                <span className="wd-code-meta">
                  {lines.length.toLocaleString()} line{lines.length === 1 ? '' : 's'}
                </span>
              )}
              {openEntry.changed && (
                <button type="button" className="wd-code-btn" onClick={onShowDiff} title="Open the Diff tab">
                  Changed on this branch · See the change
                </button>
              )}
              {newer && (
                <span className="wd-diff-update" role="status">
                  <span className="wd-diff-update-dot" aria-hidden="true" />
                  <span className="wd-diff-update-text">File changed</span>
                  <button
                    type="button"
                    className="wd-diff-update-btn wd-diff-update-btn-primary"
                    onClick={() => {
                      setFile(newer);
                      setNewer(null);
                    }}
                  >
                    Reload
                  </button>
                </span>
              )}
              <button
                type="button"
                className="wd-code-btn wd-code-open"
                onClick={openFileInEditor}
                title="Open this file in your editor (VS Code: at the line you're reading)"
              >
                Open in editor
              </button>
            </header>
            {editorError?.key === open && (
              <p className="wd-code-note wd-code-open-error" role="alert">
                {editorError.text}
              </p>
            )}
            {fileError ? (
              <p className="wd-code-note">{fileError}</p>
            ) : !file ? (
              <p className="wd-code-note">Loading…</p>
            ) : file.text === null ? (
              <p className="wd-code-note">
                {file.reason === 'binary'
                  ? 'A binary file: nothing to read here.'
                  : `Too big to show here (${(file.size / 1024 / 1024).toFixed(1)} MB). Open it in your editor.`}
              </p>
            ) : (
              <div className="wd-code-scroll" ref={scrollRef}>
                <table className="wd-fileview-table wd-code-table">
                  <tbody>
                    {lines!.map((content, i) => {
                      const h = html?.[i] ?? null;
                      return (
                        <tr
                          key={i}
                          data-line={i + 1}
                          className={'wd-fileview-row' + (mark && mark.key === open && mark.line === i + 1 ? ' wd-code-line-mark' : '')}
                        >
                          <td className="wd-fileview-ln">{i + 1}</td>
                          {h !== null ? (
                            <td className="wd-fileview-content" dangerouslySetInnerHTML={{ __html: h }} />
                          ) : (
                            <td className="wd-fileview-content">{content || ' '}</td>
                          )}
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}
      </section>
    </div>
  );
}

function FolderRows({
  dir,
  depth,
  index,
  open,
  folders,
  onToggle,
  onPick,
}: {
  dir: string;
  depth: number;
  index: Map<string, import('../../state/code-tree.js').Folder>;
  open: string | null;
  folders: Set<string>;
  onToggle: (dir: string) => void;
  onPick: (e: CodeEntry) => void;
}) {
  const here = index.get(dir);
  if (!here) return null;
  return (
    <>
      {here.dirs.map((name) => {
        const path = dir ? `${dir}/${name}` : name;
        const isOpen = folders.has(path);
        const changed = index.get(path)?.changed ?? 0;
        return (
          <div key={path} role="none">
            <button
              type="button"
              role="treeitem"
              aria-expanded={isOpen}
              className="wd-code-row wd-code-dir"
              style={{ paddingLeft: 8 + depth * 14 }}
              onClick={() => onToggle(path)}
              title={changed ? `${changed} changed on this branch` : undefined}
            >
              <span className="wd-code-caret" aria-hidden="true">
                {isOpen ? '▾' : '▸'}
              </span>
              <span className="wd-code-name">{name}</span>
              {changed > 0 && <span className="wd-code-changed-count">{changed}</span>}
            </button>
            {isOpen && (
              <FolderRows dir={path} depth={depth + 1} index={index} open={open} folders={folders} onToggle={onToggle} onPick={onPick} />
            )}
          </div>
        );
      })}
      {here.files.map((e) => (
        <FileRow
          key={e.key}
          entry={e}
          label={e.display.slice(e.display.lastIndexOf('/') + 1)}
          depth={depth}
          open={e.key === open}
          onPick={() => onPick(e)}
        />
      ))}
    </>
  );
}

function FileRow({
  entry,
  label,
  depth,
  open,
  onPick,
}: {
  entry: CodeEntry;
  label: string;
  depth: number;
  open: boolean;
  onPick: () => void;
}) {
  return (
    <button
      type="button"
      role="treeitem"
      aria-selected={open}
      className={'wd-code-row wd-code-file' + (open ? ' wd-code-row-open' : '')}
      style={{ paddingLeft: 22 + depth * 14 }}
      onClick={onPick}
      title={entry.display}
    >
      <span className="wd-code-name">{label}</span>
      {entry.changed && <span className="wd-code-dot" aria-label="changed on this branch" />}
    </button>
  );
}

/** The first line on screen in the open file (none at the top: it opens there anyway). */
function lineAtTop(scroll: HTMLElement | null): number | undefined {
  if (!scroll || scroll.scrollTop <= 0) return undefined;
  const top = scroll.getBoundingClientRect().top;
  for (const tr of scroll.querySelectorAll<HTMLElement>('tr[data-line]')) {
    if (tr.getBoundingClientRect().bottom > top) return Number(tr.dataset.line);
  }
  return undefined;
}
