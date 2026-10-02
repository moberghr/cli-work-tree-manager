import { useEffect, useRef, useState } from 'react';
import { fetchNote, saveNote, sendPromptToSession, type SessionSummary } from '../../api/client.js';

/** How long typing must pause before the note is saved. */
const SAVE_AFTER_MS = 700;

/** In the session strip: 📝 Notes — with a dot when it has some. */
export function NotesChip({ session, open, onToggle }: { session: SessionSummary; open: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      className={'wd-notes-chip' + (open ? ' wd-notes-chip-open' : '')}
      aria-expanded={open}
      onClick={onToggle}
      title={session.hasNote ? 'Your notes on this session' : 'Notes: yours, not part of the conversation'}
    >
      <span aria-hidden>📝</span> Notes{session.hasNote ? ' •' : ''}
    </button>
  );
}

/**
 * Your notes on a session (core/session-notes.ts): a scratchpad of your own,
 * saved as you type (a pause), every window's. Not sent to Claude unless you
 * press Send to Claude, which hands it over as a message like a comment.
 */
export function SessionNotes({ session, onClose }: { session: SessionSummary; onClose: () => void }) {
  const [text, setText] = useState<string | null>(null);
  const [state, setState] = useState<'idle' | 'saving' | 'saved' | 'sent' | { error: string }>('idle');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latest = useRef('');
  useEffect(() => {
    let live = true;
    setText(null);
    fetchNote(session.id).then(
      (n) => live && setText(n?.text ?? ''),
      (err: Error) => live && (setText(''), setState({ error: err.message })),
    );
    return () => {
      live = false;
    };
  }, [session.id]);
  // A pending save is not lost when the panel closes or the session changes.
  useEffect(
    () => () => {
      if (timer.current) {
        clearTimeout(timer.current);
        void saveNote(session.id, latest.current).catch(() => {});
      }
    },
    [session.id],
  );
  const save = (value: string) => {
    setState('saving');
    saveNote(session.id, value).then(
      () => setState('saved'),
      (err: Error) => setState({ error: err.message }),
    );
  };
  const change = (value: string) => {
    setText(value);
    latest.current = value;
    setState('saving');
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      timer.current = null;
      save(value);
    }, SAVE_AFTER_MS);
  };
  const send = () => {
    if (!text?.trim()) return;
    setState('saving');
    sendPromptToSession(session.id, `A note from me on this session:\n\n${text.trim()}`).then(
      () => setState('sent'),
      (err: Error) => setState({ error: err.message }),
    );
  };
  const status =
    typeof state === 'object' ? `⚠ ${state.error}` : state === 'saving' ? 'Saving…' : state === 'saved' ? 'Saved' : state === 'sent' ? 'Sent to its Claude' : '';
  return (
    <section className="wd-notes" aria-label="Your notes on this session">
      <textarea
        className="wd-notes-text"
        value={text ?? ''}
        disabled={text === null}
        placeholder={text === null ? 'Loading…' : 'Your notes: what you decided, what to tell the reviewer, what is next. Saved as you type; only yours until you send them.'}
        onChange={(e) => change(e.target.value)}
        rows={5}
        aria-label="Notes"
      />
      <div className="wd-notes-bar">
        <span className={'wd-notes-status' + (typeof state === 'object' ? ' wd-tab-error' : '')} role="status">
          {status}
        </span>
        <button type="button" className="wd-session-detail-btn" onClick={send} disabled={!text?.trim()} title="Hand the notes to its Claude as a message">
          Send to Claude
        </button>
        <button type="button" className="wd-link-button" onClick={onClose}>
          Close
        </button>
      </div>
    </section>
  );
}
