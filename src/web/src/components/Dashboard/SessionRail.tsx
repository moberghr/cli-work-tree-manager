import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { behindText } from './BehindChip.js';
import {
  EMPTY_RAIL_LAYOUT,
  MAX_SECTION_NAME,
  placeForGroup,
  RAIL_COLOR_LABEL,
  type PlacePatch,
  type RailColor,
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
import {
  railCard,
  railName,
  railPrMarks,
  railPrsText,
  railStatus,
  railTime,
  type RailCard,
  type RailPrMark,
} from '../../state/rail-row.js';
import { cardHome, groupsForView, projectOfGroup, RAIL_VIEWS, readRailView, writeRailView, type RailView } from '../../state/rail-views.js';
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
  /** Open New worktree; with a project when asked from its heading (the Project view's +). */
  onNewWorktree: (project?: string) => void;
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
 * Not its +/− lines: those are the Diff tab's. Pure (`now` for the snooze's wording). `prs: null` leaves the PRs out
 * (the Project view's card lists them itself).
 */
export function railDetails(s: SessionSummary, now = new Date(), prs?: { shown: RailPrMark[]; more: RailPrMark[] } | null): string {
  const c = s.agents ?? s.claudes;
  const bits = [
    s.attention?.background ? backgroundLine(s.attention.background) : '',
    s.snoozed ? `snoozed ${snoozeLabel(s.snoozed, now)}` : '',
    s.blockedBy?.length ? `waits on ${s.blockedBy.map((b) => b.label).join(', ')}` : '',
    prs === null ? '' : (prs && railPrsText(prs)) || (s.prStage?.text ?? ''),
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
 * still pins and moves it in Mine). And Project: a heading per project with a + that starts a worktree there, then
 * Older; its rows are one line (the heading says the project), and hovering or focusing one shows a card beside the
 * rail with what the line has no room for (`RailCardView`). The view is remembered in this browser.
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
  // The narrow rail's view menu, where its button is.
  const [viewMenu, setViewMenu] = useState<{ x: number; y: number } | null>(null);
  // The Project view's card: the row it is for and where that row is. Shown after a short wait on hover, at once on focus.
  const [card, setCard] = useState<{ id: string; top: number; left: number } | null>(null);
  const cardTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hideCard = () => {
    if (cardTimer.current) clearTimeout(cardTimer.current);
    cardTimer.current = null;
    setCard(null);
  };
  const showCard = (id: string, row: HTMLElement, wait: number) => {
    if (cardTimer.current) clearTimeout(cardTimer.current);
    const show = () => {
      // Gone meanwhile (being renamed, archived): no card for a row that isn't there.
      if (!row.isConnected) return;
      const r = row.getBoundingClientRect();
      setCard({ id, top: r.top, left: r.right + CARD_GAP });
    };
    if (wait === 0) show();
    else cardTimer.current = setTimeout(show, wait);
  };
  // The pointer left a row: its pending card, or its card. Another row's card (the focused one's) stays.
  const leaveRow = (id: string) => {
    if (cardTimer.current) clearTimeout(cardTimer.current);
    cardTimer.current = null;
    setCard((c) => (c?.id === id ? null : c));
  };
  useEffect(
    () => () => {
      if (cardTimer.current) clearTimeout(cardTimer.current);
    },
    [],
  );
  // Esc takes the card away, wherever the focus is (a hovered row need not have it).
  const cardShown = card !== null;
  useEffect(() => {
    if (!cardShown) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') hideCard();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [cardShown]);
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
  // The card is placed where its row was when it showed: when the rows change under it (one moved, went, came), or
  // one is being renamed, it goes rather than point at another row. A row that unmounts fires no leave or blur.
  const cardRowsKey = visible.map((s) => s.id).join('\n');
  useEffect(() => hideCard(), [cardRowsKey, renamingId]);
  const mine = view === 'mine';
  // Project's rows are one line, with a card in place of the tooltip.
  const compact = view === 'project';
  const canReorder = mine && !!onReorder;
  const canPlace = mine && !!onPlace;
  const changeView = (v: RailView) => {
    setView(v);
    writeRailView(v);
    // Nothing half done in the view left behind: a drag, a section being named, its menu, a card.
    hideCard();
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

  /**
   * A row; in the Project view, a piece of its project's card (`inCard`: the project's color, and whether it is the card's
   * last row). There the project's color is the card's edge, so a row draws its own bar only for a color of its own.
   */
  const renderRow = (s: SessionSummary, index: number, inCard?: { color?: RailColor; end: boolean }) => {
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
    const own = layout.places[s.id]?.color;
    const color = inCard ? (own && own !== inCard.color ? own : undefined) : sessionColor(layout, s);
    const piece = inCard ? ` wd-rail-pcard${inCard.end ? ' wd-rail-pcard-end' : ''}` : '';
    const pieceStyle = inCard?.color ? ({ ['--rail-pcard' as string]: `var(--tag-${inCard.color})` } as React.CSSProperties) : undefined;
    const colored = (color ? ` wd-dash-rail-colored ${tagClass(color)}` : '') + piece;
    if (onRename && renamingId === s.id) {
      return (
        <li key={s.id} className={colored.trim() || undefined} style={pieceStyle}>
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
    // The one status: what waits on you is a status Badge, "snoozed" / "in review" small quiet text. Its own hover
    // only where the row has a tooltip (Project's card says it).
    const statusEl =
      status?.kind === 'owed' ? (
        <span className={owedBadgeClass(status.owed, ' wd-dash-rail-status-pill')} title={compact ? undefined : status.title}>
          {status.text}
        </span>
      ) : (
        status && (
          <span
            className={'wd-dash-rail-status ' + (status.kind === 'snoozed' ? 'wd-rail-slot-snoozed' : 'wd-rail-slot-waiting')}
            title={compact ? undefined : status.title}
          >
            {status.text}
          </span>
        )
      );
    const nameEl = (
      <span className={'wd-dash-rail-name' + (name.named ? '' : ' wd-mono')}>
        {name.prefix && <span className="wd-dash-rail-prefix">{name.prefix}</span>}
        {name.rest}
      </span>
    );
    const colorEl = color && <span className="wd-visually-hidden">Color: {RAIL_COLOR_LABEL[color]}</span>;
    return (
      <li
        key={s.id}
        draggable={canReorder || canPlace}
        className={
          (dragId === s.id ? 'wd-dash-rail-dragging' : '') +
          (over ? (over.before ? ' wd-dash-rail-drop-before' : ' wd-dash-rail-drop-after') : '') +
          colored
        }
        style={pieceStyle}
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
            (compact ? ' wd-dash-rail-item-compact' : '') +
            (isActive ? ' wd-dash-rail-item-active' : '') +
            ((kind === 'needs_input' || !!owedBadge(s)) && !s.snoozed ? ' wd-dash-rail-item-unseen' : '')
          }
          onClick={() => {
            hideCard();
            onSelect(s.id);
          }}
          onContextMenu={(e) => {
            hideCard();
            if (!onRename && !menuFor && !onPlace) return;
            e.preventDefault();
            setMenu({ id: s.id, x: e.clientX, y: e.clientY });
          }}
          onMouseEnter={compact ? (e) => showCard(s.id, e.currentTarget, CARD_WAIT_MS) : undefined}
          onMouseLeave={compact ? () => leaveRow(s.id) : undefined}
          onFocus={compact ? (e) => focusVisible(e.currentTarget) && showCard(s.id, e.currentTarget, 0) : undefined}
          onBlur={compact ? hideCard : undefined}
          aria-describedby={compact && card?.id === s.id ? CARD_ID : undefined}
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
            // Project: the card says it (two hovers at once would cover each other).
            compact
              ? undefined
              : `${s.target} · ${s.branch}${other ? ` (${other})` : ''}${s.stackedOn ? ` · stacked on ${s.stackedOn.branch}` : ''}${behind ? ` · ${behind}` : ''}${s.title ? `\n${s.title}` : ''}\n${DISPLAY_LABEL[kind]}` +
                (summary ? ` — ${summary}` : '') +
                railDetails(s, new Date(), marks) +
                (color ? `\nColor: ${RAIL_COLOR_LABEL[color]}` : '') +
                (index < 9 ? `\nAlt+${index + 1}` : '')
          }
        >
          <StatusIcon kind={kind} labelled muted={!!s.snoozed} />
          {/* Every row the same four places: its name and a time, then its project (and branch, when you named
              it) and one status, with `keep` and its PRs' dots at the right. The rest is in the tooltip. */}
          {compact ? (
            // Project: one line. Its heading says the project; `keep`, the branch of one you named and the rest are in the card.
            <span className="wd-dash-rail-lines">
              <span className="wd-dash-rail-line">
                {s.baseCheckout && <HomeIcon />}
                {nameEl}
                {colorEl}
                {statusEl}
                <RailPrMarks marks={marks} plain />
                <span className={'wd-dash-rail-slot ' + time.cls}>{time.text}</span>
              </span>
            </span>
          ) : (
            <span className="wd-dash-rail-lines">
              <span className="wd-dash-rail-line">
                {nameEl}
                {colorEl}
                <span className={'wd-dash-rail-slot ' + time.cls}>{time.text}</span>
              </span>
              <span className="wd-dash-rail-line wd-dash-rail-sub">
                <span className="wd-dash-rail-summary">
                  {s.target}
                  {name.named ? ` · ${s.branch}` : ''}
                </span>
                {statusEl}
                {/* Kept once its PR merges (its menu's Keep after its PR merges): said on the row, beside the PRs it is about. */}
                {s.keepAfterMerge && (
                  <Badge dashed className="wd-rail-keep" title={KEEP_TITLE}>
                    keep
                  </Badge>
                )}
                <RailPrMarks marks={marks} />
              </span>
            </span>
          )}
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
        {/* A rail too narrow for the three (rail.css's container query): one button naming the view, a menu of the three. */}
        <button
          type="button"
          className="wd-dash-rail-view-pick"
          aria-haspopup="menu"
          aria-expanded={viewMenu !== null}
          title="Group the sessions by"
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            setViewMenu(viewMenu ? null : { x: r.left, y: r.bottom + 4 });
          }}
        >
          {RAIL_VIEWS.find((v) => v.value === view)?.label}
          <span aria-hidden="true" className="wd-dash-rail-view-caret">
            ▾
          </span>
        </button>
        {/* One piece: in a rail too narrow for one row the two go to the next row together. */}
        <span className="wd-dash-rail-actions">
          <StatusLegend />
          <button type="button" className="wd-dash-rail-new" onClick={() => onNewWorktree()} title="New worktree" aria-label="New worktree">
            +
          </button>
        </span>
      </header>
      {!anySessions ? (
        <p className="wd-dash-rail-empty">No worktrees yet. Click + to create one.</p>
      ) : (
        <ul
          className="wd-dash-rail-list"
          onScroll={compact ? hideCard : undefined}
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
            const project = projectOfGroup(g.key);
            const dropHere = drop && 'group' in drop && drop.group === g.key;
            // Project: each project a card — its heading the card's top, its rows the rest, the project's color its edge.
            const cardColor = project !== null ? layout.projectColors?.[project] : undefined;
            const cardStyle = cardColor ? ({ ['--rail-pcard' as string]: `var(--tag-${cardColor})` } as React.CSSProperties) : undefined;
            const home = project !== null ? cardHome(g.sessions) : null;
            const fold = (
              <span className="wd-dash-rail-group-caret" aria-hidden="true">
                {isFoldedNow ? '▸' : '▾'}
              </span>
            );
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
                    className={
                      'wd-dash-rail-group' +
                      (dropHere ? ' wd-dash-rail-group-drop' : '') +
                      (project !== null ? ' wd-dash-rail-group-project wd-rail-pcard wd-rail-pcard-head' : '') +
                      (project !== null && rows.length === 0 ? ' wd-rail-pcard-end' : '')
                    }
                    style={cardStyle}
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
                    {project !== null ? (
                      // A card's top: fold it, its name (opens the repo's own checkout, when it has a session), the count, +.
                      <>
                        <button
                          type="button"
                          className="wd-dash-rail-group-toggle wd-rail-pcard-fold"
                          aria-expanded={!isFoldedNow}
                          aria-label={`${isFoldedNow ? 'Unfold' : 'Fold'} ${project}`}
                          title="Fold or unfold"
                          onClick={() => toggle(g.key)}
                        >
                          {fold}
                        </button>
                        <button
                          type="button"
                          className="wd-rail-pcard-name"
                          onClick={() => (home ? onSelect(home.id) : toggle(g.key))}
                          title={home ? `Open ${project}'s own checkout (${home.branch})` : 'Fold or unfold'}
                        >
                          {g.title}
                        </button>
                        <span className="wd-dash-rail-group-count">{g.sessions.length}</span>
                      </>
                    ) : (
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
                        {fold}
                        <span className="wd-dash-rail-group-name">{g.title}</span>
                        <span className="wd-dash-rail-group-count">{g.sessions.length}</span>
                      </button>
                    )}
                    {project !== null && (
                      <button
                        type="button"
                        className="wd-dash-rail-group-add"
                        onClick={() => onNewWorktree(project)}
                        title={`New worktree in ${project}`}
                        aria-label={`New worktree in ${project}`}
                      >
                        +
                      </button>
                    )}
                  </li>
                )),
              ...rows.map((s, i) => renderRow(s, index++, project !== null ? { color: cardColor, end: i === rows.length - 1 } : undefined)),
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
      {compact &&
        card &&
        (() => {
          const s = visible.find((x) => x.id === card.id);
          if (!s) return null;
          const kind = displayStatus(s);
          const prs = prsFor?.(s) ?? [];
          const color = sessionColor(layout, s);
          const at = visible.indexOf(s);
          const other = otherBranchText(s);
          const behind = behindText(s);
          // What the tooltip says in the other views, the PRs apart (the card lists them): where its checkout really
          // is, what it is stacked on, how far behind, its automatic title, what you owe, then the details.
          const notes = [
            [other, s.stackedOn ? `stacked on ${s.stackedOn.branch}` : '', behind].filter(Boolean).join(' · '),
            s.title && !s.titleIsYours ? s.title : '',
            owedBadge(s)?.title ?? '',
            railDetails(s, new Date(), null).trim(),
            color ? `Color: ${RAIL_COLOR_LABEL[color]}` : '',
            at >= 0 && at < 9 ? `Alt+${at + 1}` : '',
          ].filter(Boolean);
          return <RailCardView card={railCard(s, kind, prs)} notes={notes} top={card.top} left={card.left} />;
        })()}
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
      {viewMenu && (
        <Menu
          x={viewMenu.x}
          y={viewMenu.y}
          onClose={() => setViewMenu(null)}
          items={RAIL_VIEWS.map((v) => ({ label: v.label, hint: v.hint, checked: v.value === view, run: () => changeView(v.value) }))}
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

/** A repo's own checkout, in its Project card (first, and what the card's name opens). */
function HomeIcon() {
  return (
    <svg className="wd-rail-home" width="11" height="11" viewBox="0 0 12 12" role="img" aria-label="Its own checkout">
      <title>Its own checkout</title>
      <path d="M2 6 L6 2.5 L10 6 M3.2 5 V10 H8.8 V5" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
    </svg>
  );
}

/** The focus came from the keyboard (a click's focus shows no card: the pointer's hover does). */
function focusVisible(el: Element): boolean {
  try {
    return el.matches(':focus-visible');
  } catch {
    // An engine without the selector: treat every focus as the keyboard's.
    return true;
  }
}

/** The card's element id: the row it is for points at it (`aria-describedby`). One card at a time. */
const CARD_ID = 'wd-rail-card';
/** How long the pointer rests on a row before its card shows: moving down the rail shows none. */
const CARD_WAIT_MS = 350;
/** Between the row's right edge and the card, and between the card and the window's edge. */
const CARD_GAP = 8;

/**
 * A Project row's card, beside the rail: its name, project and branch, its state, each PR with its title and stage,
 * then what a tooltip says in the other views. Read-only (`pointer-events: none`): a PR opens from its dot. Placed at
 * its row's top, moved up when it would pass the window's bottom edge, and left when it would pass the right one (the
 * narrow-screen drawer, where the rail is most of the window). Esc takes it away.
 */
function RailCardView({ card, notes, top, left }: { card: RailCard; notes: string[]; top: number; left: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const [at, setAt] = useState({ x: left, y: top });
  // Measured again when what it says can change its size.
  const size = `${card.prs.length}:${notes.join('|').length}:${card.state.length}`;
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setAt({
      x: Math.max(CARD_GAP, Math.min(left, window.innerWidth - el.offsetWidth - CARD_GAP)),
      y: Math.max(CARD_GAP, Math.min(top, window.innerHeight - el.offsetHeight - CARD_GAP)),
    });
  }, [top, left, size]);
  return (
    <div ref={ref} id={CARD_ID} role="tooltip" className="wd-rail-card" style={{ top: at.y, left: at.x }}>
      <div className="wd-rail-card-name">{card.name}</div>
      <div className="wd-rail-card-where">{card.where}</div>
      <div className="wd-rail-card-state">{card.state}</div>
      {card.prs.length > 0 && (
        <ul className="wd-rail-card-prs">
          {card.prs.map((p) => (
            <li key={p.key}>
              <span className={`wd-rail-pr-mark wd-rail-pr-mark-${p.tone}`} aria-hidden="true" />
              <span className="wd-rail-card-pr">
                <span className="wd-rail-card-pr-ref">{p.label}</span>
                {p.title && <span className="wd-rail-card-pr-title">{p.title}</span>}
                <span className="wd-rail-card-pr-stage">{p.stage}</span>
              </span>
            </li>
          ))}
        </ul>
      )}
      {notes.map((n) => (
        <div key={n} className="wd-rail-card-note">
          {n}
        </div>
      ))}
    </div>
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
