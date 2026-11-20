import { useEffect, useRef, useState } from 'react';
import { fetchLastReply, sendPromptToSession, type SessionSummary } from '../../api/client.js';
import { agentName } from '../../state/session-display.js';
import { Markdown } from '../Markdown.js';

interface Props {
  session: SessionSummary;
  /** It was sent: the row is dealt with. */
  onSent: () => void;
  onClose: () => void;
  /** Test seams; default to the API calls. */
  load?: (sessionId: string) => Promise<string | null>;
  send?: (sessionId: string, body: string) => Promise<void>;
}

/** What you typed, as it is sent: null while there is nothing to send. Pure. */
export function followUpText(draft: string): string | null {
  const t = draft.trim();
  return t ? t : null;
}

/**
 * A finished session answered from the Inbox (asked for: the Inbox said a session was done, and the only way to say
 * "now also do X" was to open it): what its agent last said, in full, and a box for your follow-up. Send hands it to
 * the session the way a prompt from its menu goes (`sendPromptToSession`: typed into a terminal the dashboard owns,
 * else delivered on its next turn — never over what is in its prompt box) and the row is marked seen.
 */
export function InboxFollowUp({ session, onSent, onClose, load = fetchLastReply, send = sendPromptToSession }: Props) {
  const [reply, setReply] = useState<string | null | undefined>(undefined);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const box = useRef<HTMLTextAreaElement>(null);
  const id = session.id;

  useEffect(() => {
    let gone = false;
    setReply(undefined);
    load(id).then(
      (text) => {
        if (!gone) setReply(text);
      },
      () => {
        if (!gone) setReply(null);
      },
    );
    return () => {
      gone = true;
    };
  }, [id, load]);
  useEffect(() => box.current?.focus(), [id]);

  const text = followUpText(draft);
  const submit = () => {
    if (!text || sending) return;
    setSending(true);
    setError(null);
    send(id, text).then(onSent, (e: Error) => {
      setError(e.message);
      setSending(false);
    });
  };

  return (
    <div className="wd-inbox-followup" role="group" aria-label={`Follow up with ${session.branch}`}>
      <div className="wd-inbox-followup-reply">
        {reply === undefined ? (
          <p className="wd-start-note">Reading what it said…</p>
        ) : reply ? (
          <Markdown source={reply} block />
        ) : (
          <p className="wd-start-note">{agentName(session)} hasn’t replied in this session yet.</p>
        )}
      </div>
      <textarea
        ref={box}
        className="wd-inbox-followup-box"
        rows={2}
        value={draft}
        placeholder={`Your follow-up for ${agentName(session)} (Enter sends, Shift+Enter adds a line)`}
        aria-label="Follow-up"
        disabled={sending}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            submit();
          } else if (e.key === 'Escape') {
            e.stopPropagation();
            onClose();
          }
        }}
      />
      <div className="wd-inbox-followup-actions">
        <button type="button" className="wd-btn-primary" disabled={!text || sending} onClick={submit}>
          {sending ? 'Sending…' : 'Send'}
        </button>
        <button type="button" className="wd-btn-secondary" disabled={sending} onClick={onClose}>
          Cancel
        </button>
        <span className="wd-start-note">It goes to its {agentName(session)} as your next message, and the row is marked seen.</span>
        {error && (
          <span className="wd-inbox-answer-error" role="alert">
            {error}
          </span>
        )}
      </div>
    </div>
  );
}
