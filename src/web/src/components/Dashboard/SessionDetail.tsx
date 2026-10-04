import { useCallback, useEffect, useRef, useState } from 'react';
import { SESSION_ACTION_EVENT, type SessionAction, type SessionActionDetail } from '../../state/shortcuts.js';
import { TimelineView } from './TimelineView.js';
import { BlockedByChip } from './BlockedBy.js';
import { NotesChip, SessionNotes } from './SessionNotes.js';
import { WorkTimeChip } from './WorkTimeChip.js';
import { BehindChip, MergedParentChip } from './BehindChip.js';
import { AwayLink, CatchUpPanel, useCatchUp } from './CatchUp.js';
import { useArchivePending } from '../../api/archive-pending.js';
import { renameSession, setArchived, type SessionSummary } from '../../api/client.js';
import type { PrInfo } from '../../api/panes.js';
import { isArchived } from '../../state/session-display.js';
import { ClaudesChip, ContextChip, OtherBranchChip, OverlapChip, StackChip, PrChips, PrStageChip, StatusLine } from './SessionBits.js';
import { ShipPanel } from './ShipPanel.js';
import { PromptsMenu } from './PromptsMenu.js';
import { DevChip, useDevState } from './DevChip.js';
import { CiStrip } from './CiStrip.js';
import { ReplyDrafts } from './ReplyDrafts.js';
import { NeedsYouBar, needsYouText } from './NeedsYouBar.js';
import { RowMenu } from './RowMenu.js';
import { DiffView } from '../Diff/DiffView.js';
import { PtyView } from '../Terminal/PtyView.js';
import type { SessionSubTab } from '../../state/dashboard-route.js';
import { contextFooter, sessionHeaderItems } from '../../state/session-header-menu.js';
import { openInTerminal } from '../../api/panes.js';

interface Props {
  session: SessionSummary;
  subTab: SessionSubTab;
  onSelectSubTab: (sub: SessionSubTab) => void;
  /** Opens the delete-session confirmation. */
  onDelete: () => void;
  /** Open PRs for this session (PRs pane data). */
  prs?: PrInfo[];
  /** A merge from the Ship panel went through (session now archived). */
  onShipped?: () => void;
  /** Open the diff on "Last turn" (review queue / a finished session). */
  startOnLastTurn?: boolean;
  /** Open another session (the overlap warning links to it). */
  onOpenSession?: (id: string) => void;
  /** Where the dashboard's terminal deck should draw this session's
   *  terminal; without it the terminal is rendered here directly. */
  onTermSlot?: (el: HTMLDivElement | null) => void;
}

/**
 * Drill-in view for a single session, beside the rail. A header with one
 * action (Archive, or Restore) and a ⋯ menu for the rest; a status line
 * with chips only when they say something; a "Needs you" bar for what waits
 * on GitHub; then three sub-tabs:
 *
 *   Terminal  — embedded Claude PTY (work web only — wd doesn't have one)
 *   Diff      — what `wd` shows, comments included
 *   Timeline  — how it got here, and how long its Claude worked
 *
 * `wd`'s deep-link `/diff/<hash>` route is a *different* view entirely
 * (the bare `ReviewApp`) — this is the dashboard's per-session view,
 * not the bare reviewer. Same data underneath; different chrome.
 */
export function SessionDetail({
  session,
  subTab,
  onSelectSubTab,
  onDelete,
  prs = [],
  onShipped,
  startOnLastTurn = false,
  onOpenSession,
  onTermSlot,
}: Props) {
  const files = session.diffStat?.files ?? 0;
  return (
    <div className="wd-session-detail">
      {/* Keyed: what's open in the header (Ship, notes, a menu, catch-up)
          belongs to one session and closes when you switch to another. */}
      <SessionHeader key={session.id} session={session} prs={prs} onDelete={onDelete} onShipped={onShipped} onOpenSession={onOpenSession} />
      <nav className="wd-session-subtabs" role="tablist">
        <SubTabButton label="Terminal" active={subTab === 'term'} onClick={() => onSelectSubTab('term')} />
        <SubTabButton
          label="Diff"
          meta={files ? `${files} file${files === 1 ? '' : 's'}` : undefined}
          active={subTab === 'diff'}
          badge={session.commentCount}
          onClick={() => onSelectSubTab('diff')}
        />
        <SubTabButton label="Timeline" active={subTab === 'timeline'} onClick={() => onSelectSubTab('timeline')} />
      </nav>
      <div className="wd-session-subtab-body">
        {subTab === 'diff' && <DiffView session={session} startOnLastTurn={startOnLastTurn} />}
        {subTab === 'term' &&
          (onTermSlot ? (
            // The dashboard's terminal deck draws the terminal over this slot,
            // so it stays connected when you switch away and back.
            <div className="wd-term-slot" ref={onTermSlot} />
          ) : (
            <PtyView sessionId={session.id} target={session.target} branch={session.branch} />
          ))}
        {subTab === 'timeline' && (
          <div className="wd-timeline-tab">
            <div className="wd-timeline-head">
              <WorkTimeChip session={session} />
            </div>
            <TimelineView session={session} />
          </div>
        )}
      </div>
    </div>
  );
}

interface HeaderProps {
  session: SessionSummary;
  prs: PrInfo[];
  onDelete: () => void;
  onShipped?: () => void;
  onOpenSession?: (id: string) => void;
}

/** Title, Archive + ⋯, the status line, and what opens under them. One session's: keyed by its id. */
function SessionHeader({ session, prs, onDelete, onShipped, onOpenSession }: HeaderProps) {
  const archived = isArchived(session);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [shipOpen, setShipOpen] = useState(false);
  const [notesOpen, setNotesOpen] = useState(false);
  const [promptsOpen, setPromptsOpen] = useState(false);
  const [renameKey, setRenameKey] = useState(0);
  const [note, setNote] = useState<{ text: string; error?: boolean } | null>(null);
  const [replies, setReplies] = useState<string | null>(null);
  const [ci, setCi] = useState<string | null>(null);
  const [reviewOpen, setReviewOpen] = useState(false);
  const onReplies = useCallback((t: string | null) => setReplies(t), []);
  const onCi = useCallback((t: string | null) => setCi(t), []);
  const dev = useDevState(session.id);
  const catchUp = useCatchUp(session.id);
  const needs = needsYouText([replies, ci]);
  // Folded behind the bar until you look; with nothing waiting they show as they are (checks running).
  const folded = needs !== null && !reviewOpen;

  const openTerminal = () => {
    setNote({ text: 'Opening in a terminal…' });
    openInTerminal(session.id).then(
      () => setNote(null),
      (err: Error) => setNote({ text: err.message, error: true }),
    );
  };
  // The keys the dashboard hands to the open session's header (state/shortcuts.ts): what its buttons and ⋯ menu do.
  const moreRef = useRef<HTMLButtonElement>(null);
  const act = useRef<(a: SessionAction) => void>(() => {});
  act.current = (a) => {
    const live = !archived;
    if (a === 'menu') {
      const r = moreRef.current?.getBoundingClientRect();
      if (r) setMenu({ x: r.right, y: r.bottom + 4 });
    } else if (a === 'prompt' && live) setPromptsOpen(true);
    else if (a === 'catchup') catchUp.run();
    else if (a === 'notes') setNotesOpen((o) => !o);
    else if (a === 'ship' && live) setShipOpen(true);
    else if (a === 'terminal' && live) openTerminal();
    else if (a === 'dev' && live && dev.state?.port != null && (dev.state.command || dev.state.running))
      dev.act(dev.state.running ? 'stop' : 'start');
  };
  useEffect(() => {
    const on = (e: Event) => {
      const d = (e as CustomEvent<SessionActionDetail>).detail;
      if (d?.id === session.id) act.current(d.action);
    };
    window.addEventListener(SESSION_ACTION_EVENT, on);
    return () => window.removeEventListener(SESSION_ACTION_EVENT, on);
  }, [session.id]);
  const items = sessionHeaderItems(session, dev.state, {
    openTerminal,
    ship: () => setShipOpen(true),
    catchUp: catchUp.run,
    sendPrompt: () => setPromptsOpen(true),
    notes: () => setNotesOpen((o) => !o),
    devStart: () => dev.act('start'),
    devStop: () => dev.act('stop'),
    rename: () => setRenameKey((k) => k + 1),
    remove: onDelete,
  });

  return (
    <>
      <header className="wd-session-detail-header">
        <h1>
          <span className="wd-session-detail-target">{session.target}</span>
          <span className="wd-session-detail-sep">/</span>
          <span className="wd-session-detail-branch">{session.branch}</span>
          <OtherBranchChip session={session} />
          <SessionTitle key={renameKey} session={session} autoEdit={renameKey > 0} />
        </h1>
        {archived && <span className="wd-archived-pill">archived</span>}
        <div className="wd-session-actions">
          {note && (
            <span
              className={'wd-session-action-note' + (note.error ? ' wd-session-action-note-error' : '')}
              role={note.error ? 'alert' : 'status'}
            >
              {note.text}
            </span>
          )}
          <PromptsMenu session={session} open={promptsOpen} onOpenChange={setPromptsOpen} />
          <ArchiveButton sessionId={session.id} archived={archived} />
          <button
            ref={moreRef}
            type="button"
            className="wd-session-more"
            aria-label="More actions"
            aria-haspopup="menu"
            aria-expanded={menu !== null}
            title="More actions"
            // A click on ⋯ while its menu is open closes it (the menu's own
            // outside-click handler would otherwise close it and this reopen it).
            onMouseDown={(e) => {
              if (menu) e.stopPropagation();
            }}
            onClick={(e) => {
              if (menu) return setMenu(null);
              const r = e.currentTarget.getBoundingClientRect();
              setMenu({ x: r.right, y: r.bottom + 4 });
            }}
          >
            ⋯
          </button>
        </div>
      </header>
      {menu && <RowMenu x={menu.x} y={menu.y} anchor="right" items={items} footer={contextFooter(session)} onClose={() => setMenu(null)} />}
      <div className="wd-session-strip">
        <StatusLine session={session} />
        <AwayLink session={session} catchUp={catchUp} />
        <BehindChip session={session} />
        <MergedParentChip session={session} />
        <StackChip session={session} onOpen={onOpenSession} />
        <BlockedByChip session={session} onOpen={onOpenSession} />
        <OverlapChip session={session} onOpen={onOpenSession} />
        <ClaudesChip session={session} quiet />
        <ContextChip session={session} quiet />
        {session.prStage ? <PrStageChip session={session} /> : <PrChips prs={prs} link />}
        <DevChip dev={dev} />
        {(session.hasNote || notesOpen) && <NotesChip session={session} open={notesOpen} onToggle={() => setNotesOpen((o) => !o)} />}
      </div>
      <CatchUpPanel catchUp={catchUp} />
      {notesOpen && <SessionNotes session={session} onClose={() => setNotesOpen(false)} />}
      {needs && <NeedsYouBar text={needs} open={reviewOpen} onToggle={() => setReviewOpen((o) => !o)} />}
      <ReplyDrafts sessionId={session.id} onNeeds={onReplies} hidden={folded} />
      <CiStrip sessionId={session.id} isGroup={session.isGroup} onNeeds={onCi} hidden={folded} />
      {shipOpen && (
        <ShipPanel
          session={session}
          onClose={() => setShipOpen(false)}
          onMerged={() => {
            setShipOpen(false);
            onShipped?.();
          }}
        />
      )}
    </>
  );
}

/**
 * Your name for the session, beside its branch, and renaming it: click (or
 * ⋯ → Rename), type, Enter (Esc cancels; an empty name goes back to the
 * automatic one). An automatic name (its first prompt) isn't shown here:
 * the branch already says which session this is.
 */
export function SessionTitle({ session, autoEdit = false }: { session: SessionSummary; autoEdit?: boolean }) {
  const [editing, setEditing] = useState(autoEdit);
  const [draft, setDraft] = useState(() => (autoEdit && session.titleIsYours ? (session.title ?? '') : ''));
  const [saving, setSaving] = useState(false);
  const start = () => {
    setDraft(session.titleIsYours ? (session.title ?? '') : '');
    setEditing(true);
  };
  const save = async () => {
    setSaving(true);
    try {
      await renameSession(session.id, draft);
      setEditing(false);
    } finally {
      setSaving(false);
    }
  };
  if (editing) {
    return (
      <input
        className="wd-session-title-input"
        autoFocus
        value={draft}
        disabled={saving}
        placeholder={session.title ?? 'Name this session'}
        aria-label="Session name"
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => setEditing(false)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') void save();
          if (e.key === 'Escape') setEditing(false);
        }}
      />
    );
  }
  if (!session.titleIsYours || !session.title) return null;
  return (
    <button type="button" className="wd-session-title" title="Your name for it — click to rename" onClick={start}>
      {session.title}
    </button>
  );
}

/** Archive stops the session's Claude but keeps worktree, branch and
 *  conversation; it drops off the rail and inbox until unarchived. */
function ArchiveButton({ sessionId, archived }: { sessionId: string; archived: boolean }) {
  // In flight is kept outside this button (archive-pending.ts): leaving the
  // session and coming back makes a new button, which must still say so.
  const pending = useArchivePending(sessionId);
  const busy = pending !== undefined;
  const [error, setError] = useState<string | null>(null);
  const onClick = () => {
    setError(null);
    setArchived(sessionId, !archived).catch((err: Error) => setError(err.message));
  };
  return (
    <button
      type="button"
      className="wd-session-archive"
      onClick={onClick}
      disabled={busy}
      title={
        error ??
        (archived ? 'Bring it back to the rail and inbox' : 'Stop its Claude and hide it; worktree, branch and conversation are kept')
      }
    >
      {busy ? (pending ? 'Archiving…' : 'Restoring…') : archived ? 'Restore' : error ? 'Archive ⚠' : 'Archive'}
    </button>
  );
}

interface SubTabBtnProps {
  label: string;
  active: boolean;
  onClick: () => void;
  /** A quiet note after the label ("2 files"). */
  meta?: string;
  badge?: number;
}

function SubTabButton({ label, active, onClick, meta, badge }: SubTabBtnProps) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      className={'wd-session-subtab' + (active ? ' wd-session-subtab-active' : '')}
      onClick={onClick}
    >
      {label}
      {meta && <span className="wd-session-subtab-meta">· {meta}</span>}
      {badge ? (
        <span className="wd-session-subtab-badge" title={`${badge} comment${badge === 1 ? '' : 's'}`}>
          {badge}
        </span>
      ) : null}
    </button>
  );
}
