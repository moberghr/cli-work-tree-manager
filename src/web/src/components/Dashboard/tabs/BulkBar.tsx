import { useState } from 'react';
import type { SessionSummary } from '../../../api/client.js';
import type { SnoozeChoice, SnoozeFor } from '../../../../../core/snooze.js';
import { SnoozeUntilDialog } from '../SnoozeUntilDialog.js';
import { RowMenu } from '../RowMenu.js';
import type { PlacePatch, RailSection } from '../../../../../core/rail-layout.js';

/** What the bulk bar can do; each returns a promise per session (the same calls as the one-session buttons). */
export interface BulkActions {
  archive: (s: SessionSummary) => Promise<unknown>;
  restore: (s: SessionSummary) => Promise<unknown>;
  snooze: (s: SessionSummary, choice: SnoozeChoice) => Promise<unknown>;
  send: (s: SessionSummary, text: string) => Promise<unknown>;
  remove: (s: SessionSummary) => Promise<unknown>;
  /** Pin / unpin, or move into (or out of) a rail section. */
  place?: (s: SessionSummary, patch: PlacePatch) => Promise<unknown>;
}

/**
 * The bar over the Sessions table while sessions are ticked: archive /
 * restore / snooze them, send them all one prompt, or delete them. Delete asks
 * first and never forces: one with uncommitted or unpushed work is refused,
 * and said so. Progress shows here; the outcome as one line.
 */
export function BulkBar({
  selected,
  hidden = 0,
  actions,
  onRun,
  onClear,
  busy,
  sections = [],
}: {
  selected: SessionSummary[];
  /** Ticked, but hidden by the filter: left out. */
  hidden?: number;
  actions: BulkActions;
  /** Run `act` over these sessions; the table owns progress and the outcome. */
  onRun: (verb: string, act: (s: SessionSummary) => Promise<unknown>, which: SessionSummary[]) => void;
  onClear: () => void;
  busy: string | null;
  /** The rail's sections, for Move to. */
  sections?: RailSection[];
}) {
  const [mode, setMode] = useState<null | 'send' | 'delete'>(null);
  const [text, setText] = useState('');
  const [snoozeAt, setSnoozeAt] = useState<{ x: number; y: number } | null>(null);
  const [until, setUntil] = useState(false);
  const [moveAt, setMoveAt] = useState<{ x: number; y: number } | null>(null);
  const live = selected.filter((s) => !s.archivedAt);
  const archived = selected.filter((s) => !!s.archivedAt);
  return (
    <div className="wd-bulk-bar" role="toolbar" aria-label="Act on the ticked sessions">
      <span className="wd-bulk-count">{selected.length} selected</span>
      {hidden > 0 && <span className="wd-bulk-hidden" title="Ticked, but hidden by the filter or search: the bar leaves them out">(+{hidden} hidden, not included)</span>}
      {busy ? (
        <span className="wd-bulk-busy">{busy}</span>
      ) : mode === 'send' ? (
        <form
          className="wd-bulk-send"
          onSubmit={(e) => {
            e.preventDefault();
            if (!text.trim()) return;
            onRun('Sent to', (s) => actions.send(s, text.trim()), live);
            setText('');
            setMode(null);
          }}
        >
          <textarea
            autoFocus
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={`What to tell ${live.length === 1 ? 'its Claude' : `their ${live.length} Claudes`} (delivered like a review comment: now in a terminal the dashboard owns, else on its next turn)`}
            rows={2}
            aria-label="Prompt to send"
          />
          <button type="submit" className="wd-btn-primary" disabled={!text.trim() || live.length === 0}>
            Send to {live.length}
          </button>
          <button type="button" className="wd-btn-secondary" onClick={() => setMode(null)}>
            Cancel
          </button>
        </form>
      ) : mode === 'delete' ? (
        <span className="wd-bulk-confirm" role="alert">
          Delete {selected.length} session{selected.length === 1 ? '' : 's'}? A worktree goes only where nothing would be lost; the others are refused and listed.{' '}
          <button
            type="button"
            className="wd-btn-danger"
            onClick={() => {
              setMode(null);
              onRun('Deleted', (s) => actions.remove(s), selected);
            }}
          >
            Delete
          </button>
          <button type="button" className="wd-btn-secondary" onClick={() => setMode(null)}>
            Cancel
          </button>
        </span>
      ) : (
        <>
          {live.length > 0 && (
            <button type="button" className="wd-btn-secondary" onClick={() => onRun('Archived', (s) => actions.archive(s), live)}>
              Archive {live.length}
            </button>
          )}
          {archived.length > 0 && (
            <button type="button" className="wd-btn-secondary" onClick={() => onRun('Restored', (s) => actions.restore(s), archived)}>
              Restore {archived.length}
            </button>
          )}
          {live.length > 0 && (
            <button
              type="button"
              className="wd-btn-secondary"
              onClick={(e) => {
                const r = e.currentTarget.getBoundingClientRect();
                setSnoozeAt({ x: r.left, y: r.bottom + 2 });
              }}
            >
              Snooze {live.length} ▾
            </button>
          )}
          {live.length > 0 && (
            <button type="button" className="wd-btn-secondary" onClick={() => setMode('send')}>
              Send a prompt…
            </button>
          )}
          {live.length > 0 && actions.place && (
            <button
              type="button"
              className="wd-btn-secondary"
              onClick={(e) => {
                const r = e.currentTarget.getBoundingClientRect();
                setMoveAt({ x: r.left, y: r.bottom + 2 });
              }}
              title="Pin them, or put them under one of the rail's sections"
            >
              Rail ▾
            </button>
          )}
          <button type="button" className="wd-btn-secondary wd-bulk-delete" onClick={() => setMode('delete')}>
            Delete…
          </button>
          <button type="button" className="wd-link-button" onClick={onClear}>
            Clear
          </button>
        </>
      )}
      {snoozeAt && (
        <RowMenu
          x={snoozeAt.x}
          y={snoozeAt.y}
          onClose={() => setSnoozeAt(null)}
          items={(
            [
              ['2 hours', '2h'],
              ['Until tomorrow 9:00', 'tomorrow'],
              ['Until it changes', 'change'],
            ] as Array<[string, SnoozeFor]>
          )
            .map(([label, choice]) => ({ label, run: () => onRun('Snoozed', (s) => actions.snooze(s, choice), live) }))
            .concat([{ label: 'Until…', run: () => setUntil(true) }])}
        />
      )}
      {moveAt && actions.place && (
        <RowMenu
          x={moveAt.x}
          y={moveAt.y}
          onClose={() => setMoveAt(null)}
          items={[
            { label: `Pin ${live.length}`, run: () => onRun('Pinned', (s) => actions.place!(s, { pinned: true }), live) },
            { label: `Unpin ${live.length}`, run: () => onRun('Unpinned', (s) => actions.place!(s, { pinned: false }), live) },
            ...sections.map((sec, i) => ({
              label: `Move to “${sec.name}”`,
              run: () => onRun(`Moved to “${sec.name}”`, (s) => actions.place!(s, { pinned: false, section: sec.id }), live),
              ...(i === 0 ? { separated: true } : {}),
            })),
            ...(sections.length ? [{ label: 'Out of their section', run: () => onRun('Took out of their section', (s) => actions.place!(s, { section: null }), live) }] : []),
          ]}
        />
      )}
      {until && (
        <SnoozeUntilDialog
          count={live.length}
          onClose={() => setUntil(false)}
          onPick={(at) => {
            setUntil(false);
            onRun('Snoozed', (s) => actions.snooze(s, { until: at }), live);
          }}
        />
      )}
    </div>
  );
}
