import { PtyView } from '../Terminal/LazyPtyView.js';

/** The assistant's session id (core/assistant.ts ASSISTANT_ID). */
export const ASSISTANT_SESSION = 'assistant';

interface Props {
  open: boolean;
  onClose: () => void;
  /** What it sees — "the Sessions tab", "api · feat/x (diff)". */
  seeing: string;
}

/**
 * The Ctrl+K assistant: a real agent session (in the PTY host, like any
 * worktree's) that knows what the dashboard shows — each prompt carries it —
 * and reads everything through the `work … --json` commands. Its permission
 * prompts show here; nothing changes without one.
 *
 * Mounted from the first open and only hidden after, so reopening is instant
 * and the conversation stays on screen.
 */
export function AssistantPanel({ open, onClose, seeing }: Props) {
  return (
    <aside className={'wd-assistant' + (open ? ' wd-assistant-open' : '')} aria-label="Assistant" aria-hidden={!open}>
      <header className="wd-assistant-header">
        <span className="wd-assistant-title">Assistant</span>
        <span className="wd-assistant-seeing" title="Each message you send includes this">
          sees: {seeing}
        </span>
        <span className="wd-assistant-keys">
          <kbd>Ctrl</kbd>+<kbd>K</kbd>
        </span>
        <button type="button" className="wd-assistant-close" onClick={onClose} aria-label="Close the assistant">
          ×
        </button>
      </header>
      <div className="wd-assistant-body">
        <PtyView sessionId={ASSISTANT_SESSION} />
      </div>
    </aside>
  );
}
