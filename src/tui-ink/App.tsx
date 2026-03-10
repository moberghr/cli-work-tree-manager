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
import { loadConfig } from '../core/config.js';
import { PtySession } from '../tui/session.js';
import { HookServer, type HookEvent } from '../tui/hooks.js';
import { renderBufferLines } from './renderer-lines.js';
import { Sidebar, buildSessionRows, buildProjectRows, type SidebarRow } from './Sidebar.js';
import { TerminalPane } from './TerminalPane.js';
import { StatusBar } from './StatusBar.js';

const DETACH_KEY = '\x1D'; // Ctrl+]
const TAB_KEY = '\t';
const RENDER_INTERVAL_MS = 16;

enum Focus {
  SIDEBAR,
  TERMINAL,
}

/** Sidebar can show sessions (default) or projects (when creating new worktree). */
enum SidebarMode {
  SESSIONS,
  PROJECTS,
  BRANCH_INPUT,
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

function loadProjects(): Array<{ name: string; isGroup: boolean }> {
  const config = loadConfig();
  if (!config) return [];
  const projects: Array<{ name: string; isGroup: boolean }> = [];
  for (const name of Object.keys(config.groups)) {
    projects.push({ name, isGroup: true });
  }
  for (const name of Object.keys(config.repos)) {
    projects.push({ name, isGroup: false });
  }
  return projects;
}

function countSelectable(rows: SidebarRow[]): number {
  return rows.filter((r) => r.type !== 'header').length;
}

function cursorToRow(rows: SidebarRow[], cursor: number): SidebarRow | undefined {
  let idx = 0;
  for (const row of rows) {
    if (row.type === 'header') continue;
    if (idx === cursor) return row;
    idx++;
  }
  return undefined;
}

interface AppProps {
  unsafe: boolean;
  onExit: () => void;
}

export function App({ unsafe, onExit }: AppProps) {
  const [focus, setFocus] = useState(Focus.SIDEBAR);
  const [sessions, setSessions] = useState<WorktreeSession[]>(loadSessions);
  const [projects] = useState(loadProjects);
  const [cursor, setCursor] = useState(0);
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const [message, setMessage] = useState('');
  const [termLines, setTermLines] = useState<string[]>([]);
  const [statusVersion, setStatusVersion] = useState(0);
  const [sidebarMode, setSidebarMode] = useState(SidebarMode.SESSIONS);
  const [branchInput, setBranchInput] = useState<{ projectName: string; value: string } | null>(null);
  const [savedCursor, setSavedCursor] = useState(0);

  const sessionRows = useMemo(() => buildSessionRows(sessions), [sessions]);
  const projectRows = useMemo(() => buildProjectRows(projects), [projects]);
  const sidebarRows = sidebarMode === SidebarMode.SESSIONS ? sessionRows : projectRows;

  const ptySessions = useRef(new Map<string, PtySession>());
  const renderPending = useRef(false);
  const focusRef = useRef(focus);
  const activeKeyRef = useRef(activeKey);
  const cursorRef = useRef(cursor);
  const sessionsRef = useRef(sessions);
  const sidebarModeRef = useRef(sidebarMode);
  const branchInputRef = useRef(branchInput);
  const sidebarRowsRef = useRef(sidebarRows);

  // Keep refs in sync
  focusRef.current = focus;
  activeKeyRef.current = activeKey;
  cursorRef.current = cursor;
  sessionsRef.current = sessions;
  sidebarModeRef.current = sidebarMode;
  branchInputRef.current = branchInput;
  sidebarRowsRef.current = sidebarRows;

  // Layout — reactive to terminal resize
  const [dims, setDims] = useState(() => ({
    cols: process.stdout.columns || 80,
    rows: process.stdout.rows || 24,
  }));
  const cols = dims.cols;
  const rows = dims.rows;
  const sidebarWidth = Math.min(60, Math.floor(cols * 0.525));
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
    setSessions(loadSessions());
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
    return () => { hookServer.stop().catch(() => {}); };
  }, [findPtyByCwd]);

  /** Switch the right pane to show a different session's terminal. */
  const switchDisplay = useCallback((sessionIndex: number) => {
    const s = sessionsRef.current[sessionIndex];
    if (!s) return;
    const k = sessionKey(s);
    if (activeKeyRef.current === k) return;

    if (activeKeyRef.current) {
      ptySessions.current.get(activeKeyRef.current)?.setOutputHandler(undefined);
    }

    setActiveKey(k);

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

  /** Move cursor within current sidebar rows. */
  const moveCursor = useCallback((delta: number) => {
    const max = countSelectable(sidebarRowsRef.current) - 1;
    if (max < 0) return;
    const next = Math.max(0, Math.min(max, cursorRef.current + delta));
    setCursor(next);

    // Auto-switch display if in sessions mode and landing on a session
    if (sidebarModeRef.current === SidebarMode.SESSIONS) {
      const row = cursorToRow(sidebarRowsRef.current, next);
      if (row?.type === 'session') {
        switchDisplay(row.sessionIndex);
      }
    }
  }, [switchDisplay]);

  /** Connect a PTY to the display and focus on it. */
  const connectPty = useCallback((key: string, pty: PtySession) => {
    if (activeKeyRef.current && activeKeyRef.current !== key) {
      ptySessions.current.get(activeKeyRef.current)?.setOutputHandler(undefined);
    }
    setActiveKey(key);
    setFocus(Focus.TERMINAL);
    pty.resize(termInner, contentHeight - 2);
    pty.setOutputHandler(() => scheduleTerminalRender(pty));
    try {
      setTermLines(renderBufferLines(pty.terminal.buffer.active, termInner, contentHeight - 2));
    } catch { /* */ }
  }, [termInner, contentHeight, scheduleTerminalRender]);

  const startPtyForSession = useCallback((s: WorktreeSession, key: string) => {
    const existing = s.paths.find((p) => fs.existsSync(p));
    if (!existing) {
      setMessage('Session path no longer exists');
      refreshSessions();
      return;
    }

    const dir = s.isGroup ? path.dirname(existing) : existing;
    const pty = new PtySession(dir, termInner, contentHeight - 2, unsafe);
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
    pty.onStatusChange = () => setStatusVersion((v) => v + 1);
    setStatusVersion((v) => v + 1);
    return pty;
  }, [unsafe, termInner, contentHeight, refreshSessions]);

  const activateSession = useCallback((sessionIndex: number) => {
    const s = sessionsRef.current[sessionIndex];
    if (!s) return;
    const key = sessionKey(s);
    let pty = ptySessions.current.get(key);

    if (!pty || pty.exited) {
      pty = startPtyForSession(s, key);
      if (!pty) return;
    }
    connectPty(key, pty);
  }, [startPtyForSession, connectPty]);

  const syncCursorToActive = useCallback(() => {
    if (activeKeyRef.current) {
      const idx = sessionsRef.current.findIndex(
        (s) => sessionKey(s) === activeKeyRef.current,
      );
      if (idx !== -1) setCursor(idx);
    }
  }, []);

  /** Spawn `work2 tree` in a PTY. */
  const handleCreateWorktree = useCallback((projectName: string, branchName: string) => {
    // Return to sessions view
    setSidebarMode(SidebarMode.SESSIONS);
    setCursor(savedCursor);

    const key = `${projectName}:${branchName}`;
    const args = ['tree', projectName, branchName];
    if (unsafe) args.push('--unsafe');

    const pty = new PtySession(
      process.cwd(),
      termInner,
      contentHeight - 2,
      unsafe,
      { cmd: 'work2', args },
    );
    ptySessions.current.set(key, pty);

    pty.onExit = (code: number) => {
      ptySessions.current.delete(key);
      if (activeKeyRef.current === key) {
        setActiveKey(null);
        setFocus(Focus.SIDEBAR);
        setTermLines([]);
      }
      setStatusVersion((v) => v + 1);
      refreshSessions();
      if (code === 0) {
        setMessage(`Created: ${projectName}/${branchName}`);
      } else {
        setMessage(`Failed to create worktree (exit ${code})`);
      }
    };
    pty.onStatusChange = () => setStatusVersion((v) => v + 1);
    setStatusVersion((v) => v + 1);
    setMessage(`Creating: ${projectName}/${branchName}...`);
    connectPty(key, pty);
  }, [unsafe, termInner, contentHeight, refreshSessions, connectPty, savedCursor]);

  // Raw stdin input handling
  useEffect(() => {
    const handler = (data: Buffer) => {
      const key = data.toString('utf8');

      // Branch input mode
      if (branchInputRef.current) {
        if (key === '\x1B' || key === '\x03') {
          setBranchInput(null);
          setSidebarMode(SidebarMode.PROJECTS);
          setMessage('Esc to go back');
          return;
        }
        if (key === '\r') {
          const { projectName, value } = branchInputRef.current;
          setBranchInput(null);
          if (value.trim()) {
            handleCreateWorktree(projectName, value.trim());
          } else {
            setMessage('Branch name cannot be empty');
          }
          return;
        }
        if (key === '\x7F' || key === '\b') {
          setBranchInput((prev) => prev ? { ...prev, value: prev.value.slice(0, -1) } : null);
          return;
        }
        if (key.charCodeAt(0) < 32) return;
        setBranchInput((prev) => prev ? { ...prev, value: prev.value + key } : null);
        return;
      }

      if (key === TAB_KEY) {
        if (sidebarModeRef.current !== SidebarMode.SESSIONS) return; // no tab in project picker
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

      // Sidebar navigation
      setMessage('');

      // Project picker mode
      if (sidebarModeRef.current === SidebarMode.PROJECTS) {
        if (key === '\x1B' || key === '\x03' || key === 'q') {
          // Escape/q — back to sessions
          setSidebarMode(SidebarMode.SESSIONS);
          setCursor(savedCursor);
          setMessage('');
          return;
        }
        if (key === '\x1B[A' || key === 'k') { moveCursor(-1); return; }
        if (key === '\x1B[B' || key === 'j') { moveCursor(1); return; }
        if (key === '\r') {
          const row = cursorToRow(sidebarRowsRef.current, cursorRef.current);
          if (row?.type === 'project') {
            setSidebarMode(SidebarMode.BRANCH_INPUT);
            setBranchInput({ projectName: row.name, value: '' });
            setMessage('Type branch name, Enter to create, Esc to cancel');
          }
          return;
        }
        return;
      }

      // Sessions mode
      if (key === '\x03' || key === 'q') {
        for (const pty of ptySessions.current.values()) pty.dispose();
        ptySessions.current.clear();
        onExit();
        return;
      }

      if (key === '\x1B[A' || key === 'k') { moveCursor(-1); return; }
      if (key === '\x1B[B' || key === 'j') { moveCursor(1); return; }

      if (key === '\r') {
        const row = cursorToRow(sidebarRowsRef.current, cursorRef.current);
        if (row?.type === 'session') {
          activateSession(row.sessionIndex);
        }
        return;
      }

      if (key === 'd') {
        const row = cursorToRow(sidebarRowsRef.current, cursorRef.current);
        if (row?.type !== 'session') return;

        const s = row.session;
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

      if (key === 'n') {
        // Enter project picker
        setSavedCursor(cursorRef.current);
        setSidebarMode(SidebarMode.PROJECTS);
        setCursor(0);
        setMessage('Select project, Esc to cancel');
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
  }, [onExit, activateSession, refreshSessions, moveCursor, syncCursorToActive, handleCreateWorktree, savedCursor]);

  // Resize handling
  useEffect(() => {
    const handler = () => {
      const newCols = process.stdout.columns || 80;
      const newRows = process.stdout.rows || 24;
      setDims({ cols: newCols, rows: newRows });
      if (activeKeyRef.current) {
        const pty = ptySessions.current.get(activeKeyRef.current);
        if (pty && !pty.exited) {
          const newTermInner = newCols - Math.min(60, Math.floor(newCols * 0.525)) - 2;
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
          sidebarRows={sidebarRows}
          cursor={cursor}
          focused={focus === Focus.SIDEBAR}
          statusMap={statusMap}
          width={sidebarWidth}
          height={contentHeight}
          branchInput={branchInput}
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
