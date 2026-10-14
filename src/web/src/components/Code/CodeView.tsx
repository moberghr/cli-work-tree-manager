import { useEffect, useMemo, useRef, useState } from 'react';
import type { CodeFileWire, CodeFilesWire } from '../../../../core/api-types.js';
import { fetchCodeFile, fetchCodeFiles, type SessionSummary } from '../../api/client.js';
import { useSse } from '../../api/events.js';
import { codeEntries, filterEntries, foldersOf, indexFolders, type CodeEntry } from '../../state/code-tree.js';
import { highlightBlock, resolveHighlightLang } from '../../utils/highlight.js';

/** Highlighted up to this many lines; plain past it (a generated file shouldn't stall the page). */
const HIGHLIGHT_MAX_LINES = 8000;

/** Per session, for this page: the open file and folders, so a look at another tab comes back to them. */
const remembered = new Map<string, { open: string | null; folders: Set<string> }>();
const memoryOf = (id: string) => {
  let m = remembered.get(id);
  if (!m) remembered.set(id, (m = { open: null, folders: new Set() }));
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
export function CodeView({ session, onShowDiff }: { session: SessionSummary; onShowDiff: () => void }) {
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

  const entries = useMemo(() => (listing ? codeEntries(listing) : []), [listing]);
  const byKey = useMemo(() => new Map(entries.map((e) => [e.key, e])), [entries]);
  const index = useMemo(() => indexFolders(entries), [entries]);
  const matches = useMemo(() => filterEntries(entries, query), [entries, query]);
  const openEntry = open ? (byKey.get(open) ?? null) : null;

  const loadList = () => {
    const id = session.id;
    fetchCodeFiles(id).then(
      (w) => {
        if (memoryOf(id) !== memory) return;
        setListing(w);
        setListError(null);
      },
      (err: Error) => setListError(err.message),
    );
  };
  useEffect(loadList, [session.id]); // eslint-disable-line react-hooks/exhaustive-deps -- once per session; the stream reloads it

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
          loadList();
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

  const lines = useMemo(() => (file?.text != null ? file.text.replace(/\r?\n$/, '').split(/\r?\n/) : null), [file]);
  const html = useMemo(() => {
    if (!lines || !openEntry || lines.length > HIGHLIGHT_MAX_LINES) return null;
    const lang = resolveHighlightLang(openEntry.path);
    return lang ? highlightBlock(lines, lang) : null;
  }, [lines, openEntry]);

  return (
    <div className="wd-code">
      <aside className="wd-code-side" aria-label="Files">
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
            </header>
            {fileError ? (
              <p className="wd-code-note">{fileError}</p>
            ) : !file ? (
              <p className="wd-code-note">Loading…</p>
            ) : file.text === null ? (
              <p className="wd-code-note">
                {file.reason === 'binary'
                  ? 'A binary file: nothing to read here.'
                  : `Too big to show here (${(file.size / 1024 / 1024).toFixed(1)} MB). Open it in your editor (o).`}
              </p>
            ) : (
              <div className="wd-code-scroll">
                <table className="wd-fileview-table wd-code-table">
                  <tbody>
                    {lines!.map((content, i) => {
                      const h = html?.[i] ?? null;
                      return (
                        <tr key={i} className="wd-fileview-row">
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
