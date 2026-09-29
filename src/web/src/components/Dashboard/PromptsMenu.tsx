import { useEffect, useRef, useState } from 'react';
import type { PromptsResponse, SavedPrompt, SessionSummary } from '../../api/client.js';
import { promptsForSession } from '../../../../core/saved-prompts.js';

interface Props {
  session: SessionSummary;
  /** Test seams; default to the API. */
  loadPrompts?: () => Promise<PromptsResponse>;
  send?: (sessionId: string, prompt: string) => Promise<unknown>;
}

async function fetchPrompts(): Promise<PromptsResponse> {
  const res = await fetch('/api/prompts', { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`prompts: ${res.status}`);
  return res.json() as Promise<PromptsResponse>;
}

/** Sent like a review comment: pushed to a terminal the dashboard owns, or
 *  delivered on the session's next turn — never typed over a prompt. */
async function sendPrompt(sessionId: string, body: string): Promise<void> {
  const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/comments`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ side: 'general', status: 'published', body }),
  });
  if (!res.ok) throw new Error(`send failed (${res.status})`);
}

/**
 * "Prompts ▾" in the session header: the saved one-click instructions that
 * apply to this session (config `prompts`, or the built-in ones).
 */
export function PromptsMenu({ session, loadPrompts = fetchPrompts, send = sendPrompt }: Props) {
  const [open, setOpen] = useState(false);
  const [prompts, setPrompts] = useState<SavedPrompt[] | null>(null);
  const [state, setState] = useState<{ kind: 'sending' | 'sent' | 'error'; text: string } | null>(null);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open || prompts) return;
    loadPrompts().then(
      (r) => setPrompts(r.prompts),
      () => setPrompts([]),
    );
  }, [open, prompts, loadPrompts]);

  // Close on a click elsewhere or Escape.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (root.current && !root.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  // A switch to another session resets it.
  useEffect(() => {
    setOpen(false);
    setState(null);
  }, [session.id]);

  const repoNames = session.isGroup ? session.paths.map((p) => p.split(/[\\/]/).pop() ?? '') : [];
  const list = prompts ? promptsForSession(prompts, session.target, repoNames) : null;
  // Where it will land: typed into a terminal the dashboard owns, after the
  // current turn, or on the next turn of a Claude running elsewhere.
  const whenDelivered = (label: string) =>
    session.attention?.state === 'working'
      ? `"${label}" queued: Claude gets it when this turn ends`
      : session.ptyStatus === 'running'
        ? `"${label}" sent to Claude`
        : `"${label}" queued for its next turn (its Claude isn't running in the dashboard)`;

  const pick = (p: SavedPrompt) => {
    setOpen(false);
    setState({ kind: 'sending', text: `Sending "${p.label}"…` });
    const id = session.id;
    send(id, p.prompt).then(
      () => setState({ kind: 'sent', text: whenDelivered(p.label) }),
      (err: unknown) => setState({ kind: 'error', text: err instanceof Error ? err.message : String(err) }),
    );
  };

  return (
    <div className="wd-prompts" ref={root}>
      <button
        type="button"
        className="wd-session-detail-btn"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        title="Send Claude a saved instruction"
      >
        Prompts ▾
      </button>
      {open && (
        <ul className="wd-prompts-menu" role="menu">
          {list === null ? (
            <li className="wd-prompts-empty">Loading…</li>
          ) : list.length === 0 ? (
            <li className="wd-prompts-empty">No prompts for this repo. Add some under "prompts" in ~/.work/config.json.</li>
          ) : (
            list.map((p) => (
              <li key={p.label} role="none">
                <button type="button" role="menuitem" className="wd-prompts-item" onClick={() => pick(p)} title={p.prompt}>
                  {p.label}
                </button>
              </li>
            ))
          )}
        </ul>
      )}
      {state && (
        <span className={`wd-prompts-state wd-prompts-state-${state.kind}`} role="status">
          {state.text}
        </span>
      )}
    </div>
  );
}
