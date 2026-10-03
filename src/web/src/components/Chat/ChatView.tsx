import { createContext, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { diffLines } from 'diff';
import type { ChatPartial, ChatPermissionWire, ChatSnapshot, ChatState } from '../../../../core/api-types.js';
import { chatItems, type ChatItem, type ChatMessage } from '../../../../core/chat/chat-view.js';
import { answerChatPermission, interruptChat, sendChatMessage } from '../../api/client.js';
import { Markdown } from '../Markdown.js';

interface Props {
  sessionId: string;
  /** How to name the session's agent ("Claude Code"). */
  agentName?: string;
}

type ChatEventWire =
  | { type: 'snapshot'; snapshot: ChatSnapshot }
  | { type: 'message'; message: ChatMessage }
  | { type: 'partial'; partial: ChatPartial | null }
  | { type: 'state'; state: ChatState; error: string | null }
  | { type: 'permissions'; permissions: ChatPermissionWire[] };

/** The agent's name, for the permission bars deep in the list. */
const AgentName = createContext('Claude');

/**
 * A session's agent as a conversation (run headless: chat-session.ts). Draws
 * the chat records its adapter read: every tool is a card, whatever the tool;
 * a few well-known ones get a nicer body when their input has the shape we
 * expect, and fall back to the plain card when it doesn't.
 */
export function ChatView({ sessionId, agentName: name = 'Claude' }: Props) {
  const [snap, setSnap] = useState<ChatSnapshot | null>(null);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [terminalBlock, setTerminalBlock] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  useEffect(() => {
    setSnap(null);
    const es = new EventSource(`/api/sessions/${encodeURIComponent(sessionId)}/chat/events`);
    const on = (ev: MessageEvent) => {
      let e: ChatEventWire;
      try {
        e = JSON.parse(ev.data);
      } catch {
        return;
      }
      setSnap((s) => apply(s, e));
    };
    for (const t of ['snapshot', 'message', 'partial', 'state', 'permissions']) es.addEventListener(t, on);
    return () => es.close();
  }, [sessionId]);

  const items = useMemo(() => chatItems(snap?.messages ?? []), [snap?.messages]);
  const permissionFor = useMemo(() => {
    const m = new Map<string, ChatPermissionWire>();
    for (const p of snap?.permissions ?? []) if (p.toolUseId) m.set(p.toolUseId, p);
    return m;
  }, [snap?.permissions]);
  const shownIds = useMemo(() => new Set(items.flatMap((i) => (i.kind === 'tool' ? [i.id] : []))), [items]);
  const loosePermissions = (snap?.permissions ?? []).filter((p) => !p.toolUseId || !shownIds.has(p.toolUseId));

  // Follow the bottom while the reader is there; leave them alone when they scrolled up.
  useLayoutEffect(() => {
    const el = listRef.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [items, snap?.partial, snap?.permissions]);
  const onScroll = () => {
    const el = listRef.current;
    if (el) stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
  };

  const working = snap?.state === 'working' || snap?.state === 'starting';

  const send = async (takeOver = false) => {
    const text = draft.trim();
    if (!text || sending) return;
    setSending(true);
    setSendError(null);
    try {
      await sendChatMessage(sessionId, text, takeOver);
      setDraft('');
      setTerminalBlock(null);
      stick.current = true;
    } catch (err) {
      const msg = (err as Error).message;
      if (msg === 'terminal-running') setTerminalBlock(text);
      else if (msg === 'running-in-terminal')
        setSendError(`This session's ${name} is open in one of your terminal tabs. Exit it there (or close the tab), then send again — two of them would both write to this conversation.`);
      else setSendError(msg);
    } finally {
      setSending(false);
    }
  };

  const answer = (p: ChatPermissionWire, allow: boolean) => {
    void answerChatPermission(sessionId, p.id, allow).catch((err) => setSendError((err as Error).message));
  };

  if (!snap) return <div className="wd-chat wd-chat-loading">Loading the conversation…</div>;

  return (
    <AgentName.Provider value={name}>
    <div className="wd-chat">
      <div className="wd-chat-list" ref={listRef} onScroll={onScroll}>
        {items.length === 0 && !snap.partial && (
          <div className="wd-chat-empty">No conversation yet. Say what {name} should do.</div>
        )}
        {items.map((it) => (
          <Item key={it.key} item={it} permission={it.kind === 'tool' ? permissionFor.get(it.id) : undefined} onAnswer={answer} />
        ))}
        {loosePermissions.map((p) => (
          <div key={p.id} className="wd-chat-tool wd-chat-tool-asking">
            <div className="wd-chat-tool-head">
              <span className="wd-chat-tool-name">{p.toolName}</span>
            </div>
            <pre className="wd-chat-pre">{JSON.stringify(p.input, null, 2)}</pre>
            <PermissionBar p={p} onAnswer={answer} />
          </div>
        ))}
        {snap.partial && (
          snap.partial.kind === 'thinking'
            ? <div className="wd-chat-thinking wd-chat-live">Thinking…</div>
            : <div className="wd-chat-text wd-chat-live"><Markdown source={snap.partial.text} block /></div>
        )}
      </div>

      <div className="wd-chat-status" role="status">
        {snap.state === 'starting' && `Starting ${name}…`}
        {snap.state === 'working' && (
          <>
            <span className="wd-chat-dot" /> {name} is working
            <button type="button" className="wd-btn-secondary wd-chat-stop" onClick={() => void interruptChat(sessionId)}>
              Stop (Esc)
            </button>
          </>
        )}
        {snap.state === 'needs_input' && 'Waiting for you'}
        {snap.state === 'exited' && <span className="wd-chat-error">{name} stopped: {snap.error ?? 'unknown reason'}. Send a message to resume.</span>}
        {sendError && <span className="wd-chat-error">{sendError}</span>}
      </div>

      {terminalBlock !== null && (
        <div className="wd-chat-takeover">
          This session&apos;s {name} is running in the terminal. Moving it here stops that one and continues the same
          conversation in the chat.
          <button type="button" className="wd-btn-primary" onClick={() => void send(true)} disabled={sending}>
            Move it here and send
          </button>
          <button type="button" className="wd-btn-secondary" onClick={() => setTerminalBlock(null)}>
            Cancel
          </button>
        </div>
      )}

      <div className="wd-chat-composer">
        <textarea
          value={draft}
          placeholder={working ? `Message ${name} (it reads it after the current step)…` : `Message ${name}…`}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              void send();
            } else if (e.key === 'Escape' && working) {
              e.preventDefault();
              void interruptChat(sessionId);
            }
          }}
          rows={3}
        />
        <button type="button" className="wd-btn-primary" onClick={() => void send()} disabled={sending || !draft.trim()}>
          Send
        </button>
      </div>
    </div>
    </AgentName.Provider>
  );
}

/** Fold one server event into the snapshot. */
function apply(s: ChatSnapshot | null, e: ChatEventWire): ChatSnapshot | null {
  if (e.type === 'snapshot') return e.snapshot;
  if (!s) return s;
  switch (e.type) {
    case 'message':
      return s.messages.length && s.messages[s.messages.length - 1].seq >= e.message.seq ? s : { ...s, messages: [...s.messages, e.message] };
    case 'partial':
      return { ...s, partial: e.partial };
    case 'state':
      return { ...s, state: e.state, error: e.error };
    case 'permissions':
      return { ...s, permissions: e.permissions };
  }
}

function Item({ item, permission, onAnswer }: { item: ChatItem; permission?: ChatPermissionWire; onAnswer: (p: ChatPermissionWire, allow: boolean) => void }) {
  switch (item.kind) {
    case 'user':
      return <div className="wd-chat-user">{item.text}</div>;
    case 'tagged':
      return <Tagged parts={item.parts} />;
    case 'text':
      return <div className="wd-chat-text"><Markdown source={item.text} block /></div>;
    case 'thinking':
      return (
        <details className="wd-chat-thinking">
          <summary>Thinking</summary>
          <div className="wd-chat-thinking-body">{item.text}</div>
        </details>
      );
    case 'tool':
      return <ToolCard item={item} permission={permission} onAnswer={onAnswer} />;
    case 'result':
      return (
        <div className={'wd-chat-result' + (item.ok ? '' : ' wd-chat-result-bad')}>
          {item.ok ? 'Done' : item.subtype === 'error_during_execution' ? 'Stopped' : `Ended: ${item.subtype}`}
          {item.durationMs !== null && ` · ${formatDuration(item.durationMs)}`}
        </div>
      );
    case 'notice':
      return <div className="wd-chat-notice">{item.text}</div>;
    case 'raw':
      return (
        <details className="wd-chat-raw">
          <summary>{item.label}</summary>
          <pre className="wd-chat-pre">{JSON.stringify(item.raw, null, 2)}</pre>
        </details>
      );
  }
}

/**
 * Something you did in Claude Code rather than said: a `!` command and its
 * output, a slash command. Known tags get a familiar look; any other tag is
 * shown under its own name.
 */
function Tagged({ parts }: { parts: Array<{ tag: string; text: string }> }) {
  const byTag = new Map(parts.map((p) => [p.tag, p.text]));
  const rows: ReactNode[] = [];
  parts.forEach((p, i) => {
    if (!p.text && p.tag !== 'command-name') return;
    switch (p.tag) {
      case 'bash-input':
        rows.push(<pre key={i} className="wd-chat-pre wd-chat-cmd">$ {p.text}</pre>);
        break;
      case 'command-name':
        rows.push(<pre key={i} className="wd-chat-pre wd-chat-cmd">{`${p.text} ${byTag.get('command-args') ?? ''}`.trim()}</pre>);
        break;
      case 'command-message':
      case 'command-args':
        break; // folded into command-name
      case 'bash-stderr':
      case 'local-command-stderr':
        rows.push(<pre key={i} className="wd-chat-pre wd-chat-stderr">{p.text}</pre>);
        break;
      case 'bash-stdout':
      case 'local-command-stdout':
        rows.push(<pre key={i} className="wd-chat-pre">{p.text}</pre>);
        break;
      default:
        rows.push(
          <div key={i}>
            <div className="wd-chat-tag">{p.tag}</div>
            <pre className="wd-chat-pre">{p.text}</pre>
          </div>,
        );
    }
  });
  if (rows.length === 0) return null;
  return <div className="wd-chat-local">{rows}</div>;
}

const formatDuration =(ms: number) => (ms < 60_000 ? `${Math.round(ms / 1000)} s` : `${Math.floor(ms / 60_000)} min ${Math.round((ms % 60_000) / 1000)} s`);

// ---------------------------------------------------------------- tools

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);
const s = (v: unknown) => (typeof v === 'string' ? v : null);

/** A nicer body for a few tools — only when the input looks as expected. */
interface Special {
  summary: string;
  body: ReactNode;
}

function special(name: string, input: unknown): Special | null {
  if (!isObj(input)) return null;
  if (name === 'Bash' && s(input.command)) {
    return { summary: s(input.description) ?? s(input.command)!, body: <pre className="wd-chat-pre wd-chat-cmd">$ {s(input.command)}</pre> };
  }
  if ((name === 'Edit' || name === 'MultiEdit') && s(input.file_path)) {
    const edits = name === 'Edit' ? [input] : Array.isArray(input.edits) ? input.edits.filter(isObj) : null;
    if (!edits || edits.some((e) => s(e.old_string) === null || s(e.new_string) === null)) return null;
    return { summary: s(input.file_path)!, body: <>{edits.map((e, i) => <EditDiff key={i} before={s(e.old_string)!} after={s(e.new_string)!} />)}</> };
  }
  if (name === 'Write' && s(input.file_path) && s(input.content) !== null) {
    return { summary: s(input.file_path)!, body: <EditDiff before="" after={s(input.content)!} /> };
  }
  if ((name === 'Read' || name === 'NotebookRead') && s(input.file_path)) return { summary: s(input.file_path)!, body: null };
  if ((name === 'Grep' || name === 'Glob') && s(input.pattern)) {
    return { summary: `${s(input.pattern)}${s(input.path) ? ` in ${s(input.path)}` : ''}`, body: null };
  }
  if (name === 'TodoWrite' && Array.isArray(input.todos)) {
    const todos = input.todos.filter(isObj).filter((t) => s(t.content));
    return {
      summary: `${todos.filter((t) => t.status === 'completed').length}/${todos.length} done`,
      body: (
        <ul className="wd-chat-todos">
          {todos.map((t, i) => (
            <li key={i} className={`wd-chat-todo-${s(t.status) ?? 'pending'}`}>{t.status === 'completed' ? '☑' : t.status === 'in_progress' ? '▸' : '☐'} {s(t.content)}</li>
          ))}
        </ul>
      ),
    };
  }
  return null;
}

function ToolCard({ item, permission, onAnswer }: { item: Extract<ChatItem, { kind: 'tool' }>; permission?: ChatPermissionWire; onAnswer: (p: ChatPermissionWire, allow: boolean) => void }) {
  const sp = special(item.name, item.input);
  const [open, setOpen] = useState(!!permission);
  useEffect(() => {
    if (permission) setOpen(true);
  }, [permission]);
  const running = !item.result && !permission;
  return (
    <div className={'wd-chat-tool' + (permission ? ' wd-chat-tool-asking' : '') + (item.result?.isError ? ' wd-chat-tool-error' : '')}>
      <button type="button" className="wd-chat-tool-head" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <span className="wd-chat-tool-name">{item.name}</span>
        <span className="wd-chat-tool-summary">{sp?.summary ?? summarize(item.input)}</span>
        {running && <span className="wd-chat-tool-running">running…</span>}
        {item.result?.isError && <span className="wd-chat-tool-bad">failed</span>}
      </button>
      {open && (
        <div className="wd-chat-tool-body">
          {sp ? sp.body : <pre className="wd-chat-pre">{JSON.stringify(item.input, null, 2)}</pre>}
          {item.result && item.result.text && <ResultText text={item.result.text} />}
        </div>
      )}
      {permission && <PermissionBar p={permission} onAnswer={onAnswer} />}
    </div>
  );
}

function summarize(input: unknown): string {
  if (!isObj(input)) return '';
  const first = Object.values(input).find((v) => typeof v === 'string') as string | undefined;
  return first ? first.split('\n')[0].slice(0, 120) : '';
}

function ResultText({ text }: { text: string }) {
  const lines = text.split('\n');
  const [all, setAll] = useState(lines.length <= 14);
  return (
    <div className="wd-chat-result-text">
      <pre className="wd-chat-pre">{all ? text : lines.slice(0, 12).join('\n')}</pre>
      {!all && (
        <button type="button" className="wd-link-button" onClick={() => setAll(true)}>
          Show all {lines.length} lines
        </button>
      )}
    </div>
  );
}

function EditDiff({ before, after }: { before: string; after: string }) {
  const parts = useMemo(() => diffLines(before, after), [before, after]);
  return (
    <pre className="wd-chat-pre wd-chat-diff">
      {parts.map((p, i) =>
        p.value
          .replace(/\n$/, '')
          .split('\n')
          .map((line, j) => (
            <div key={`${i}:${j}`} className={p.added ? 'wd-chat-diff-add' : p.removed ? 'wd-chat-diff-del' : 'wd-chat-diff-ctx'}>
              {p.added ? '+ ' : p.removed ? '- ' : '  '}
              {line}
            </div>
          )),
      )}
    </pre>
  );
}

function PermissionBar({ p, onAnswer }: { p: ChatPermissionWire; onAnswer: (p: ChatPermissionWire, allow: boolean) => void }) {
  return (
    <div className="wd-chat-permission">
      <span>{useContext(AgentName)} wants to use <b>{p.toolName}</b>.</span>
      <button type="button" className="wd-btn-primary" onClick={() => onAnswer(p, true)}>Allow</button>
      <button type="button" className="wd-btn-secondary" onClick={() => onAnswer(p, false)}>Deny</button>
    </div>
  );
}
