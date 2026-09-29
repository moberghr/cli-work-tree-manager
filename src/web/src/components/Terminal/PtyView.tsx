import { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebglAddon } from '@xterm/addon-webgl';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { WebLinksAddon } from '@xterm/addon-web-links';
import '@xterm/xterm/css/xterm.css';

interface Props {
  sessionId: string;
}

/**
 * xterm.js client for a session's Claude PTY. Opens a WebSocket to
 * /ws/sessions/<id>/terminal, replays scrollback, and bridges input/output.
 *
 * Lifecycle: mounts xterm + FitAddon, opens WS, attaches keyboard input.
 * On unmount: closes WS and disposes xterm. The server-side PTY survives.
 */
export function PtyView({ sessionId }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  // Bumped to tear down and re-run the connect effect (restart after exit).
  const [generation, setGeneration] = useState(0);

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
      new WebLinksAddon((_e, uri) => window.open(uri, '_blank', 'noopener')),
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
    term.focus();

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
      return true;
    });

    const wsUrl = (() => {
      const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      return `${proto}//${window.location.host}/ws/sessions/${encodeURIComponent(sessionId)}/terminal`;
    })();
    const ws = new WebSocket(wsUrl);
    ws.binaryType = 'arraybuffer';

    let ready = false;
    const pendingInput: string[] = [];

    // Nothing is sent until the host's replay frame (always first) has been
    // drawn: input typed meanwhile is queued, and our size is sent only
    // after the snapshot is on screen, so Claude redraws for our grid.
    const finishReplay = () => {
      fit.fit();
      // After a reconnect the terminal is rebuilt: take focus back unless
      // the user has put it somewhere else meanwhile.
      if (!document.activeElement || document.activeElement === document.body) term.focus();
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
    const onResize = () => {
      fit.fit();
      if (term.cols === sentCols && term.rows === sentRows) return;
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
    // Observe the host, not just the window: dragging the dashboard's rail
    // divider resizes the pane without any window resize event.
    const observer =
      typeof ResizeObserver !== 'undefined'
        ? new ResizeObserver(() => onResize())
        : null;
    if (observer) observer.observe(hostRef.current);
    else window.addEventListener('resize', onResize);

    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', onResize);
      inputSub.dispose();
      try { ws.close(); } catch { /* */ }
      term.dispose();
    };
  }, [sessionId, generation]);

  return <div ref={hostRef} className="wd-pty-host" />;
}
