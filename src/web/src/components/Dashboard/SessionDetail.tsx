import { useEffect, useRef, useState } from 'react';
import { SESSION_ACTION_EVENT, type SessionAction, type SessionActionDetail } from '../../state/shortcuts.js';
import { requestTerminalReconnect } from '../../state/terminal-reconnect.js';
import { TimelineView } from './TimelineView.js';
import { CodeView } from '../Code/CodeView.js';
import { CodeSearch } from '../Code/CodeSearch.js';
import { isSearchKey, type CodePlace } from '../../state/code-search-view.js';
import { inDesktopApp } from '../../hooks/use-desktop.js';
import { modalOpen } from '../../state/modal-open.js';
import { BlockedByChip } from './BlockedBy.js';
import { NotesChip, SessionNotes } from './SessionNotes.js';
import { WorkTimeChip } from './WorkTimeChip.js';
import { BehindChip, MergedParentChip } from './BehindChip.js';
import { AwayLink, CatchUpPanel, useCatchUp } from './CatchUp.js';
import { useArchivePending } from '../../api/archive-pending.js';
import { archiveCancelled, fetchLastReply, renameSession, setArchived, type SessionSummary } from '../../api/client.js';
import type { PrInfo } from '../../api/panes.js';
import { isArchived } from '../../state/session-display.js';
import {
  AccountChip,
  ClaudesChip,
  ContextChip,
  OtherBranchChip,
  OverlapChip,
  StackChip,
  PrChips,
  PrStageChip,
  StatusLine,
} from './SessionBits.js';
import { ShipPanel } from './ShipPanel.js';
import { PromptsMenu } from './PromptsMenu.js';
import { DevChip, useDevState } from './DevChip.js';
import { NeedsYouBar } from './NeedsYouBar.js';
import { PrTab } from './PrTab.js';
import { prNeedsLine, prTabButton } from '../../state/pr-tab.js';
import { RowMenu } from './RowMenu.js';
import { DiffView } from '../Diff/DiffView.js';
import { PtyView } from '../Terminal/LazyPtyView.js';
import type { SessionSubTab } from '../../state/dashboard-route.js';
import { contextFooter, sessionHeaderItems } from '../../state/session-header-menu.js';
import { openInTerminal } from '../../api/panes.js';
import { markdownHtml, writeRich } from '../../state/rich-copy.js';
import { ARCHIVED_BY_SHORT, archivedLine } from '../../state/archive-view.js';
import { headerRepos } from '../../state/add-repo.js';

interface Props {
  session: SessionSummary;
  subTab: SessionSubTab;
  onSelectSubTab: (sub: SessionSubTab) => void;
  /** Opens the delete-session confirmation. */
  onDelete: () => void;
  /** Opens Add a repo… (a session folder; the dashboard's dialog). */
  onAddRepo?: () => void;
  /** Opens Claude account… (given while more than one account exists). */
  onAccount?: () => void;
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
 * with chips only when they say something; a "Needs you" line for what waits
 * on GitHub (it opens the PR tab); then the sub-tabs:
 *
 *   Terminal  — embedded Claude PTY (work web only — wd doesn't have one)
 *   Diff      — what `wd` shows, comments included
 *   PR        — its pull requests: stage, checks, review threads and drafts
 *               (there while it has a PR, or anything about one)
 *   Timeline  — how it got here, and how long its Claude worked
 *
 * `wd`'s deep-link `/diff/<hash>` route is a *different* view entirely
 * (the bare `ReviewApp`) — this is the dashboard's per-session view,
 * not the bare reviewer. Same data underneath; different chrome.
 */
/** Ctrl+T picks, counted for the page: a pick after switching sessions is never taken for an old one. */
let pickSeq = 0;

export function SessionDetail({
  session,
  subTab,
  onSelectSubTab,
  onDelete,
  onAddRepo,
  onAccount,
  prs = [],
  onShipped,
  startOnLastTurn = false,
  onOpenSession,
  onTermSlot,
}: Props) {
  const files = session.diffStat?.files ?? 0;
  const prButton = prTabButton(session, prs);
  // The PR tab stays mounted once opened (hidden behind the others), so a draft
  // being edited survives a look at the terminal; per session (keyed below).
  const [prFor, setPrFor] = useState<string | null>(null);
  // The diff filling the window; another session opens as usual.
  const [diffFull, setDiffFull] = useState(false);
  // Left (another session, or another of its tabs): full screen is over, and doesn't come back by itself.
  useEffect(() => setDiffFull(false), [session.id, subTab]);
  // Ctrl+T, as Visual Studio's: search the session's code from any of its tabs (a terminal too: the capture
  // phase). A pick opens the Code tab at its line. Not over another dialog; not in a browser tab, which keeps
  // Ctrl+T for itself (the Code tab's button opens it there).
  const [searching, setSearching] = useState(false);
  // Whose pick it is: another session's Code tab (j/k keep the tab) mounts before a reset here would run.
  const [goto, setGoto] = useState<(CodePlace & { seq: number; sessionId: string }) | null>(null);
  useEffect(() => setGoto(null), [session.id]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!isSearchKey(e, { inApp: inDesktopApp(), archived: isArchived(session), modal: modalOpen(), searching })) return;
      e.preventDefault();
      e.stopPropagation();
      setSearching((o) => !o);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [session, searching]);
  const openPlace = (p: CodePlace) => {
    // Never the same number twice for the page (CodeView applies each pick once, remembered per session).
    setGoto({ ...p, seq: ++pickSeq, sessionId: session.id });
    onSelectSubTab('code');
  };
  if (subTab === 'pr' && prFor !== session.id) setPrFor(session.id);
  // The PR tab's Ship… opens the header's Ship panel (the same as Shift+S).
  const openShip = () =>
    window.dispatchEvent(new CustomEvent<SessionActionDetail>(SESSION_ACTION_EVENT, { detail: { id: session.id, action: 'ship' } }));
  return (
    <div className="wd-session-detail">
      {/* Keyed: what's open in the header (Ship, notes, a menu, catch-up)
          belongs to one session and closes when you switch to another. */}
      <SessionHeader
        key={session.id}
        session={session}
        prs={prs}
        onDelete={onDelete}
        onAddRepo={onAddRepo}
        onAccount={onAccount}
        onShipped={onShipped}
        onOpenSession={onOpenSession}
        onOpenPr={subTab === 'pr' ? undefined : () => onSelectSubTab('pr')}
        onShowTerminal={() => onSelectSubTab('term')}
        onShowTimeline={() => onSelectSubTab('timeline')}
      />
      <nav className="wd-session-subtabs" role="tablist">
        <SubTabButton label="Terminal" active={subTab === 'term'} onClick={() => onSelectSubTab('term')} />
        <SubTabButton
          label="Diff"
          meta={files ? `${files} file${files === 1 ? '' : 's'}` : undefined}
          active={subTab === 'diff'}
          badge={session.commentCount}
          onClick={() => onSelectSubTab('diff')}
        />
        {(prButton || subTab === 'pr') && (
          <SubTabButton
            label={prButton?.label ?? 'PR'}
            meta={prButton?.meta}
            badge={prButton?.badge}
            badgeTitle={(n) => `${n} want${n === 1 ? 's' : ''} you: open review threads, failing checks, conflicts`}
            active={subTab === 'pr'}
            onClick={() => onSelectSubTab('pr')}
          />
        )}
        <SubTabButton label="Code" active={subTab === 'code'} onClick={() => onSelectSubTab('code')} />
      </nav>
      <div className={'wd-session-subtab-body' + (subTab === 'diff' && diffFull ? ' wd-diff-full' : '')}>
        {subTab === 'diff' && (
          <DiffView session={session} startOnLastTurn={startOnLastTurn} fullScreen={diffFull} onFullScreen={setDiffFull} />
        )}
        {subTab === 'term' &&
          (onTermSlot ? (
            // The dashboard's terminal deck draws the terminal over this slot,
            // so it stays connected when you switch away and back.
            <div className="wd-term-slot" ref={onTermSlot} />
          ) : (
            <PtyView sessionId={session.id} target={session.target} branch={session.branch} />
          ))}
        {prFor === session.id && (
          <div className="wd-pr-tab-slot" style={subTab === 'pr' ? undefined : { display: 'none' }}>
            <PrTab key={session.id} session={session} prs={prs} onShip={openShip} />
          </div>
        )}
        {subTab === 'code' && (
          <CodeView
            key={session.id}
            session={session}
            onShowDiff={() => onSelectSubTab('diff')}
            goto={goto?.sessionId === session.id ? goto : null}
            onSearch={isArchived(session) ? undefined : () => setSearching(true)}
          />
        )}
        {searching && <CodeSearch sessionId={session.id} onPick={openPlace} onClose={() => setSearching(false)} />}
        {/* From the ⋯ menu (and old links): no tab of its own, so it says what it is. */}
        {subTab === 'timeline' && (
          <div className="wd-timeline-tab">
            <div className="wd-timeline-head">
              <h2 className="wd-timeline-title">Timeline</h2>
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
  onAddRepo?: () => void;
  onAccount?: () => void;
  onShipped?: () => void;
  onOpenSession?: (id: string) => void;
  /** Open the PR tab (absent while it's the one shown). */
  onOpenPr?: () => void;
  /** Show the Terminal tab (Reconnect terminal). */
  onShowTerminal?: () => void;
  /** Show its timeline (⋯ → Timeline). */
  onShowTimeline?: () => void;
}

/** Title, Archive + ⋯, the status line, and what opens under them. One session's: keyed by its id. */
function SessionHeader({
  session,
  prs,
  onDelete,
  onAddRepo,
  onAccount,
  onShipped,
  onOpenSession,
  onOpenPr,
  onShowTerminal,
  onShowTimeline,
}: HeaderProps) {
  const archived = isArchived(session);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [shipOpen, setShipOpen] = useState(false);
  const [notesOpen, setNotesOpen] = useState(false);
  const [promptsOpen, setPromptsOpen] = useState(false);
  const [renameKey, setRenameKey] = useState(0);
  const [note, setNote] = useState<{ text: string; error?: boolean } | null>(null);
  // Why an Archive / Restore here was refused: its own line (not `note`, which other actions use), gone once the
  // session's archived state changes — whichever way it changed (the rail, a key, the PR watch).
  const [archiveNote, setArchiveNote] = useState<string | null>(null);
  const archivedNow = isArchived(session);
  useEffect(() => setArchiveNote(null), [archivedNow]);
  const dev = useDevState(session.id);
  const catchUp = useCatchUp(session.id);
  // One line from what the session's row says (no fetch): the PR tab has the rest.
  const needs = prNeedsLine(session);

  // On the Terminal tab, then a new connection: a terminal not mounted any more (another tab,
  // let go by the deck) connects afresh when shown; a mounted one hears the request.
  const reconnectTerminal = () => {
    onShowTerminal?.();
    requestTerminalReconnect(session.id);
  };
  const openTerminal = () => {
    setNote({ text: 'Opening in a terminal…' });
    openInTerminal(session.id).then(
      () => setNote(null),
      (err: Error) => setNote({ text: err.message, error: true }),
    );
  };
  // Its Claude's last reply as it wrote it — the terminal's copy of it is wrapped at the screen's width.
  const copyReply = () => {
    setNote({ text: 'Copying Claude’s last reply…' });
    fetchLastReply(session.id)
      .then(async (text) => {
        if (!text) return setNote({ text: 'Claude hasn’t replied in this session yet.' });
        // Its Markdown rendered too: Teams, Outlook and Word paste tables, lists and code as such.
        await writeRich({ text, html: markdownHtml(text) });
        setNote({ text: 'Copied Claude’s last reply.' });
        setTimeout(() => setNote((n) => (n?.text === 'Copied Claude’s last reply.' ? null : n)), 3000);
      })
      .catch((err: Error) => setNote({ text: `Couldn't copy it: ${err.message}`, error: true }));
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
    else if (a === 'copy-reply') copyReply();
    else if (a === 'timeline') onShowTimeline?.();
    else if (a === 'notes') setNotesOpen((o) => !o);
    else if (a === 'ship' && live) setShipOpen(true);
    else if (a === 'terminal' && live) openTerminal();
    else if (a === 'reconnect' && live) reconnectTerminal();
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
    reconnectTerminal,
    ship: () => setShipOpen(true),
    catchUp: catchUp.run,
    copyReply,
    timeline: () => onShowTimeline?.(),
    sendPrompt: () => setPromptsOpen(true),
    notes: () => setNotesOpen((o) => !o),
    devStart: () => dev.act('start'),
    devStop: () => dev.act('stop'),
    rename: () => setRenameKey((k) => k + 1),
    remove: onDelete,
    ...(onAddRepo ? { addRepo: onAddRepo } : {}),
    ...(onAccount ? { account: onAccount } : {}),
  });
  // A session folder's repos, beside its name (a single repo's session: its target says it).
  const repos = headerRepos(session);

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
        {repos.length > 0 && (
          <span className="wd-session-repos" title={`Its repos: ${repos.join(', ')}`}>
            {repos.join(' · ')}
          </span>
        )}
        {archived && (
          <span className="wd-archived-pill" title={archivedLine(session)}>
            archived{session.archive?.by ? ` · ${ARCHIVED_BY_SHORT[session.archive.by]}` : ''}
          </span>
        )}
        <div className="wd-session-actions">
          {note && (
            <span
              className={'wd-session-action-note' + (note.error ? ' wd-session-action-note-error' : '')}
              role={note.error ? 'alert' : 'status'}
            >
              {note.text}
            </span>
          )}
          {archiveNote && (
            <span className="wd-session-action-note wd-session-action-note-error" role="alert">
              {archiveNote}
            </span>
          )}
          <PromptsMenu session={session} open={promptsOpen} onOpenChange={setPromptsOpen} />
          <ArchiveButton
            sessionId={session.id}
            name={session.title ?? session.branch}
            archived={archived}
            // Why it didn't work, where the header says how things went (a Restore refused: what holds its folder).
            onStart={() => setArchiveNote(null)}
            onError={setArchiveNote}
          />
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
        <AccountChip session={session} onOpen={onAccount} />
        {session.prStage ? <PrStageChip session={session} prs={prs} /> : <PrChips prs={prs} link />}
        <DevChip dev={dev} />
        {(session.hasNote || notesOpen) && <NotesChip session={session} open={notesOpen} onToggle={() => setNotesOpen((o) => !o)} />}
      </div>
      <CatchUpPanel catchUp={catchUp} />
      {notesOpen && <SessionNotes session={session} onClose={() => setNotesOpen(false)} />}
      {needs && <NeedsYouBar text={needs} onOpen={onOpenPr} />}
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
export function ArchiveButton({
  sessionId,
  name,
  archived,
  onStart,
  onError,
}: {
  sessionId: string;
  /** What the "Archive …?" question calls it. */
  name?: string;
  archived: boolean;
  onStart?: () => void;
  /** Why it was refused, shown beside it (a tooltip alone went unseen). */
  onError?: (text: string) => void;
}) {
  // In flight is kept outside this button (archive-pending.ts): leaving the
  // session and coming back makes a new button, which must still say so.
  const pending = useArchivePending(sessionId);
  const busy = pending !== undefined;
  const [error, setError] = useState<string | null>(null);
  // Archived or restored some other way meanwhile: what this button said about the last try is over.
  useEffect(() => setError(null), [archived]);
  const onClick = () => {
    setError(null);
    onStart?.();
    setArchived(sessionId, !archived, undefined, { name }).catch((err: Error) => {
      if (archiveCancelled(err)) return; // "Archive …?" / "Archive it anyway?" → Cancel: your choice
      setError(err.message);
      onError?.(err.message);
    });
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
      {busy ? (pending ? 'Archiving…' : 'Restoring…') : archived ? (error ? 'Restore ⚠' : 'Restore') : error ? 'Archive ⚠' : 'Archive'}
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
  /** What the badge counts, in words (default: comments). */
  badgeTitle?: (n: number) => string;
}

function SubTabButton({ label, active, onClick, meta, badge, badgeTitle }: SubTabBtnProps) {
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
        <span className="wd-session-subtab-badge" title={badgeTitle ? badgeTitle(badge) : `${badge} comment${badge === 1 ? '' : 's'}`}>
          {badge}
        </span>
      ) : null}
    </button>
  );
}
