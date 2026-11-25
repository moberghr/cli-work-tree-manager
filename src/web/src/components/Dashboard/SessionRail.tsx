import { useEffect, useMemo, useRef, useState } from 'react';
import { behindText } from './BehindChip.js';
import {
  EMPTY_RAIL_LAYOUT,
  MAX_SECTION_NAME,
  placeForGroup,
  RAIL_COLOR_LABEL,
  type PlacePatch,
  type RailGroup,
  type RailLayout,
  type SectionOp,
  sessionColor,
} from '../../../../core/rail/rail-layout.js';
import { newSectionId, railMenuItems, tagClass } from '../../state/rail-menu.js';
import { StatusIcon } from './StatusIcon.js';
import type { SessionSummary } from '../../api/client.js';
import { otherBranchText, owedBadgeClass, RailPrMarks } from './SessionBits.js';
import { StatusLegend } from './StatusLegend.js';
import { DISPLAY_LABEL, displayStatus, OLDER_GROUP, owedBadge, type PrLookup } from '../../state/session-display.js';
import { railName, railPrMarks, railPrsText, railStatus, railTime, type RailPrMark } from '../../state/rail-row.js';
import { groupsForView, RAIL_VIEWS, readRailView, writeRailView, type RailView } from '../../state/rail-views.js';
import { moveSession } from '../../../../core/rail/session-order.js';
import { modalOpen } from '../../state/modal-open.js';
import { accountLabel } from '../../state/accounts.js';
import { snoozeLabel } from '../../../../core/rail/snooze.js';
import { Badge, Input, Menu, Segmented, type MenuItem } from '../../ui/index.js';

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
  /** The rows as shown, top to bottom (headings folded or not, Older among
   *  them), whenever that changes — so j/k walk what's on screen. */
  onShownChange?: (ids: string[]) => void;
}

/** What the "keep" mark on a row means (the rail and the Sessions table). */
export const KEEP_TITLE = 'Kept after its PR merges: it isn’t archived then. Right-click → Archive after its PR merges to undo.';

/** "in background: /mtk:code-review-and-quality Re-review…" — what's running while its prompt is free. Pure. */
export function backgroundLine(b: { what: string | null; command?: boolean }): string {
  return b.what ? `in background: ${b.what}` : b.command ? 'a background command is running' : 'a background agent is at work';
}

/**
 * What a rail row doesn't show on its face, for its tooltip: what runs in
 * the background while its prompt is free, until when it's snoozed, what it waits on, its PRs by number
 * with where each stands (the row shows them as dots: `prs`, else the PR watch's line), notes waiting for
 * Claude, your note, where its Claude runs.
 * Not its +/− lines: those are the Diff tab's. Pure (`now` for the snooze's wording).
 */
export function railDetails(s: SessionSummary, now = new Date(), prs?: { shown: RailPrMark[]; more: RailPrMark[] }): string {
  const c = s.agents ?? s.claudes;
  const bits = [
    s.attention?.background ? backgroundLine(s.attention.background) : '',
    s.snoozed ? `snoozed ${snoozeLabel(s.snoozed, now)}` : '',
    s.blockedBy?.length ? `waits on ${s.blockedBy.map((b) => b.label).join(', ')}` : '',
    (prs && railPrsText(prs)) || (s.prStage?.text ?? ''),
    s.pendingForClaudeCount ? `${s.pendingForClaudeCount} waiting for Claude` : '',
    s.hasNote ? 'has notes' : '',
    s.keepAfterMerge ? 'kept after its PR merges' : '',
    accountLabel(s.account),
    c?.duplicate ? 'two Claudes on one conversation' : c?.inTerminal ? 'running in a terminal' : '',
  ].filter(Boolean);
  return bits.length ? `\n${bits.join(' · ')}` : '';
}

/**
 * Left navigation rail — every non-archived session as a compact two-line
 * row, the same four places on every row (`state/rail-row.ts`): its name (a
 * branch's `feat/` muted) and a time, then its project and one status (what
 * you owe, else snoozed, else in review), `keep` and a dot per PR. Always
 * visible across dashboard tabs so the user can context-switch in one click
 * without losing the lens they're on.
 *
 * Order is yours: drag a row (or Alt+↑/↓ on it) and it stays there, in
 * every window (state.db). Rows you never placed come first, in the stable
 * order (project, then most recently entered — stableSessionOrder). Urgency
 * ordering lives in the Inbox and on `n`.
 *
 * Grouped too, when you want: pinned sessions on top, then your sections
 * (right-click a row → Pin / Move to / New section…, or drag it under a
 * heading), then the rest, then Older (not entered in 14 days and not
 * running; folded until you open it). Headings fold (remembered in this
 * browser). A color (right-click → Color) marks a row without moving it: a
 * bar down its left edge. Alt+1…9 opens the first nine rows as shown.
 *
 * That is the Mine view. The header's switch has State too (`state/rail-views.ts`): the same rows under Needs you,
 * Working, Idle, Snoozed and Older, in your order inside each; nothing is dragged or placed there (a row's menu
 * still pins and moves it in Mine). The view is remembered in this browser.
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
  onShownChange,
}: Props) {
  const [dragId, setDragId] = useState<string | null>(null);
  const [drop, setDrop] = useState<{ id: string; before: boolean } | { group: string } | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  const [sectionMenu, setSectionMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  // Naming a section: a new one (for the session it was asked from), or renaming one.
  const [naming, setNaming] = useState<{ kind: 'new'; sessionId: string | null } | { kind: 'rename'; sectionId: string } | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(readCollapsed);
  const [view, setView] = useState<RailView>(readRailView);
  // Mine: every current session in its group (the selected one and the pinned ones too, however old), then the rest
  // of the older ones under Older. State: the same rows by what they need.
  const { groups } = useMemo(
    () => groupsForView(view, sessions, { order, layout, activeId: activeSessionId }),
    [view, sessions, order, layout, activeSessionId],
  );
  const anySessions = groups.some((g) => g.sessions.length > 0);
  const folded = (key: string) => isFolded(collapsed, key);
  // A folded group still shows the selected row.
  const rowsOf = (g: RailGroup<SessionSummary>) => (folded(g.key) ? g.sessions.filter((s) => s.id === activeSessionId) : g.sessions);
  const visible = groups.flatMap(rowsOf);
  const groupOf = new Map(groups.flatMap((g) => g.sessions.map((s) => [s.id, g] as const)));
  // Older is not a section: a row is never placed into it or out of it, and moves only among its own kind.
  const inOlder = (id: string | null) => !!id && groupOf.get(id)?.key === OLDER_GROUP;
  // Placement is Mine's: in State nothing is dragged, moved with Alt+↑/↓ or dropped onto a heading.
  const mine = view === 'mine';
  const canReorder = mine && !!onReorder;
  const canPlace = mine && !!onPlace;
  const changeView = (v: RailView) => {
    setView(v);
    writeRailView(v);
    // Nothing half done in the view left behind: a drag, a section being named, its menu.
    setDragId(null);
    setDrop(null);
    setNaming(null);
    setSectionMenu(null);
  };

  const toggle = (key: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      const mark = foldMark(key);
      if (!next.delete(mark)) next.add(mark);
      writeCollapsed(next);
      return next;
    });

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
      if (modalOpen() || document.querySelector('[role="menu"]')) return;
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
      if (modalOpen() || document.querySelector('[role="menu"]')) return;
      e.preventDefault();
      setRenamingId(activeSessionId);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onRename, activeSessionId]);

  const shownIds = visible.map((s) => s.id);
  const shownKey = shownIds.join(',');
  useEffect(() => {
    onShownChange?.(shownKey ? shownKey.split(',') : []);
  }, [shownKey, onShownChange]);
  const move = (id: string, beforeId: string | null) => {
    if (canReorder) onReorder?.(moveSession(shownIds, id, beforeId, order ?? []));
  };
  // Dropped into another group: it moves there (pinned, a section, or out of one). Never into or out of Older.
  const moveToGroup = (id: string, g: RailGroup<SessionSummary> | undefined) => {
    if (!canPlace || !g || g.key === OLDER_GROUP || inOlder(id) || groupOf.get(id)?.key === g.key) return;
    onPlace?.(id, placeForGroup(g));
  };
  const endDrag = () => {
    setDragId(null);
    setDrop(null);
  };
  // A release does what the rail shows: the bar (or the highlighted heading) last drawn. The list takes the drop, not
  // the row under the pointer — between rows, or in the list's padding, there is none, and the browser showed 🚫 and
  // did nothing while the bar still promised a move.
  const applyDrop = () => {
    if (dragId && drop) {
      if ('group' in drop)
        moveToGroup(
          dragId,
          groups.find((g) => g.key === drop.group),
        );
      else if (drop.id !== dragId) {
        moveToGroup(dragId, groupOf.get(drop.id));
        const i = shownIds.indexOf(drop.id);
        move(dragId, drop.before ? drop.id : (shownIds[i + 1] ?? null));
      }
    }
    endDrag();
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
    // Your name for it, when you gave one; else its branch (its `feat/` apart, drawn muted).
    const name = railName(s);
    const other = otherBranchText(s);
    const behind = behindText(s);
    const time = railTime(s, kind);
    const status = railStatus(s);
    const marks = railPrMarks(s, prsFor?.(s) ?? []);
    const summary = s.attention?.summary;
    // Your color for it: a bar down the row's edge (its own spot, so never read as a status), one block with its neighbours of that color.
    const color = sessionColor(layout, s);
    const colored = color ? ` wd-dash-rail-colored ${tagClass(color)}` : '';
    if (onRename && renamingId === s.id) {
      return (
        <li key={s.id} className={colored.trim() || undefined}>
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
        className={
          (dragId === s.id ? 'wd-dash-rail-dragging' : '') +
          (over ? (over.before ? ' wd-dash-rail-drop-before' : ' wd-dash-rail-drop-after') : '') +
          colored
        }
        onDragStart={(e) => {
          if (!canReorder && !canPlace) return;
          setDragId(s.id);
          e.dataTransfer.effectAllowed = 'move';
          e.dataTransfer.setData('text/plain', s.id);
        }}
        onDragOver={(e) => {
          if (!dragId) return;
          if (inOlder(dragId) !== inOlder(s.id)) {
            // Across Older's edge: no drop here (a release moves nothing).
            if (drop) setDrop(null);
            return;
          }
          e.preventDefault();
          const r = e.currentTarget.getBoundingClientRect();
          const before = e.clientY < r.top + r.height / 2;
          if (!over || over.before !== before) setDrop({ id: s.id, before });
        }}
        onDragEnd={endDrag}
      >
        <button
          type="button"
          className={
            'wd-dash-rail-item' +
            (isActive ? ' wd-dash-rail-item-active' : '') +
            ((kind === 'needs_input' || !!owedBadge(s)) && !s.snoozed ? ' wd-dash-rail-item-unseen' : '')
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
            railDetails(s, new Date(), marks) +
            (color ? `\nColor: ${RAIL_COLOR_LABEL[color]}` : '') +
            (index < 9 ? `\nAlt+${index + 1}` : '')
          }
        >
          <StatusIcon kind={kind} labelled muted={!!s.snoozed} />
          {/* Every row the same four places: its name and a time, then its project (and branch, when you named
              it) and one status, with `keep` and its PRs' dots at the right. The rest is in the tooltip. */}
          <span className="wd-dash-rail-lines">
            <span className="wd-dash-rail-line">
              <span className={'wd-dash-rail-name' + (name.named ? '' : ' wd-mono')}>
                {name.prefix && <span className="wd-dash-rail-prefix">{name.prefix}</span>}
                {name.rest}
              </span>
              {color && <span className="wd-visually-hidden">Color: {RAIL_COLOR_LABEL[color]}</span>}
              <span className={'wd-dash-rail-slot ' + time.cls}>{time.text}</span>
            </span>
            <span className="wd-dash-rail-line wd-dash-rail-sub">
              <span className="wd-dash-rail-summary">
                {s.target}
                {name.named ? ` · ${s.branch}` : ''}
              </span>
              {status?.kind === 'owed' ? (
                <span className={owedBadgeClass(status.owed, ' wd-dash-rail-status-pill')} title={status.title}>
                  {status.text}
                </span>
              ) : (
                status && (
                  <span
                    className={'wd-dash-rail-status ' + (status.kind === 'snoozed' ? 'wd-rail-slot-snoozed' : 'wd-rail-slot-waiting')}
                    title={status.title}
                  >
                    {status.text}
                  </span>
                )
              )}
              {/* Kept once its PR merges (its menu's Keep after its PR merges): said on the row, beside the PRs it is about. */}
              {s.keepAfterMerge && (
                <Badge dashed className="wd-rail-keep" title={KEEP_TITLE}>
                  keep
                </Badge>
              )}
              <RailPrMarks marks={marks} />
            </span>
          </span>
        </button>
      </li>
    );
  };

  let index = 0;
  return (
    <aside className="wd-dash-rail" role="navigation" aria-label="Sessions">
      {/* The view switch, the legend and New worktree. Finding a session by name is Ctrl+P or `/` (QuickSwitcher). */}
      <header className="wd-dash-rail-header">
        <Segmented
          kind="tabs"
          className="wd-dash-rail-views"
          label="Group the sessions by"
          options={RAIL_VIEWS}
          value={view}
          onChange={changeView}
        />
        <StatusLegend />
        <button type="button" className="wd-dash-rail-new" onClick={onNewWorktree} title="New worktree" aria-label="New worktree">
          +
        </button>
      </header>
      {!anySessions ? (
        <p className="wd-dash-rail-empty">No worktrees yet. Click + to create one.</p>
      ) : (
        <ul
          className="wd-dash-rail-list"
          onDragOver={(e) => {
            // Anywhere in the list while a row is dragged (a row or a heading set where first): keep the drop allowed.
            if (dragId && drop) e.preventDefault();
          }}
          onDragLeave={(e) => {
            // Out of the list: no bar, and a release there moves nothing. Told by where the pointer is, not
            // relatedTarget, which WebKit (the macOS app) leaves null going from one row to the next.
            if (!dragId) return;
            const r = e.currentTarget.getBoundingClientRect();
            if (e.clientX <= r.left || e.clientX >= r.right || e.clientY <= r.top || e.clientY >= r.bottom) setDrop(null);
          }}
          onDrop={(e) => {
            e.preventDefault();
            applyDrop();
          }}
        >
          {mine && naming?.kind === 'new' && (
            <li>
              <SectionNameInput initial="" placeholder="New section name" onSave={saveSectionName} onDone={() => setNaming(null)} />
            </li>
          )}
          {groups.map((g) => {
            const isFoldedNow = folded(g.key);
            const rows = rowsOf(g);
            const older = g.key === OLDER_GROUP;
            const dropHere = drop && 'group' in drop && drop.group === g.key;
            return [
              g.title !== null &&
                (naming?.kind === 'rename' && naming.sectionId === g.sectionId ? (
                  <li key={`h:${g.key}`}>
                    <SectionNameInput
                      initial={g.title}
                      placeholder="Section name"
                      onSave={saveSectionName}
                      onDone={() => setNaming(null)}
                    />
                  </li>
                ) : (
                  <li
                    key={`h:${g.key}`}
                    className={'wd-dash-rail-group' + (dropHere ? ' wd-dash-rail-group-drop' : '')}
                    onDragOver={(e) => {
                      if (!dragId || !canPlace) return;
                      if (older || inOlder(dragId)) {
                        // Older is not a section: nothing goes into it or out of it.
                        if (drop) setDrop(null);
                        return;
                      }
                      e.preventDefault();
                      if (!dropHere) setDrop({ group: g.key });
                    }}
                  >
                    <button
                      type="button"
                      className="wd-dash-rail-group-toggle"
                      aria-expanded={!isFoldedNow}
                      onClick={() => toggle(g.key)}
                      onContextMenu={(e) => {
                        if (!g.sectionId || !onSections) return;
                        e.preventDefault();
                        setSectionMenu({ id: g.sectionId, x: e.clientX, y: e.clientY });
                      }}
                      title={
                        g.sectionId
                          ? 'Fold or unfold; right-click to rename, move or remove it'
                          : older
                            ? 'Sessions not entered in the last 14 days and not running. Fold or unfold'
                            : 'Fold or unfold'
                      }
                    >
                      <span className="wd-dash-rail-group-caret" aria-hidden="true">
                        {isFoldedNow ? '▸' : '▾'}
                      </span>
                      <span className="wd-dash-rail-group-name">{g.title}</span>
                      <span className="wd-dash-rail-group-count">{g.sessions.length}</span>
                    </button>
                  </li>
                )),
              ...rows.map((s) => renderRow(s, index++)),
              mine && !isFoldedNow && g.sessions.length === 0 && (
                <li key={`e:${g.key}`} className="wd-dash-rail-group-empty">
                  {g.sectionId
                    ? `Drag a session here, or right-click one → Move to “${g.title}”.`
                    : 'Drag a session here to unpin it or take it out of its section.'}
                </li>
              ),
            ];
          })}
        </ul>
      )}
      {menu && (
        <Menu
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
                  // A section is Mine's: from State, name it there, where it will show.
                  newSection: (x) => {
                    if (!mine) changeView('mine');
                    setNaming({ kind: 'new', sessionId: x.id });
                  },
                })
              : [];
            const rest = menuFor ? menuFor(s).map((item, i) => (i === 0 ? { ...item, separated: true } : item)) : [];
            return [...rename, ...place, ...rest];
          })()}
        />
      )}
      {sectionMenu && (
        <Menu
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
/** In the stored list: you opened Older, which starts folded. */
const OLDER_OPEN = 'older:open';

/**
 * The stored list's entry that turns a heading from how it starts: a heading's key once you folded it (they start
 * unfolded); for Older, which starts folded, `older:open` once you opened it.
 */
function foldMark(key: string): string {
  return key === OLDER_GROUP ? OLDER_OPEN : key;
}

/** Is this heading folded, by the stored list? Older is until you open it; the rest are once you fold them. */
function isFolded(stored: ReadonlySet<string>, key: string): boolean {
  return key === OLDER_GROUP ? !stored.has(OLDER_OPEN) : stored.has(key);
}

/** Which groups you folded (and whether you opened Older): this browser's, not every window's (a view preference). */
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
      <Input
        compact
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
        <Input
          compact
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
