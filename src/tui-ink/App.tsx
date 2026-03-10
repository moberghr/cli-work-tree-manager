import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { Box } from 'ink';
import fs from 'node:fs';
import path from 'node:path';
import {
  loadHistory,
  getRecentSessions,
  removeSession,
  upsertSession,
  type WorktreeSession,
} from '../core/history.js';
import { PtySession } from '../tui/session.js';
import { HookServer, type HookEvent } from '../tui/hooks.js';
import { renderBufferLines } from './renderer-lines.js';
import { Sidebar, buildSidebarRows } from './Sidebar.js';
import { TerminalPane } from './TerminalPane.js';
import { StatusBar } from './StatusBar.js';

const DETACH_KEY = '\x1D'; // Ctrl+]
const TAB_KEY = '\t';
const RENDER_INTERVAL_MS = 16;

enum Focus {
  SIDEBAR,
  TERMINAL,
}

function sessionKey(s: WorktreeSession): string {
  return `${s.target}:${s.branch}`;
}

function loadSessions(): WorktreeSession[] {
  const all = loadHistory();
  return getRecentSessions(all, 50).filter((s) =>
    s.paths.some((p) => fs.existsSync(p)),
  );
}

interface AppProps {
  unsafe: boolean;
  onExit: () => void;
}

export function App({ unsafe, onExit }: AppProps) {
  const [focus, setFocus] = useState(Focus.SIDEBAR);
  const [sessions, setSessions] = useState<WorktreeSession[]>(loadSessions);
  const [cursor, setCursor] = useState(0);
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const [message, setMessage] = useState('');
  const [termLines, setTermLines] = useState<string[]>([]);
  const [statusVersion, setStatusVersion] = useState(0);

  const sidebarRows = useMemo(() => buildSidebarRows(sessions), [sessions]);

  const ptySessions = useRef(new Map<string, PtySession>());
  const renderPending = useRef(false);
  const focusRef = useRef(focus);
  const activeKeyRef = useRef(activeKey);
  const cursorRef = useRef(cursor);
  const sessionsRef = useRef(sessions);

  // Keep refs in sync
  focusRef.current = focus;
  activeKeyRef.current = activeKey;
  cursorRef.current = cursor;
  sessionsRef.current = sessions;

  // Layout — reactive to terminal resize
  const [dims, setDims] = useState(() => ({
    cols: process.stdout.columns || 80,
    rows: process.stdout.rows || 24,
  }));
  const cols = dims.cols;
  const rows = dims.rows;
  const sidebarWidth = Math.min(40, Math.floor(cols * 0.35));
  const termWidth = cols - sidebarWidth;
  const termInner = termWidth - 2;
  const contentHeight = rows - 1; // status bar

  // Update terminal title — icon + count per state, hide if 0
  useEffect(() => {
    let idleCount = 0;
    let runningCount = 0;
    for (const pty of ptySessions.current.values()) {
      if (pty.exited) continue;
      if (pty.idle) idleCount++;
      else runningCount++;
    }
    const parts: string[] = [];
    if (idleCount > 0) parts.push(`🟡 ${idleCount}`);
    if (runningCount > 0) parts.push(`🟢 ${runningCount}`);
    const title = parts.length > 0 ? parts.join('  ') : 'work2 dash';
    process.stdout.write(`\x1B]0;${title}\x07`);
  }, [statusVersion, activeKey]);

  const refreshSessions = useCallback(() => {
    const s = loadSessions();
    setSessions(s);
  }, []);

  const buildStatusMap = useCallback(() => {
    const map = new Map<string, 'stopped' | 'running' | 'idle'>();
    for (const [key, pty] of ptySessions.current) {
      if (pty.exited) continue;
      map.set(key, pty.idle ? 'idle' : 'running');
    }
    return map;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [statusVersion]);

  const scheduleTerminalRender = useCallback((pty: PtySession) => {
    if (renderPending.current) return;
    renderPending.current = true;
    setTimeout(() => {
      renderPending.current = false;
      try {
        const lines = renderBufferLines(pty.terminal.buffer.active, termInner, contentHeight - 2);
        setTermLines(lines);
      } catch { /* buffer not ready */ }
    }, RENDER_INTERVAL_MS);
  }, [termInner, contentHeight]);

  const findPtyByCwd = useCallback((cwd: string): PtySession | undefined => {
    const normalized = path.resolve(cwd).toLowerCase();
    for (const pty of ptySessions.current.values()) {
      if (path.resolve(pty.cwd).toLowerCase() === normalized) return pty;
    }
    return undefined;
  }, []);

  // Hook server
  useEffect(() => {
    const hookServer = new HookServer((cwd: string, event: HookEvent) => {
      const pty = findPtyByCwd(cwd);
      if (!pty) return;
      if (event === 'stop' || event === 'notification') {
        pty.setIdle(true);
      } else if (event === 'prompt_submit') {
        pty.setIdle(false);
      }
    });

    hookServer.start().catch(() => {});

    return () => {
      hookServer.stop().catch(() => {});
    };
  }, [findPtyByCwd]);

  /** Switch the right pane to show a different session's terminal. */
  const switchDisplay = useCallback((nextIdx: number) => {
    const s = sessionsRef.current[nextIdx];
    if (!s) return;
    const k = sessionKey(s);
    if (activeKeyRef.current === k) return;

    // Disconnect previous
    if (activeKeyRef.current) {
      ptySessions.current.get(activeKeyRef.current)?.setOutputHandler(undefined);
    }

    setActiveKey(k);

    // Connect new if running
    const pty = ptySessions.current.get(k);
    if (pty && !pty.exited) {
      pty.resize(termInner, contentHeight - 2);
      pty.setOutputHandler(() => scheduleTerminalRender(pty));
      try {
        setTermLines(renderBufferLines(pty.terminal.buffer.active, termInner, contentHeight - 2));
      } catch { /* */ }
    } else {
      setTermLines([]);
    }
  }, [termInner, contentHeight, scheduleTerminalRender]);

  /** Move cursor by delta and auto-switch display. */
  const moveCursor = useCallback((delta: number) => {
    const max = sessionsRef.current.length - 1;
    const next = Math.max(0, Math.min(max, cursorRef.current + delta));
    setCursor(next);
    switchDisplay(next);
  }, [switchDisplay]);

  const activateSession = useCallback((idx: number) => {
    const s = sessionsRef.current[idx];
    if (!s) return;
    const key = sessionKey(s);
    let pty = ptySessions.current.get(key);

    if (!pty || pty.exited) {
      const existing = s.paths.find((p) => fs.existsSync(p));
      if (!existing) {
        setMessage('Session path no longer exists');
        refreshSessions();
        return;
      }

      const dir = s.isGroup ? path.dirname(existing) : existing;
      pty = new PtySession(dir, termInner, contentHeight - 2, unsafe);
      ptySessions.current.set(key, pty);
      upsertSession(s.target, s.isGroup, s.branch, s.paths);

      pty.onExit = () => {
        ptySessions.current.delete(key);
        if (activeKeyRef.current === key) {
          setActiveKey(null);
          setFocus(Focus.SIDEBAR);
          setTermLines([]);
          setMessage(`Session exited: ${s.target} / ${s.branch}`);
        }
        setStatusVersion((v) => v + 1);
      };

      pty.onStatusChange = () => {
        setStatusVersion((v) => v + 1);
      };

      setStatusVersion((v) => v + 1);
    }

    // Disconnect previous
    if (activeKeyRef.current && activeKeyRef.current !== key) {
      ptySessions.current.get(activeKeyRef.current)?.setOutputHandler(undefined);
    }

    setActiveKey(key);
    setFocus(Focus.TERMINAL);
    pty.resize(termInner, contentHeight - 2);
    pty.setOutputHandler(() => scheduleTerminalRender(pty!));

    // Immediate render
    try {
      const lines = renderBufferLines(pty.terminal.buffer.active, termInner, contentHeight - 2);
      setTermLines(lines);
    } catch { /* */ }
  }, [unsafe, termInner, contentHeight, refreshSessions, scheduleTerminalRender]);

  /** Sync cursor position to active session. */
  const syncCursorToActive = useCallback(() => {
    if (activeKeyRef.current) {
      const idx = sessionsRef.current.findIndex(
        (s) => sessionKey(s) === activeKeyRef.current,
      );
      if (idx !== -1) setCursor(idx);
    }
  }, []);

  // Raw stdin input handling — bypass Ink's useInput for full control
  useEffect(() => {
    const handler = (data: Buffer) => {
      const key = data.toString('utf8');

      if (key === TAB_KEY) {
        const activePty = activeKeyRef.current ? ptySessions.current.get(activeKeyRef.current) : undefined;
        if (focusRef.current === Focus.SIDEBAR && activePty && !activePty.exited) {
          setFocus(Focus.TERMINAL);
        } else {
          setFocus(Focus.SIDEBAR);
          syncCursorToActive();
        }
        setMessage('');
        return;
      }

      if (focusRef.current === Focus.TERMINAL) {
        if (key === DETACH_KEY) {
          setFocus(Focus.SIDEBAR);
          syncCursorToActive();
          setMessage('');
          return;
        }
        ptySessions.current.get(activeKeyRef.current!)?.write(key);
        return;
      }

      // Sidebar
      setMessage('');

      if (key === '\x03' || key === 'q') {
        for (const pty of ptySessions.current.values()) pty.dispose();
        ptySessions.current.clear();
        onExit();
        return;
      }

      if (key === '\x1B[A' || key === 'k') { moveCursor(-1); return; }
      if (key === '\x1B[B' || key === 'j') { moveCursor(1); return; }

      if (key === '\r' && sessionsRef.current.length > 0) {
        activateSession(cursorRef.current);
        return;
      }

      if (key === 'd' && sessionsRef.current.length > 0) {
        const s = sessionsRef.current[cursorRef.current];
        const k = sessionKey(s);
        const pty = ptySessions.current.get(k);
        if (pty) { pty.dispose(); ptySessions.current.delete(k); }
        if (activeKeyRef.current === k) {
          setActiveKey(null);
          setTermLines([]);
        }
        removeSession(s.target, s.branch);
        setMessage(`Removed: ${s.target} / ${s.branch}`);
        refreshSessions();
        return;
      }

      if (key === 'r') {
        refreshSessions();
        setMessage('Refreshed');
        return;
      }
    };

    process.stdin.on('data', handler);
    return () => { process.stdin.removeListener('data', handler); };
  }, [onExit, activateSession, refreshSessions, moveCursor, syncCursorToActive]);

  // Resize handling — update dims state so layout re-renders, and resize active PTY
  useEffect(() => {
    const handler = () => {
      const newCols = process.stdout.columns || 80;
      const newRows = process.stdout.rows || 24;
      setDims({ cols: newCols, rows: newRows });

      if (activeKeyRef.current) {
        const pty = ptySessions.current.get(activeKeyRef.current);
        if (pty && !pty.exited) {
          const newTermInner = newCols - Math.min(40, Math.floor(newCols * 0.35)) - 2;
          const newContentHeight = newRows - 3;
          pty.resize(newTermInner, newContentHeight);
        }
      }
    };
    process.stdout.on('resize', handler);
    return () => { process.stdout.removeListener('resize', handler); };
  }, []);

  const statusMap = buildStatusMap();

  const placeholder = !activeKey
    ? 'Select a session and press Enter'
    : 'Press Enter to start session';

  return (
    <Box flexDirection="column" width={cols} height={rows}>
      <Box flexDirection="row" height={contentHeight}>
        <Sidebar
          sessions={sessions}
          sidebarRows={sidebarRows}
          cursor={cursor}
          focused={focus === Focus.SIDEBAR}
          statusMap={statusMap}
          width={sidebarWidth}
          height={contentHeight}
        />
        <TerminalPane
          lines={termLines}
          width={termWidth}
          height={contentHeight}
          focused={focus === Focus.TERMINAL}
          placeholder={placeholder}
        />
      </Box>
      <StatusBar message={message} />
    </Box>
  );
}
