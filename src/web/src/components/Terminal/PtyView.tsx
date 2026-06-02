import { useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
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

  useEffect(() => {
    if (!hostRef.current) return;
    const term = new Terminal({
      cursorBlink: true,
      fontSize: 13,
      fontFamily:
        'SFMono-Regular, Consolas, "Liberation Mono", "DejaVu Sans Mono", monospace',
      theme: { background: '#1e1e1e', foreground: '#d4d4d4' },
      convertEol: false,
      scrollback: 5000,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(hostRef.current);
    fit.fit();

    const wsUrl = (() => {
      const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      return `${proto}//${window.location.host}/ws/sessions/${encodeURIComponent(sessionId)}/terminal`;
    })();
    const ws = new WebSocket(wsUrl);
    ws.binaryType = 'arraybuffer';

    let ready = false;
    const pendingInput: string[] = [];

    ws.addEventListener('open', () => {
      ready = true;
      // Tell the server our initial size so the PTY isn't stuck at the
      // default 120x32 if the panel is narrower/wider.
      ws.send(
        JSON.stringify({
          type: 'resize',
          cols: term.cols,
          rows: term.rows,
        }),
      );
      for (const data of pendingInput) {
        ws.send(JSON.stringify({ type: 'input', data }));
      }
      pendingInput.length = 0;
    });

    ws.addEventListener('message', (e) => {
      if (typeof e.data === 'string') {
        term.write(e.data);
      } else if (e.data instanceof ArrayBuffer) {
        term.write(new Uint8Array(e.data));
      }
    });

    ws.addEventListener('close', () => {
      term.write('\r\n\x1b[33m[connection closed]\x1b[0m\r\n');
    });

    const inputSub = term.onData((data) => {
      if (ready) ws.send(JSON.stringify({ type: 'input', data }));
      else pendingInput.push(data);
    });

    const onResize = () => {
      fit.fit();
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
    window.addEventListener('resize', onResize);

    return () => {
      window.removeEventListener('resize', onResize);
      inputSub.dispose();
      try { ws.close(); } catch { /* */ }
      term.dispose();
    };
  }, [sessionId]);

  return <div ref={hostRef} className="wd-pty-host" />;
}
