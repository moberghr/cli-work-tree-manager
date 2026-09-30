import { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebglAddon } from '@xterm/addon-webgl';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { WebLinksAddon } from '@xterm/addon-web-links';
import '@xterm/xterm/css/xterm.css';

interface Props {
  sessionId: string;
  /** For the `work tree … --host` hint when its Claude runs elsewhere. */
  target?: string;
  branch?: string;
  /** False while kept alive but not shown (the terminal deck): it stays
   *  connected, but never resizes the shared PTY — the last resize wins for
   *  every client, your real terminal included. Refits and takes focus when
   *  shown again. Default true. */
  active?: boolean;
}

/** Open a link from the terminal: web addresses only, in a new tab (the
 *  desktop app hands those to the default browser). */
export function openLink(uri: string): void {
  if (!/^https?:\/\//i.test(uri)) return;
  window.open(uri, '_blank', 'noopener');
}

/** The server said the session's Claude runs in another terminal. */
interface Elsewhere {
  lastActivity: number | null;
  state: string | null;
  /** A Claude process is known to be running (not a guess from activity). */
  confirmed: boolean;
}

/** While its Claude runs elsewhere, the tab looks again this often. */
export const ELSEWHERE_RECHECK_MS = 6000;

const ago = (ms: number | null) => {
  if (ms === null) return null;
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  return s < 60 ? `${s} s ago` : s < 3600 ? `${Math.round(s / 60)} min ago` : `${Math.round(s / 3600)} h ago`;
};

/**
 * xterm.js client for a session's Claude PTY. Opens a WebSocket to
 * /ws/sessions/<id>/terminal, replays scrollback, and bridges input/output.
 *
 * Lifecycle: mounts xterm + FitAddon, opens WS, attaches keyboard input.
 * On unmount: closes WS and disposes xterm. The server-side PTY survives.
 */
export function PtyView({ sessionId, target, branch, active = true }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const activeRef = useRef(active);
  activeRef.current = active;
  // Set by the connect effect: refit + resize-if-changed, and focus.
  const shown = useRef<(() => void) | null>(null);
  useEffect(() => {
    if (active) shown.current?.();
  }, [active]);
  // Until the first screen arrives: "Connecting…", then — when it takes a
  // while, i.e. Claude is being started — say so instead of a blank pane.
  const [phase, setPhase] = useState<'connecting' | 'starting' | 'ready'>('connecting');
  // Bumped to tear down and re-run the connect effect (restart after exit).
  const [generation, setGeneration] = useState(0);
  // Its Claude runs in a plain terminal: nothing spawned, explain instead.
  const [elsewhere, setElsewhere] = useState<Elsewhere | null>(null);
  // "Start it here" (only offered when nothing is known to run): reconnect
  // with ?force=1 once.
  const force = useRef(false);
  const [checking, setChecking] = useState(false);
  useEffect(() => {
    setElsewhere(null);
    force.current = false;
  }, [sessionId]);

  useEffect(() => {
    if (!hostRef.current) return;
    const term = new Terminal({
      cursorBlink: true,
      fontSize: 13,
      // Cascadia is Windows Terminal's default — same glyphs, same widths.
      fontFamily:
        '"Cascadia Code", "Cascadia Mono", SFMono-Regular, Consolas, "Liberation Mono", monospace',
      theme: { background: '#1e1e1e', foreground: '#d4d4d4' },
      convertEol: false,
      scrollback: 5000,
      // Required by the unicode11 addon (proposed API in xterm 6).
      allowProposedApi: true,
      // Links Claude prints as terminal hyperlinks (OSC 8). xterm's default
      // asks "could be dangerous?" and then opens a BLANK window it navigates
      // afterwards — the desktop app only sees about:blank and opens nothing.
      // Open the real address instead, web links only; hovering shows where
      // it goes (the text of such a link can differ from its target).
      linkHandler: {
        activate: (_e, uri) => openLink(uri),
        hover: (_e, uri) => {
          if (hostRef.current) hostRef.current.title = uri;
        },
        leave: () => {
          if (hostRef.current) hostRef.current.title = '';
        },
      },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    // Claude's UI is full of emoji / box-drawing / spinner glyphs; xterm's
    // default Unicode 6 width table mis-measures many of them, shifting
    // the rest of the line. Unicode 11 widths match real terminals.
    const unicode = new Unicode11Addon();
    term.loadAddon(unicode);
    term.unicode.activeVersion = '11';
    term.loadAddon(
      new WebLinksAddon((_e, uri) => openLink(uri)),
    );
    term.open(hostRef.current);
    // GPU renderer: the DOM renderer is what makes a busy Claude feel
    // sluggish (every spinner frame re-lays out spans). Must load after
    // open(). Falls back to DOM if WebGL is unavailable or the context is
    // lost (GPU reset, too many contexts).
    try {
      const webgl = new WebglAddon();
      webgl.onContextLoss(() => webgl.dispose());
      term.loadAddon(webgl);
    } catch { /* DOM renderer fallback */ }
    fit.fit();
    // Take the keyboard: you land here to answer Claude (Inbox "needs your
    // input", `n`, a notification click). Without focus your answer went to
    // the dashboard, whose j/k/n navigated away. Typing before the replay
    // arrives is queued below, so this is safe immediately.
    if (activeRef.current) term.focus();

    // Keys a real terminal handles that xterm-in-a-browser doesn't:
    //  - Shift+Enter → newline in Claude's prompt (ESC CR, what Claude
    //    Code's /terminal-setup binds) instead of submitting.
    //  - Ctrl+C with a selection → copy, like Windows Terminal; without a
    //    selection it stays an interrupt.
    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== 'keydown') return true;
      if (e.key === 'Enter' && e.shiftKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        sendInput('\x1b\r');
        return false;
      }
      if (e.key === 'c' && e.ctrlKey && !e.shiftKey && term.hasSelection()) {
        void navigator.clipboard?.writeText(term.getSelection());
        term.clearSelection();
        return false;
      }
      // Paste: xterm turns Ctrl+V into ^V and swallows the key, so the browser
      // never pasted. Leave these to the browser; its paste event reaches
      // xterm, which sends the text (bracketed when Claude asked for it).
      if ((e.ctrlKey && !e.altKey && e.key.toLowerCase() === 'v') || (e.shiftKey && e.key === 'Insert')) return false;
      return true;
    });
    // A clipboard with no text — an image — still sends ^V: that is how Claude
    // Code reads an image from the clipboard itself, as in a real terminal.
    const onPaste = (ev: ClipboardEvent) => {
      if (ev.clipboardData?.getData('text/plain')) return;
      ev.preventDefault();
      ev.stopImmediatePropagation();
      sendInput('\x16');
    };
    term.textarea?.addEventListener('paste', onPaste, true);

    const wsUrl = (() => {
      const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      return `${proto}//${window.location.host}/ws/sessions/${encodeURIComponent(sessionId)}/terminal${force.current ? '?force=1' : ''}`;
    })();
    const ws = new WebSocket(wsUrl);
    ws.binaryType = 'arraybuffer';
    setPhase('connecting');
    const slowStart = setTimeout(() => setPhase((p) => (p === 'connecting' ? 'starting' : p)), 700);

    let ready = false;
    const pendingInput: string[] = [];

    // Nothing is sent until the host's replay frame (always first) has been
    // drawn: input typed meanwhile is queued, and our size is sent only
    // after the snapshot is on screen, so Claude redraws for our grid.
    const finishReplay = () => {
      clearTimeout(slowStart);
      setPhase('ready');
      setElsewhere(null);
      setChecking(false);
      fit.fit();
      // After a reconnect the terminal is rebuilt: take focus back unless
      // the user has put it somewhere else meanwhile.
      if (activeRef.current && (!document.activeElement || document.activeElement === document.body)) term.focus();
      ready = true;
      sentCols = term.cols;
      sentRows = term.rows;
      ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
      for (const data of pendingInput) {
        ws.send(JSON.stringify({ type: 'input', data }));
      }
      pendingInput.length = 0;
    };

    // Binary frames = PTY output; text frames = control JSON.
    let exited = false;
    ws.addEventListener('message', (e) => {
      if (e.data instanceof ArrayBuffer) {
        term.write(new Uint8Array(e.data));
        return;
      }
      if (typeof e.data !== 'string') return;
      let msg: {
        type?: string;
        code?: number;
        message?: string;
        data?: string;
        cols?: number;
        rows?: number;
        lastActivity?: number | null;
        state?: string | null;
      };
      try {
        msg = JSON.parse(e.data);
      } catch {
        return;
      }
      if (msg.type === 'replay') {
        // Draw at the grid the snapshot was serialized for, then fit.
        if (msg.cols && msg.rows) term.resize(msg.cols, msg.rows);
        if (msg.data) term.write(msg.data, finishReplay);
        else finishReplay();
      } else if (msg.type === 'exit') {
        exited = true;
        term.write(
          `\r\n\x1b[33m[session exited${msg.code ? ` with code ${msg.code}` : ''} — press Enter to start it again]\x1b[0m\r\n`,
        );
      } else if (msg.type === 'error') {
        term.write(`\r\n\x1b[31m[${msg.message ?? 'error'}]\x1b[0m\r\n`);
      } else if (msg.type === 'elsewhere') {
        exited = true; // the server closes; no reconnect prompt
        setChecking(false);
        setElsewhere({
          lastActivity: typeof msg.lastActivity === 'number' ? msg.lastActivity : null,
          state: typeof msg.state === 'string' ? msg.state : null,
          confirmed: (msg as { confirmed?: unknown }).confirmed === true,
        });
      }
    });

    ws.addEventListener('close', () => {
      if (!exited) {
        term.write('\r\n\x1b[33m[connection closed — press Enter to reconnect]\x1b[0m\r\n');
      }
      exited = true;
    });

    const inputSub = term.onData((data) => {
      if (exited) {
        // The PTY is gone (Claude exited, or the host restarted): Enter
        // re-runs this effect, which reconnects and — server side —
        // respawns Claude.
        if (data === '\r') setGeneration((g) => g + 1);
        return;
      }
      sendInput(data);
    });
    // Hoisted: the custom key handler above calls it before this line runs
    // in source order, but only ever after the WebSocket exists.
    function sendInput(data: string): void {
      if (exited) return;
      if (ready) ws.send(JSON.stringify({ type: 'input', data }));
      else pendingInput.push(data);
    }

    // A drag fires the observer every frame; only tell the server when the
    // grid actually changes.
    let sentCols = term.cols;
    let sentRows = term.rows;
    // `force`: send even if OUR size didn't change — another window on this
    // session (your terminal tab, attached by `work tree`) may have resized
    // the PTY since, and the last resize wins: Claude then wrapped its input
    // at that window's width and text ran off the edge here.
    const onResize = (force = false) => {
      // Hidden in the deck: keep the grid as it was, send nothing.
      if (!activeRef.current) return;
      fit.fit();
      if (!force && term.cols === sentCols && term.rows === sentRows) return;
      sentCols = term.cols;
      sentRows = term.rows;
      if (ready) {
        ws.send(
          JSON.stringify({
            type: 'resize',
            cols: term.cols,
            rows: term.rows,
          }),
        );
      }
    };
    const onWindowResize = () => onResize();
    // Observe the host, not just the window: dragging the dashboard's rail
    // divider resizes the pane without any window resize event.
    const observer =
      typeof ResizeObserver !== 'undefined'
        ? new ResizeObserver(() => onResize())
        : null;
    if (observer) observer.observe(hostRef.current);
    else window.addEventListener('resize', onWindowResize);
    shown.current = () => {
      onResize(true);
      term.focus();
    };
    // The terminal you type in sets the size.
    const onFocus = () => onResize(true);
    term.textarea?.addEventListener('focus', onFocus);

    return () => {
      clearTimeout(slowStart);
      term.textarea?.removeEventListener('paste', onPaste, true);
      term.textarea?.removeEventListener('focus', onFocus);
      shown.current = null;
      observer?.disconnect();
      window.removeEventListener('resize', onWindowResize);
      inputSub.dispose();
      try { ws.close(); } catch { /* */ }
      term.dispose();
    };
  }, [sessionId, generation]);

  // Look again (the panel stays up meanwhile): attaches as soon as the other
  // Claude is gone — by itself every few seconds, or on "Check again".
  const checkAgain = () => {
    setChecking(true);
    setGeneration((g) => g + 1);
  };
  useEffect(() => {
    if (!elsewhere || !active) return;
    const t = setInterval(() => {
      if (document.visibilityState === 'visible') checkAgain();
    }, ELSEWHERE_RECHECK_MS);
    return () => clearInterval(t);
  }, [elsewhere, active]);
  const startHere = () => {
    const ok = window.confirm(
      "Start this session's Claude here?\n\nIf it is still open in another terminal, both would write to the same conversation.",
    );
    if (!ok) return;
    force.current = true;
    setElsewhere(null);
    setGeneration((g) => g + 1);
  };
  const hostHint = target ? `work tree ${target}${branch ? ` ${branch}` : ''}` : 'work tree <target> <branch>';
  return (
    <>
      {elsewhere && (
        <div className="wd-pty-elsewhere" role="status">
          <p className="wd-pty-elsewhere-title">
            {elsewhere.confirmed ? 'This session’s Claude is open in another terminal' : 'This session’s Claude seems to be running in another terminal'}
            {elsewhere.lastActivity !== null && <> (last wrote {ago(elsewhere.lastActivity)})</>}
            {elsewhere.state === 'needs_input' && <>, waiting for your answer there</>}.
          </p>
          <p>
            Close it there (type <code>/exit</code>) and this tab attaches by itself — it checks every few seconds. To
            have both show the same screen instead, restart it with <code>{hostHint}</code> (Ctrl+] detaches, Claude keeps
            running).
          </p>
          <p className="wd-pty-elsewhere-actions">
            <button type="button" className="wd-btn-secondary" onClick={checkAgain} disabled={checking}>
              {checking ? 'Checking…' : 'Check again'}
            </button>
            {!elsewhere.confirmed && (
              // Only a guess from recent activity: it may have been closed.
              <button type="button" className="wd-link-button" onClick={startHere}>
                It&apos;s not running — start it here…
              </button>
            )}
          </p>
        </div>
      )}
      <div className="wd-pty-frame" style={elsewhere ? { display: 'none' } : undefined}>
        <div ref={hostRef} className="wd-pty-host" />
        {phase !== 'ready' && !elsewhere && (
          <div className="wd-pty-connecting" role="status">
            {phase === 'starting' ? 'Starting Claude — resuming the conversation…' : 'Connecting…'}
          </div>
        )}
      </div>
    </>
  );
}
