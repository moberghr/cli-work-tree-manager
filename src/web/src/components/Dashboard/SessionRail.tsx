import { useEffect, useMemo, useRef, useState } from 'react';
import { behindText } from './BehindChip.js';
import { RowMenu, type MenuItem } from './RowMenu.js';
import { EMPTY_RAIL_LAYOUT, MAX_SECTION_NAME, placeForGroup, type PlacePatch, type RailGroup, type RailLayout, type SectionOp } from '../../../../core/rail-layout.js';
import { newSectionId, railMenuItems } from '../../state/rail-menu.js';
import { StatusIcon } from './StatusIcon.js';
import type { SessionSummary } from '../../api/client.js';
import { ClaudesChip, PrChips, otherBranchText } from './SessionBits.js';
import { StatusLegend } from './StatusLegend.js';
import {
  DISPLAY_LABEL,
  displayStatus,
  formatDiffStat,
  railGroups,
  railSessions,
  sessionMatches,
  type DisplayKind,
  type PrLookup,
} from '../../state/session-display.js';
import { relativeTime } from '../../utils/time.js';
import { moveSession } from '../../../../core/session-order.js';
import { lastActiveAt } from '../../state/session-display.js';

interface Props {
  sessions: SessionSummary[];
  /** Currently-drilled-into session, if any. Highlights the matching
   *  rail item. */
  activeSessionId: string | null;
  onSelect: (id: string) => void;
  onNewWorktree: () => void;
  /** Open PRs for a session (from the PRs pane data); optional — rows just
   *  skip the badge without it. */
  prsFor?: PrLookup;
  /** Your drag order (session ids, top first). */
  order?: string[];
  /** Set when rows can be dragged (or moved with Alt+↑/↓) into a new order. */
  onReorder?: (order: string[]) => void;
  /** Set when sessions can be renamed here: F2, or right-click → Rename. An
   *  empty title goes back to the automatic one. */
  onRename?: (id: string, title: string) => Promise<void>;
  /** A row's right-click menu after Rename: archive, open, copy, delete… (the app builds it). */
  menuFor?: (s: SessionSummary) => MenuItem[];
  /** Your pins and sections (rail-layout.ts). */
  layout?: RailLayout;
  /** Set when rows can be pinned or moved into sections (menu, or a drag into another group). */
  onPlace?: (id: string, patch: PlacePatch) => void;
  /** Set when sections can be added, renamed, reordered, removed (one change at a time, applied by the server). */
  onSections?: (op: SectionOp) => Promise<void>;
}

/** Right-hand status slot: the one thing worth saying about this row. The
 *  status icon on the left says what it is; this says how long, or how many. */
function statusSlot(s: SessionSummary, kind: DisplayKind): { text: string; cls: string } {
  const since = s.attention?.since ?? s.lastAccessedAt;
  if (s.snoozed) return { text: 'snoozed', cls: 'wd-rail-slot-snoozed' };
  if (kind === 'needs_input') return { text: relativeTime(since), cls: 'wd-rail-slot-needs' };
  if (kind === 'done') return { text: relativeTime(since), cls: 'wd-rail-slot-done' };
  if (kind === 'working') return { text: relativeTime(since), cls: 'wd-rail-slot-working' };
  if (kind === 'review') return { text: String(s.openReviewThreads), cls: 'wd-rail-slot-review' };
  return { text: relativeTime(lastActiveAt(s)), cls: '' };
}

/**
 * Left navigation rail — every non-archived session as a compact two-line
 * row (Emdash-style): branch + status slot, then `target · summary` with the
 * diff size and PR badge. Always visible across dashboard tabs so the user
 * can context-switch in one click without losing the lens they're on.
 *
 * Order is yours: drag a row (or Alt+↑/↓ on it) and it stays there, in
 * every window (state.db). Rows you never placed come first, in the stable
 * order (project, then most recently entered — stableSessionOrder). Urgency
 * ordering lives in the Inbox and on `n`.
 *
 * Grouped too, when you want: pinned sessions on top, then your sections
 * (right-click a row → Pin / Move to / New section…, or drag it under a
 * heading), then the rest. Headings fold (remembered in this browser).
 * Alt+1…9 opens the first nine rows as shown.
 */
export function SessionRail({
  sessions,
  activeSessionId,
  onSelect,
  onNewWorktree,
  prsFor,
  order,
  onReorder,
  onRename,
  menuFor,
  layout = EMPTY_RAIL_LAYOUT,
  onPlace,
  onSections,
}: Props) {
  const [showOlder, setShowOlder] = useState(false);
  const [query, setQuery] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [drop, setDrop] = useState<{ id: string; before: boolean } | { group: string } | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  const [sectionMenu, setSectionMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  // Naming a section: a new one (for the session it was asked from), or renaming one.
  const [naming, setNaming] = useState<{ kind: 'new'; sessionId: string | null } | { kind: 'rename'; sectionId: string } | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(readCollapsed);
  const searching = query.trim() !== '';
  const total = useMemo(() => railSessions(sessions, Date.now(), []), [sessions]);
  const anySessions = total.current.length + total.older.length > 0;
  // Every current session, plus older ones only on request — and the
  // selected one and the pinned ones always stay visible. A search looks
  // through the older sessions too, in one list.
  const { groups, hidden } = useMemo(() => {
    if (searching) {
      const { current, older } = railSessions(sessions, Date.now(), order ?? []);
      return { groups: [{ key: 'search', title: null, sessions: [...current, ...older].filter((s) => sessionMatches(s, query)) }] as RailGroup<SessionSummary>[], hidden: 0 };
    }
    return railGroups(sessions, { order, layout, activeId: activeSessionId, showOlder });
  }, [sessions, order, layout, activeSessionId, showOlder, searching, query]);
  // A folded group still shows the selected row.
  const rowsOf = (g: RailGroup<SessionSummary>) => (collapsed.has(g.key) ? g.sessions.filter((s) => s.id === activeSessionId) : g.sessions);
  const visible = groups.flatMap(rowsOf);
  const groupOf = new Map(groups.flatMap((g) => g.sessions.map((s) => [s.id, g] as const)));
  // Moving a row among search results would scramble the full order.
  const canReorder = !!onReorder && !searching;
  const canPlace = !!onPlace && !searching;

  const toggle = (key: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (!next.delete(key)) next.add(key);
      writeCollapsed(next);
      return next;
    });

  // `/` jumps to the search box — not while typing somewhere (a terminal's
  // input included, so `/` in Claude still reaches Claude).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== '/' || e.ctrlKey || e.metaKey || e.altKey) return;
      const el = document.activeElement as HTMLElement | null;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return;
      if (document.querySelector('[role="dialog"], [role="alertdialog"], [aria-modal="true"], [role="menu"]')) return;
      e.preventDefault();
      searchRef.current?.focus();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Alt+1…9 opens the rail's first nine rows as shown (pinned first) — from
  // anywhere, a terminal included (capture phase, before xterm takes it), but
  // not while typing in a field or with a dialog up.
  const visibleRef = useRef(visible);
  visibleRef.current = visible;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
      const n = /^Digit([1-9])$/.exec(e.code)?.[1];
      if (!n) return;
      const el = document.activeElement as HTMLElement | null;
      const inTerminal = !!el?.classList.contains('xterm-helper-textarea');
      if (el && !inTerminal && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return;
      if (document.querySelector('[role="dialog"], [role="alertdialog"], [aria-modal="true"], [role="menu"]')) return;
      const target = visibleRef.current[Number(n) - 1];
      if (!target) return;
      e.preventDefault();
      e.stopPropagation();
      onSelect(target.id);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onSelect]);

  // F2 renames the open session — not while typing somewhere (a terminal's
  // input included) or with a dialog up.
  useEffect(() => {
    if (!onRename || !activeSessionId) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'F2' || e.ctrlKey || e.metaKey || e.altKey || e.defaultPrevented) return;
      const el = document.activeElement as HTMLElement | null;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return;
      if (document.querySelector('[role="dialog"], [role="alertdialog"], [aria-modal="true"], [role="menu"]')) return;
      e.preventDefault();
      setRenamingId(activeSessionId);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onRename, activeSessionId]);

  const shownIds = visible.map((s) => s.id);
  const move = (id: string, beforeId: string | null) => {
    if (canReorder) onReorder?.(moveSession(shownIds, id, beforeId, order ?? []));
  };
  // Dropped into another group: it moves there (pinned, a section, or out of one).
  const moveToGroup = (id: string, g: RailGroup<SessionSummary> | undefined) => {
    if (!canPlace || !g || groupOf.get(id)?.key === g.key) return;
    onPlace?.(id, placeForGroup(g));
  };
  const endDrag = () => {
    setDragId(null);
    setDrop(null);
  };

  const saveSectionName = async (name: string) => {
    const n = naming;
    if (!n || !onSections || !name) return;
    if (n.kind === 'rename') return onSections({ op: 'rename', id: n.sectionId, name });
    const id = newSectionId();
    await onSections({ op: 'add', id, name });
    if (n.sessionId) onPlace?.(n.sessionId, { pinned: false, section: id });
  };
  const moveSection = (id: string, by: -1 | 1) => void onSections?.({ op: 'move', id, by }).catch(() => {});

  const renderRow = (s: SessionSummary, index: number) => {
    const kind = displayStatus(s);
    const isActive = s.id === activeSessionId;
    // Your name for it, when you gave one; else its branch.
    const named = s.titleIsYours && !!s.title;
    const label = named ? s.title! : s.branch || s.target;
    const other = otherBranchText(s);
    const behind = behindText(s);
    const slot = statusSlot(s, kind);
    const stat = formatDiffStat(s);
    const prs = prsFor?.(s) ?? [];
    const summary = s.attention?.summary;
    if (onRename && renamingId === s.id) {
      return (
        <li key={s.id}>
          <RenameRow
            session={s}
            dot={<StatusIcon kind={kind} />}
            onDone={() => setRenamingId(null)}
            onSave={(title) => onRename(s.id, title)}
          />
        </li>
      );
    }
    const over = drop && 'id' in drop && drop.id === s.id && dragId !== s.id ? drop : null;
    return (
      <li
        key={s.id}
        draggable={canReorder || canPlace}
        className={(dragId === s.id ? 'wd-dash-rail-dragging' : '') + (over ? (over.before ? ' wd-dash-rail-drop-before' : ' wd-dash-rail-drop-after') : '')}
        onDragStart={(e) => {
          setDragId(s.id);
          e.dataTransfer.effectAllowed = 'move';
          e.dataTransfer.setData('text/plain', s.id);
        }}
        onDragOver={(e) => {
          if (!dragId) return;
          e.preventDefault();
          const r = e.currentTarget.getBoundingClientRect();
          const before = e.clientY < r.top + r.height / 2;
          if (!over || over.before !== before) setDrop({ id: s.id, before });
        }}
        onDrop={(e) => {
          e.preventDefault();
          if (dragId && drop && 'id' in drop) {
            moveToGroup(dragId, groupOf.get(drop.id));
            const i = shownIds.indexOf(drop.id);
            move(dragId, drop.before ? drop.id : shownIds[i + 1] ?? null);
          }
          endDrag();
        }}
        onDragEnd={endDrag}
      >
        <button
          type="button"
          className={
            'wd-dash-rail-item' +
            (isActive ? ' wd-dash-rail-item-active' : '') +
            ((kind === 'needs_input' || kind === 'done' || kind === 'review') && !s.snoozed ? ' wd-dash-rail-item-unseen' : '')
          }
          onClick={() => onSelect(s.id)}
          onContextMenu={(e) => {
            if (!onRename && !menuFor && !onPlace) return;
            e.preventDefault();
            setMenu({ id: s.id, x: e.clientX, y: e.clientY });
          }}
          onKeyDown={(e) => {
            if (onRename && e.key === 'F2') {
              e.preventDefault();
              setRenamingId(s.id);
              return;
            }
            if (!canReorder || !e.altKey || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return;
            e.preventDefault();
            const i = shownIds.indexOf(s.id);
            if (e.key === 'ArrowUp' && i > 0) move(s.id, shownIds[i - 1]);
            if (e.key === 'ArrowDown' && i < shownIds.length - 1) move(s.id, shownIds[i + 2] ?? null);
          }}
          title={
            `${s.target} · ${s.branch}${other ? ` (${other})` : ''}${s.stackedOn ? ` · stacked on ${s.stackedOn.branch}` : ''}${behind ? ` · ${behind}` : ''}${s.title ? `\n${s.title}` : ''}\n${DISPLAY_LABEL[kind]}` +
            (summary ? ` — ${summary}` : '') +
            (index < 9 ? `\nAlt+${index + 1}` : '')
          }
        >
          <StatusIcon kind={kind} labelled muted={!!s.snoozed} />
          <span className="wd-dash-rail-lines">
            <span className="wd-dash-rail-line">
              <span className="wd-dash-rail-name">{label}</span>
              <span className={'wd-dash-rail-slot ' + slot.cls}>{slot.text}</span>
            </span>
            <span className="wd-dash-rail-line wd-dash-rail-sub">
              <span className="wd-dash-rail-summary">
                {s.target}
                {named ? ` · ${s.branch}` : summary ? ` · ${summary}` : s.title ? ` · ${s.title}` : ''}
              </span>
              {!!s.pendingForClaudeCount && s.pendingForClaudeCount > 0 && (
                <span className="wd-dash-rail-pending" title={`${s.pendingForClaudeCount} pending for Claude`}>
                  →{s.pendingForClaudeCount}
                </span>
              )}
              {stat && (
                <span className="wd-dash-rail-stat" title={`${s.diffStat!.files} file(s) changed`}>
                  {stat}
                </span>
              )}
              <PrChips prs={prs} />
              <ClaudesChip session={s} compact />
            </span>
          </span>
        </button>
      </li>
    );
  };

  let index = 0;
  return (
    <aside
      className="wd-dash-rail"
      role="navigation"
      aria-label="Sessions"
    >
      <header className="wd-dash-rail-header">
        <h2>Sessions</h2>
        <StatusLegend />
        <button
          type="button"
          className="wd-dash-rail-new"
          onClick={onNewWorktree}
          title="New worktree"
          aria-label="New worktree"
        >
          +
        </button>
      </header>
      {anySessions && (
        <input
          ref={searchRef}
          className="wd-dash-rail-search"
          type="search"
          placeholder="Search sessions   /"
          title="Filter this list (/). Ctrl+P jumps to any session from anywhere, a terminal included; Alt+1…9 opens the first nine rows."
          aria-label="Search sessions"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              setQuery('');
              e.currentTarget.blur();
            } else if (e.key === 'Enter' && visible[0]) {
              onSelect(visible[0].id);
            } else if (e.key === 'ArrowDown') {
              e.preventDefault();
              listRef.current?.querySelector<HTMLButtonElement>('.wd-dash-rail-item')?.focus();
            }
          }}
        />
      )}
      {searching && visible.length === 0 && <p className="wd-dash-rail-empty">No session matches “{query.trim()}”.</p>}
      {!anySessions ? (
        <p className="wd-dash-rail-empty">
          No worktrees yet. Click + to create one.
        </p>
      ) : (
        <ul className="wd-dash-rail-list" ref={listRef}>
          {naming?.kind === 'new' && (
            <li>
              <SectionNameInput initial="" placeholder="New section name" onSave={saveSectionName} onDone={() => setNaming(null)} />
            </li>
          )}
          {groups.map((g) => {
            const folded = collapsed.has(g.key);
            const rows = rowsOf(g);
            const dropHere = drop && 'group' in drop && drop.group === g.key;
            return [
              g.title !== null &&
                (naming?.kind === 'rename' && naming.sectionId === g.sectionId ? (
                  <li key={`h:${g.key}`}>
                    <SectionNameInput initial={g.title} placeholder="Section name" onSave={saveSectionName} onDone={() => setNaming(null)} />
                  </li>
                ) : (
                  <li
                    key={`h:${g.key}`}
                    className={'wd-dash-rail-group' + (dropHere ? ' wd-dash-rail-group-drop' : '')}
                    onDragOver={(e) => {
                      if (!dragId || !canPlace) return;
                      e.preventDefault();
                      if (!dropHere) setDrop({ group: g.key });
                    }}
                    onDrop={(e) => {
                      e.preventDefault();
                      if (dragId) moveToGroup(dragId, g);
                      endDrag();
                    }}
                  >
                    <button
                      type="button"
                      className="wd-dash-rail-group-toggle"
                      aria-expanded={!folded}
                      onClick={() => toggle(g.key)}
                      onContextMenu={(e) => {
                        if (!g.sectionId || !onSections) return;
                        e.preventDefault();
                        setSectionMenu({ id: g.sectionId, x: e.clientX, y: e.clientY });
                      }}
                      title={g.sectionId ? 'Fold or unfold; right-click to rename, move or remove it' : 'Fold or unfold'}
                    >
                      <span className="wd-dash-rail-group-caret" aria-hidden="true">{folded ? '▸' : '▾'}</span>
                      <span className="wd-dash-rail-group-name">{g.title}</span>
                      <span className="wd-dash-rail-group-count">{g.sessions.length}</span>
                    </button>
                  </li>
                )),
              ...rows.map((s) => renderRow(s, index++)),
              !folded && g.sessions.length === 0 && (
                <li key={`e:${g.key}`} className="wd-dash-rail-group-empty">
                  {g.sectionId ? `Drag a session here, or right-click one → Move to “${g.title}”.` : 'Drag a session here to unpin it or take it out of its section.'}
                </li>
              ),
            ];
          })}
          {hidden > 0 && (
            <li className="wd-dash-rail-overflow">
              <button
                type="button"
                className="wd-dash-rail-older"
                onClick={() => setShowOlder(true)}
                title="Sessions not entered in the last 14 days and not running"
              >
                +{hidden} older
              </button>
            </li>
          )}
          {showOlder && !searching && total.older.length > 0 && (
            <li className="wd-dash-rail-overflow">
              <button type="button" className="wd-dash-rail-older" onClick={() => setShowOlder(false)}>
                Hide older
              </button>
            </li>
          )}
        </ul>
      )}
      {menu && (
        <RowMenu
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          items={(() => {
            const s = sessions.find((x) => x.id === menu.id);
            if (!s) return [];
            const rename = onRename ? [{ label: 'Rename', hint: 'F2', run: () => setRenamingId(menu.id) }] : [];
            const place = onPlace
              ? railMenuItems(s, layout, {
                  place: (x, patch) => onPlace(x.id, patch),
                  newSection: (x) => setNaming({ kind: 'new', sessionId: x.id }),
                })
              : [];
            const rest = menuFor ? menuFor(s).map((item, i) => (i === 0 ? { ...item, separated: true } : item)) : [];
            return [...rename, ...place, ...rest];
          })()}
        />
      )}
      {sectionMenu && (
        <RowMenu
          x={sectionMenu.x}
          y={sectionMenu.y}
          onClose={() => setSectionMenu(null)}
          items={[
            { label: 'Rename section', run: () => setNaming({ kind: 'rename', sectionId: sectionMenu.id }) },
            { label: 'Move up', run: () => moveSection(sectionMenu.id, -1) },
            { label: 'Move down', run: () => moveSection(sectionMenu.id, 1) },
            { label: 'New section…', run: () => setNaming({ kind: 'new', sessionId: null }), separated: true },
            {
              label: 'Remove section',
              hint: 'its sessions stay',
              danger: true,
              separated: true,
              run: () => void onSections?.({ op: 'remove', id: sectionMenu.id }).catch(() => {}),
            },
          ]}
        />
      )}
    </aside>
  );
}

const COLLAPSED_KEY = 'work-web:rail-collapsed';

/** Which groups you folded: this browser's, not every window's (a view preference). */
function readCollapsed(): Set<string> {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(COLLAPSED_KEY) ?? '[]');
    return new Set(Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
  } catch {
    return new Set();
  }
}

function writeCollapsed(keys: Set<string>): void {
  try {
    localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...keys]));
  } catch {
    /* storage blocked: it just won't be remembered */
  }
}

/** A section's name being typed: Enter saves, Esc or leaving it cancels. */
function SectionNameInput({
  initial,
  placeholder,
  onSave,
  onDone,
}: {
  initial: string;
  placeholder: string;
  onSave: (name: string) => Promise<void> | void;
  onDone: () => void;
}) {
  const [draft, setDraft] = useState(initial);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = () => {
    const name = draft.trim();
    if (!name) return onDone();
    setSaving(true);
    Promise.resolve(onSave(name)).then(onDone, (err: Error) => {
      setSaving(false);
      setError(err.message);
    });
  };
  return (
    <div className="wd-dash-rail-group wd-dash-rail-group-naming">
      <input
        className="wd-dash-rail-rename"
        autoFocus
        value={draft}
        disabled={saving}
        maxLength={MAX_SECTION_NAME}
        placeholder={placeholder}
        aria-label={placeholder}
        title={error ?? 'Enter to save, Esc to cancel'}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => !saving && onDone()}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            save();
          } else if (e.key === 'Escape') {
            e.preventDefault();
            onDone();
          }
        }}
      />
      {error && <span className="wd-dash-rail-group-error">⚠ {error}</span>}
    </div>
  );
}

/** A rail row being renamed: Enter saves, Esc or leaving it cancels. */
function RenameRow({
  session,
  dot,
  onSave,
  onDone,
}: {
  session: SessionSummary;
  dot: React.ReactNode;
  onSave: (title: string) => Promise<void>;
  onDone: () => void;
}) {
  const [draft, setDraft] = useState(session.titleIsYours ? (session.title ?? '') : '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = () => {
    setSaving(true);
    setError(null);
    onSave(draft.trim()).then(onDone, (err: Error) => {
      setSaving(false);
      setError(err.message);
    });
  };
  return (
    <div className="wd-dash-rail-item wd-dash-rail-item-renaming">
      {dot}
      <span className="wd-dash-rail-lines">
        <input
          className="wd-dash-rail-rename"
          autoFocus
          value={draft}
          disabled={saving}
          placeholder={session.title ?? 'Name this session'}
          aria-label={`Name for ${session.branch || session.target}`}
          title={error ?? 'Enter to save, Esc to cancel; empty goes back to the automatic name'}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => !saving && onDone()}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              save();
            } else if (e.key === 'Escape') {
              e.preventDefault();
              onDone();
            }
          }}
        />
        <span className="wd-dash-rail-line wd-dash-rail-sub">
          <span className="wd-dash-rail-summary">{error ? `⚠ ${error}` : `${session.target} · ${session.branch}`}</span>
        </span>
      </span>
    </div>
  );
}
