import { useEffect, useMemo, useRef, useState } from 'react';
import type { SessionShownWire } from '../../../../core/api-types.js';
import { closeSessionShown, fetchCodeFile, fetchShownText, type SessionSummary } from '../../api/client.js';
import { openTerminalPath, type TerminalPathHow } from '../../api/panes.js';
import { markdownOutline } from '../../state/shown-file.js';
import { platformOf, revealLabel } from '../../state/terminal-links.js';
import { Markdown } from '../Markdown.js';

type Shown = NonNullable<SessionShownWire['shown']>;

interface Props {
  session: SessionSummary;
  shown: Shown;
  /** Asked to close (the default tells the server, which tells every window). */
  onClose?: () => void;
  /** Open it in the Code tab. */
  onOpenCode?: () => void;
  /** Test seam; defaults to the Code tab's read. */
  load?: (sessionId: string, repo: string, path: string) => Promise<{ text: string | null; reason?: string }>;
  /** Test seam: a scratch file's read (defaults to GET …/show/text). */
  loadTemp?: (sessionId: string) => Promise<{ text: string | null; reason?: string }>;
  /** Test seam: Open in app / Show in Finder (defaults to the terminal paths' open route). */
  open?: (sessionId: string, path: string, how: TerminalPathHow) => Promise<unknown>;
}

/** The frame an HTML page is drawn in: the same sandbox its response carries (session-show-routes.ts SHOWN_PAGE_SANDBOX). */
export const SHOWN_FRAME_SANDBOX = 'allow-scripts allow-popups allow-forms';

/** How often an open pane reads the file again: it follows the file while the agent goes on writing it. */
export const SHOWN_REFRESH_MS = 3000;

/**
 * The file a session shows, beside its terminal (core/sessions/shown-file.ts): Markdown rendered with its contents
 * to jump by, an image drawn, anything else as text. It reads the file again every few seconds, so a spec the agent
 * revises is the revised one. Read only.
 */
export function ShownFilePane({
  session,
  shown,
  onClose,
  onOpenCode,
  load = fetchCodeFile,
  loadTemp = fetchShownText,
  open = openTerminalPath,
}: Props) {
  const [text, setText] = useState<string | null | undefined>(undefined);
  const [problem, setProblem] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  // An HTML page is drawn again only when its file changed: a reload for nothing would reset what you did in it.
  const [version, setVersion] = useState(0);
  const lastText = useRef<string | null | undefined>(undefined);
  const body = useRef<HTMLDivElement>(null);
  const id = session.id;
  const { repo, path, kind, at, temp, abs } = shown;

  useEffect(() => {
    if (kind === 'image') return;
    let gone = false;
    lastText.current = undefined;
    setText(undefined);
    setProblem(null);
    const read = () =>
      (temp ? loadTemp(id) : load(id, repo, path)).then(
        (f) => {
          if (gone) return;
          setProblem(f.text === null ? (f.reason === 'too-large' ? 'It is too large to show here.' : 'It isn’t text.') : null);
          // The same text again changes nothing (no re-render, the scroll stays).
          if (lastText.current !== undefined && lastText.current !== f.text) setVersion((v) => v + 1);
          lastText.current = f.text;
          setText((was) => (was === f.text ? was : f.text));
        },
        (e: Error) => {
          if (!gone) setProblem(e.message);
        },
      );
    void read();
    const timer = setInterval(() => {
      if (!document.hidden) void read();
    }, SHOWN_REFRESH_MS);
    return () => {
      gone = true;
      clearInterval(timer);
    };
  }, [id, repo, path, kind, at, temp, load, loadTemp]);

  const outline = useMemo(() => (kind === 'markdown' && text ? markdownOutline(text) : []), [kind, text]);
  /** The nth heading of the rendered page (the outline's order is the page's). */
  const jump = (n: number) => body.current?.querySelectorAll('h1, h2, h3, h4, h5, h6')[n]?.scrollIntoView({ block: 'start' });
  const close = onClose ?? (() => void closeSessionShown(id).catch(() => undefined));
  const openIt = (how: TerminalPathHow) => {
    if (!abs) return;
    setNote(null);
    open(id, abs, how).catch((e: Error) => setNote(e.message));
  };

  return (
    <aside className="wd-shown" aria-label={`${path} (shown by this session)`}>
      <header className="wd-shown-head">
        <span className="wd-shown-name" title={repo ? `${repo}/${path}` : path}>
          {path}
        </span>
        <span className="wd-start-note">read-only</span>
        <span className="wd-shown-actions">
          {abs && (
            <>
              <button type="button" className="wd-link-button" onClick={() => openIt('default')} title="Open it with its usual program">
                Open in app
              </button>
              <button type="button" className="wd-link-button" onClick={() => openIt('reveal')} title="Show the folder it is in">
                {revealLabel(platformOf(navigator.userAgent))}
              </button>
            </>
          )}
          {onOpenCode && !temp && (
            <button type="button" className="wd-link-button" onClick={onOpenCode} title="Open it in the Code tab">
              Code tab
            </button>
          )}
          <button type="button" className="wd-link-button" onClick={close} aria-label="Close" title="Stop showing it">
            ×
          </button>
        </span>
      </header>
      {note && <p className="wd-start-note wd-shown-note">{note}</p>}
      <div className="wd-shown-main">
        {outline.length > 1 && (
          <nav className="wd-shown-outline" aria-label="Contents">
            <h4>Contents</h4>
            <ul>
              {outline.map((h, n) => (
                <li key={n} className={`wd-shown-outline-${Math.min(h.level, 3)}`}>
                  <button type="button" className="wd-link-button wd-link-button-muted" onClick={() => jump(n)} title={h.text}>
                    {h.text}
                  </button>
                </li>
              ))}
            </ul>
          </nav>
        )}
        <div className="wd-shown-body" ref={body}>
          {kind === 'image' ? (
            <img src={`/api/sessions/${encodeURIComponent(id)}/show/image?at=${encodeURIComponent(at)}`} alt={path} />
          ) : problem ? (
            <p className="wd-start-note">{problem}</p>
          ) : text === undefined || text === null ? (
            <p className="wd-start-note">Reading…</p>
          ) : kind === 'html' ? (
            // Its own page, sandboxed (scripts on, an origin of its own: it can't reach this page or work's server).
            <iframe
              key={version}
              className="wd-shown-frame"
              title={path}
              sandbox={SHOWN_FRAME_SANDBOX}
              referrerPolicy="no-referrer"
              src={`/api/sessions/${encodeURIComponent(id)}/show/page?at=${encodeURIComponent(at)}&v=${version}`}
            />
          ) : kind === 'markdown' ? (
            <Markdown source={text} block />
          ) : (
            <pre className="wd-shown-text">{text}</pre>
          )}
        </div>
      </div>
    </aside>
  );
}
