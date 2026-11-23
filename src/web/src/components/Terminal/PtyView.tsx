import { useEffect, useRef, useState } from 'react';
import { cornerBadge, LatencyMeter, type LatencyReading } from '../../state/keystroke-latency.js';
import { observeLongFrames, TerminalPerfLog } from '../../state/terminal-perf.js';
import { openTerminalSocket } from '../../api/terminal-socket.js';
import { sendTerminalPerf } from '../../api/client.js';
import { onTerminalReconnect } from '../../state/terminal-reconnect.js';
import { startFailure, startRetryDelay } from '../../state/terminal-start.js';
import { ask } from '../../state/ask.js';
import { AckCounter, ackFrame, utf16Length } from '../../../../core/pty/flow-control.js';
import { isWindowsPty, validGrid, type Grid } from '../../../../core/pty/terminal-size.js';
import { FitScheduler } from '../../state/fit-scheduler.js';
import { createXtermEngine } from './engine/xterm-engine.js';
import {
  engineChoice,
  loadGhosttyEngine,
  readEngineSetting,
  type EngineOptions,
  type RendererLabel,
  type TerminalEngine,
} from './engine/terminal-engine.js';

export { openLink } from './engine/xterm-engine.js';

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

/** The server said the session's Claude runs in another terminal. */
interface Elsewhere {
  lastActivity: number | null;
  state: string | null;
  /** A Claude process is known to be running (not a guess from activity). */
  confirmed: boolean;
}

/** While its Claude runs elsewhere, the tab looks again this often. */
export const ELSEWHERE_RECHECK_MS = 6000;

/** How often the Terminal tab sends what it measured to the debug log (and once more when it closes). */
const PERF_SEND_MS = 10_000;

/**
 * The most one `term.write` is given: xterm parses a write whole before it looks at the clock (its 12 ms slices are
 * between writes), so a big frame or screen in one piece is one long freeze. 64 KiB parses in a few ms.
 */
export const WRITE_PIECE = 64 * 1024;

/** `write` called on `data` in pieces of at most WRITE_PIECE, `last` true for the final one; never called for empty `data`. */
function inPieces<T extends string | Uint8Array>(data: T, write: (piece: T, last: boolean) => void): void {
  for (let at = 0; at < data.length; at += WRITE_PIECE) write(data.slice(at, at + WRITE_PIECE) as T, at + WRITE_PIECE >= data.length);
}

const ago = (ms: number | null) => {
  if (ms === null) return null;
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  return s < 60 ? `${s} s ago` : s < 3600 ? `${Math.round(s / 60)} min ago` : `${Math.round(s / 3600)} h ago`;
};

/**
 * The Terminal tab's client for a session's Claude PTY. Opens a WebSocket to
 * /ws/sessions/<id>/terminal, replays scrollback, and bridges input/output.
 *
 * Lifecycle: mounts the terminal engine (xterm.js, or libghostty-vt when picked: engine/terminal-engine.ts), opens
 * WS, attaches keyboard input. On unmount: closes WS and disposes the engine. The server-side PTY survives.
 */
export function PtyView({ sessionId, target, branch, active = true }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const activeRef = useRef(active);
  activeRef.current = active;
  // Set by the connect effect: refit + resize-if-changed, and focus; hidden, its WebGL context goes after a while.
  const shown = useRef<(() => void) | null>(null);
  const hidden = useRef<(() => void) | null>(null);
  useEffect(() => {
    if (active) shown.current?.();
    else hidden.current?.();
  }, [active]);
  // Until the first screen arrives: "Connecting…", then — when it takes a
  // while, i.e. Claude is being started — say so instead of a blank pane.
  const [phase, setPhase] = useState<'connecting' | 'starting' | 'ready'>('connecting');
  // Bumped to tear down and re-run the connect effect (restart after exit).
  const [generation, setGeneration] = useState(0);
  // A start that failed before the first screen (the host didn't answer, or was replaced meanwhile):
  // why, and when it tries again by itself (null: it has stopped trying — a click starts it again).
  const [failed, setFailed] = useState<{ reason: string; retryAt: number | null } | null>(null);
  // How many tries again in a row; back to 0 once a screen arrives.
  const retries = useRef(0);
  // Its Claude runs in a plain terminal: nothing spawned, explain instead.
  const [elsewhere, setElsewhere] = useState<Elsewhere | null>(null);
  // "Start it here" (only offered when nothing is known to run): reconnect
  // with ?force=1 once.
  const force = useRef(false);
  // How long a keystroke takes to come back (median), once measured.
  const [latency, setLatency] = useState<LatencyReading | null>(null);
  // Straight to the PTY host, or through work web's relay (terminal-socket.ts): said in the corner's tooltip.
  const [route, setRoute] = useState<'direct' | 'relay' | null>(null);
  // Which renderer draws it: shown in the corner when it's the slow one.
  // 'retrying': on DOM after a lost context, WebGL to be tried again; 'dom': for good.
  // 'ghostty': libghostty-vt's canvas (engine/ghostty-engine.ts).
  const [renderer, setRenderer] = useState<RendererLabel>('webgl');
  // Why the libghostty-vt engine, picked, couldn't be loaded (xterm.js draws instead): said in the corner.
  const [engineFailure, setEngineFailure] = useState<string | null>(null);
  // The same two for the debug log's reports, read from inside the connect effect.
  const routeRef = useRef(route);
  routeRef.current = route;
  const rendererRef = useRef(renderer);
  rendererRef.current = renderer;
  const [checking, setChecking] = useState(false);
  useEffect(() => {
    setElsewhere(null);
    force.current = false;
  }, [sessionId]);
  // ⋯ → Reconnect terminal (⇧R): a new connection, whatever state this one is in — one gone
  // stale without saying so shows a screen that takes no input. It also asks the agent to draw its screen again once
  // the new connection's screen is drawn (`redraw`): it is what you reach for when the screen looks wrong. Only then —
  // a repaint flashes, and an agent drawing inline can repeat its transcript in the scrollback.
  const redrawNext = useRef(false);
  useEffect(
    () =>
      onTerminalReconnect(sessionId, () => {
        redrawNext.current = true;
        setGeneration((g) => g + 1);
      }),
    [sessionId],
  );

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    // Set once the connection's fit scheduler exists: what the engine asks for when a cell's measure changed.
    let refit = () => {};
    const options: EngineOptions = { host, active: activeRef.current, label: setRenderer, refit: () => refit() };
    const connect = (term: TerminalEngine): (() => void) => {
      let disposed = false;
      // A drag fires the pane's observer every frame: fitted at most every FIT_MIN_MS, the last size always, each in a
      // task of its own (fit-scheduler.ts). The fit is applyGrid, below.
      const fits = new FitScheduler(() => applyGrid());
      refit = () => fits.request();
      // The grid this pane holds, or null when it can't be told: no size (not laid out, 0 × 0), or one the PTY host
      // wouldn't take (terminal-size.ts; FitAddon proposes 2 × 1 for an empty pane). Measured here; applied by applyGrid.
      const measure = (): Grid | null => {
        if (host.clientWidth <= 0 || host.clientHeight <= 0) return null;
        const dims = term.proposeDimensions();
        return dims ? validGrid(dims.cols, dims.rows) : null;
      };
      // The grid it attaches at: stated on its address when it takes the PTY's size (shown), so the host sends its first
      // screen at this grid, and starts an agent at it (terminal-size.ts). Hidden in the deck it states none.
      const attachGrid = activeRef.current ? measure() : null;
      if (attachGrid) term.resize(attachGrid.cols, attachGrid.rows);
      // This connection is a ⋯ → Reconnect terminal's: the agent is asked to repaint once its screen is drawn.
      const askRedraw = redrawNext.current;
      redrawNext.current = false;
      // Take the keyboard: you land here to answer Claude (Inbox "needs your
      // input", `n`, a notification click). Without focus your answer went to
      // the dashboard, whose j/k/n navigated away. Typing before the replay
      // arrives is queued below, so this is safe immediately.
      if (activeRef.current) term.focus();

      // A clipboard with no text — an image — still sends ^V: that is how Claude
      // Code reads an image from the clipboard itself, as in a real terminal.
      const onPaste = (ev: ClipboardEvent) => {
        if (ev.clipboardData?.getData('text/plain')) return;
        ev.preventDefault();
        ev.stopImmediatePropagation();
        sendInput('\x16');
      };
      const textarea = term.textarea;
      textarea?.addEventListener('paste', onPaste, true);

      const wsUrl = (() => {
        const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        return `${proto}//${window.location.host}/ws/sessions/${encodeURIComponent(sessionId)}/terminal${force.current ? '?force=1' : ''}`;
      })();
      // Straight to the PTY host with a ticket when it can, else the relay at wsUrl (terminal-socket.ts). It acks what
      // it draws (flow: the host paces it, core/pty/flow-control.ts).
      const ws = openTerminalSocket(sessionId, { force: force.current, relayUrl: wsUrl, flow: true, grid: attachGrid });
      ws.binaryType = 'arraybuffer';
      setPhase('connecting');
      setFailed(null);
      const slowStart = setTimeout(() => setPhase((p) => (p === 'connecting' ? 'starting' : p)), 700);
      // The server's reason when a start fails (said before it closes), and the timer of the try again.
      let failReason: string | null = null;
      let retryTimer: ReturnType<typeof setTimeout> | undefined;

      let ready = false;
      const pendingInput: string[] = [];

      // Nothing is sent until the host's replay frame (always first) has been
      // drawn: input typed meanwhile is queued, and our size is sent only
      // after the snapshot is on screen. A current host sent it at the grid stated on the attach address already, so
      // this resize changes nothing; an older one ignored that, and this is what gives Claude our grid, as before.
      const finishReplay = () => {
        clearTimeout(slowStart);
        setPhase('ready');
        setRoute(ws.route);
        setFailed(null);
        retries.current = 0;
        setElsewhere(null);
        setChecking(false);
        // After a reconnect the terminal is rebuilt: take focus back unless
        // the user has put it somewhere else meanwhile.
        if (activeRef.current && (!document.activeElement || document.activeElement === document.body)) term.focus();
        ready = true;
        // The PTY's grid: the screen's. Shown, the pane's grid is taken with it now, and sent even when the same. Hidden in
        // the deck (a try again while hidden), nothing: it keeps the screen's grid until it is shown.
        sentCols = term.cols;
        sentRows = term.rows;
        applyGrid(true);
        if (askRedraw && activeRef.current) ws.send(JSON.stringify({ type: 'redraw' }));
        for (const data of pendingInput) {
          ws.send(JSON.stringify({ type: 'input', data }));
        }
        pendingInput.length = 0;
      };

      // Binary frames = PTY output; text frames = control JSON.
      let exited = false;
      // Each piece of output acked once xterm has parsed it, every few thousand characters (an older host ignores them).
      const acks = new AckCounter((chars) => {
        if (!exited) ws.send(ackFrame(chars));
      });
      const writeOutput = (bytes: Uint8Array) =>
        inPieces(bytes, (piece) => {
          const chars = utf16Length(piece);
          term.writeOutput(piece, () => acks.drawn(chars));
        });
      // A screen: in pieces, `done` once the last is drawn. Never acked (the host doesn't count it).
      const writeScreen = (text: string, done: () => void) => inPieces(text, (piece, last) => term.write(piece, last ? done : undefined));
      // A screen sent mid-session (this tab fell behind and caught up: the host's output-pacer.ts) is only drawn: over
      // a reset terminal (RIS, in order with what was written before it; it clears the scrollback too), at its grid — the
      // PTY's — and left there: fitted here alone, the agent's frame, drawn for another client's grid, would be reflowed
      // into garbage. Only if this pane's own grid changed since it last told the PTY are both changed (applyGrid). None
      // of the first screen's work: no focus taken, no size sent (it would take the PTY's size from the terminal in use),
      // nothing held to send.
      const drawCatchUp = (msg: { data?: string; cols?: number; rows?: number }) => {
        if (msg.cols && msg.rows) term.resize(msg.cols, msg.rows);
        writeScreen('\x1bc' + (msg.data ?? ''), () => fits.request());
      };
      const meter = new LatencyMeter();
      let shownAt = 0;
      // What the corner shows: at most every half second, whatever moved it.
      // Within the half second: shown once it's up, so the last reading (a redraw settling just after its echo) isn't lost.
      let showLater: ReturnType<typeof setTimeout> | undefined;
      const showLatency = () => {
        const now = performance.now();
        if (now - shownAt > 500) {
          shownAt = now;
          setLatency(meter.reading());
        } else if (!showLater)
          showLater = setTimeout(
            () => {
              showLater = undefined;
              shownAt = performance.now();
              setLatency(meter.reading());
            },
            500 - (now - shownAt),
          );
      };
      // When a key's echo was on screen: the first frame drawn after it.
      // Each key and each freeze of this window (while this terminal is the one shown) go to the debug log.
      const perf = new TerminalPerfLog();
      const renderSub = term.onRender(() => {
        const sample = meter.rendered(performance.now());
        if (!sample) return;
        perf.key(sample);
        showLatency();
      });
      const stopFrames = observeLongFrames((e) => {
        if (activeRef.current) perf.stall(e, Math.round(performance.timeOrigin + e.startTime));
      });
      const sendPerf = () => {
        const report = perf.take({ sessionId, route: routeRef.current, renderer: rendererRef.current });
        if (report) sendTerminalPerf(report);
      };
      const perfTimer = setInterval(sendPerf, PERF_SEND_MS);
      ws.addEventListener('message', (e) => {
        if (e.data instanceof ArrayBuffer) {
          writeOutput(new Uint8Array(e.data));
          // The echo of a key sent (keystroke-latency.ts): as it arrives; shown at most every half second.
          if (meter.output(performance.now()) !== null) showLatency();
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
          windowsPty?: unknown;
          lastActivity?: number | null;
          state?: string | null;
        };
        try {
          msg = JSON.parse(e.data);
        } catch {
          return;
        }
        if (msg.type === 'replay') {
          // The host's PTYs are ConPTY's, which reflows lines itself on a resize: the terminal must not reflow them again
          // (VS Code sets the same; terminal-size.ts). Said by a host on Windows only.
          if (isWindowsPty(msg.windowsPty)) term.setWindowsPty(msg.windowsPty);
          if (ready) return drawCatchUp(msg);
          // Draw at the grid the snapshot was serialized for, then fit.
          if (msg.cols && msg.rows) term.resize(msg.cols, msg.rows);
          if (msg.data) writeScreen(msg.data, finishReplay);
          else finishReplay();
        } else if (msg.type === 'exit') {
          exited = true;
          term.write(`\r\n\x1b[33m[session exited${msg.code ? ` with code ${msg.code}` : ''} — press Enter to start it again]\x1b[0m\r\n`);
        } else if (msg.type === 'error') {
          failReason = msg.message ?? null;
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
        if (!ready && !exited && !disposed) {
          // It never started: say why over the pane (the "Starting…" cover would hide it for good) and try again
          // by itself — a PTY host that was busy or replaced is usually back within seconds.
          clearTimeout(slowStart);
          const delay = startRetryDelay(retries.current);
          setFailed({ reason: startFailure(failReason), retryAt: delay === null ? null : Date.now() + delay });
          if (delay !== null)
            retryTimer = setTimeout(() => {
              retries.current += 1;
              setGeneration((g) => g + 1);
            }, delay);
        } else if (!exited) {
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
        if (ready) {
          ws.send(JSON.stringify({ type: 'input', data }));
          perf.key(meter.keySent(performance.now()));
        } else pendingInput.push(data);
      }

      // The grid the PTY was last told (by this tab): only a change from it is sent.
      let sentCols = term.cols;
      let sentRows = term.rows;
      // This tab's grid and the PTY's change TOGETHER: the pane measured, the terminal resized and the PTY told in one go.
      // Never the local grid alone, or the agent's last frame, drawn for the PTY's grid, is reflowed here into garbage.
      // Only while shown (hidden in the deck it keeps its grid and sends nothing: the PTY's size is the terminal in use's)
      // and once the first screen is drawn (until then the grid is stated on the attach address). A pane with no size
      // changes nothing. `force`: send even if OUR size didn't change — another window on this session (your terminal
      // tab, attached by `work tree`) may have resized the PTY since, and the last resize wins: Claude then wrapped its
      // input at that window's width and text ran off the edge here.
      const applyGrid = (force = false) => {
        if (!activeRef.current || !ready) return;
        const grid = measure();
        if (!grid) return;
        if (!force && grid.cols === sentCols && grid.rows === sentRows) return;
        // The local grid changed: the view kept where it was (scrolled up, on its line; at the bottom, at the bottom).
        if (grid.cols !== term.cols || grid.rows !== term.rows) term.resizeKeepingView(grid.cols, grid.rows);
        sentCols = grid.cols;
        sentRows = grid.rows;
        ws.send(JSON.stringify({ type: 'resize', cols: grid.cols, rows: grid.rows }));
      };
      const onWindowResize = () => fits.request();
      // Observe the host, not just the window: dragging the dashboard's rail
      // divider resizes the pane without any window resize event.
      const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => fits.request()) : null;
      if (observer) observer.observe(host);
      else window.addEventListener('resize', onWindowResize);
      shown.current = () => {
        // The renderer back before the fit (xterm.js's WebGL), so the grid is measured with the renderer that draws it.
        term.shown();
        applyGrid(true);
        term.focus();
      };
      hidden.current = () => term.hidden();
      // The terminal you type in sets the size.
      const onFocus = () => applyGrid(true);
      textarea?.addEventListener('focus', onFocus);

      return () => {
        disposed = true;
        clearTimeout(slowStart);
        clearTimeout(retryTimer);
        textarea?.removeEventListener('paste', onPaste, true);
        textarea?.removeEventListener('focus', onFocus);
        shown.current = null;
        hidden.current = null;
        fits.dispose();
        observer?.disconnect();
        window.removeEventListener('resize', onWindowResize);
        inputSub.dispose();
        renderSub.dispose();
        clearInterval(perfTimer);
        stopFrames();
        sendPerf();
        clearTimeout(showLater);
        try {
          ws.close();
        } catch {
          /* */
        }
        term.dispose();
      };
    };

    // The engine that draws it: xterm.js, made here and now; libghostty-vt when picked (?terminalEngine=, or the
    // terminalEngine setting), loaded first — and xterm.js after all if it can't be, said in the corner.
    void readEngineSetting();
    let stop: (() => void) | undefined;
    let gone = false;
    if (engineChoice() === 'ghostty') {
      loadGhosttyEngine(options).then(
        (engine) => {
          if (gone) engine.dispose();
          else stop = connect(engine);
        },
        (err: unknown) => {
          if (gone) return;
          setEngineFailure(err instanceof Error ? err.message : String(err));
          stop = connect(createXtermEngine(options));
        },
      );
    } else stop = connect(createXtermEngine(options));
    return () => {
      gone = true;
      stop?.();
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
  const startHere = async () => {
    const ok = await ask(
      "Start this session's Claude here?\n\nIf it is still open in another terminal, both would write to the same conversation.",
      { ok: 'Start it here' },
    );
    if (!ok) return;
    force.current = true;
    setElsewhere(null);
    setGeneration((g) => g + 1);
  };
  const hostHint = target ? `work tree ${target}${branch ? ` ${branch}` : ''}` : 'work tree <target> <branch>';
  const badge = cornerBadge(latency, renderer, route, engineFailure);
  return (
    <>
      {elsewhere && (
        <div className="wd-pty-elsewhere" role="status">
          <p className="wd-pty-elsewhere-title">
            {elsewhere.confirmed
              ? 'This session’s Claude is open in another terminal'
              : 'This session’s Claude seems to be running in another terminal'}
            {elsewhere.lastActivity !== null && <> (last wrote {ago(elsewhere.lastActivity)})</>}
            {elsewhere.state === 'needs_input' && <>, waiting for your answer there</>}.
          </p>
          <p>
            Close it there (type <code>/exit</code>) and this tab attaches by itself — it checks every few seconds. To have both show the
            same screen instead, restart it with <code>{hostHint}</code> (Ctrl+] detaches, Claude keeps running).
          </p>
          <p className="wd-pty-elsewhere-actions">
            <button type="button" className="wd-btn-secondary" onClick={checkAgain} disabled={checking}>
              {checking ? 'Checking…' : 'Check again'}
            </button>
            {!elsewhere.confirmed && (
              // Only a guess from recent activity: it may have been closed.
              <button type="button" className="wd-link-button" onClick={() => void startHere()}>
                It&apos;s not running — start it here…
              </button>
            )}
          </p>
        </div>
      )}
      <div className="wd-pty-frame" style={elsewhere ? { display: 'none' } : undefined}>
        <div ref={hostRef} className="wd-pty-host" />
        {badge && (
          <span className={'wd-pty-latency' + (badge.slow ? ' wd-pty-latency-slow' : '')} title={badge.title}>
            {badge.text}
          </span>
        )}
        {phase !== 'ready' && !elsewhere && !failed && (
          <div className="wd-pty-connecting" role="status">
            {phase === 'starting' ? 'Starting Claude — resuming the conversation…' : 'Connecting…'}
          </div>
        )}
        {phase !== 'ready' && !elsewhere && failed && (
          <div className="wd-pty-connecting wd-pty-failed" role="alert">
            <p>Couldn&apos;t start Claude: {failed.reason}.</p>
            <p>
              {failed.retryAt !== null ? <RetryCountdown at={failed.retryAt} /> : 'Stopped trying on its own.'}{' '}
              <button
                type="button"
                className="wd-btn-secondary"
                onClick={() => {
                  retries.current = 0;
                  setFailed(null);
                  setGeneration((g) => g + 1);
                }}
              >
                {failed.retryAt !== null ? 'Try now' : 'Try again'}
              </button>
            </p>
          </div>
        )}
      </div>
    </>
  );
}

/** "Trying again in 8 s…", counting down. */
function RetryCountdown({ at }: { at: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  return <>Trying again in {Math.max(1, Math.ceil((at - now) / 1000))} s…</>;
}
