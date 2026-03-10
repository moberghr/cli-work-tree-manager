import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { Box } from 'ink';
import fs from 'node:fs';
import path from 'node:path';
import spawn from 'cross-spawn';
import {
  loadHistory,
  getRecentSessions,
  removeSession,
  upsertSession,
  type WorktreeSession,
} from '../core/history.js';
import { loadConfig } from '../core/config.js';
import { rebaseOntoMain, countConflicts, isBranchMerged, fetchRemoteAsync } from '../core/git.js';
import { fetchAllPullRequests, isGhAvailable, type BranchPrMap } from '../core/pr.js';
import { PtySession } from '../tui/session.js';
import { HookServer, type HookEvent } from '../tui/hooks.js';
import { renderBufferLines } from './renderer-lines.js';
import {
  Sidebar, PrPane,
  buildSessionRows, buildProjectRows, buildPrRows,
  countSelectable, cursorToRow,
  type SidebarRow,
} from './Sidebar.js';
import { TerminalPane } from './TerminalPane.js';
import { StatusBar } from './StatusBar.js';

const DETACH_KEY = '\x1D'; // Ctrl+]
const TAB_KEY = '\t';
const RENDER_INTERVAL_MS = 16;

enum Focus {
  SESSIONS,
  PRS,
  TERMINAL,
}

/** Top pane can show sessions (default) or projects (when creating new worktree). */
enum TopPaneMode {
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

/** Find the best project target for a repo alias: prefer group if it belongs to one. */
function repoToProject(repoAlias: string, config: { repos: Record<string, string>; groups: Record<string, string[]> }): string {
  for (const [groupName, aliases] of Object.entries(config.groups)) {
    if (aliases.includes(repoAlias)) return groupName;
  }
  return repoAlias;
}

interface AppProps {
  unsafe: boolean;
  onExit: () => void;
}

export function App({ unsafe, onExit }: AppProps) {
  const [focus, setFocus] = useState(Focus.SESSIONS);
  const [sessions, setSessions] = useState<WorktreeSession[]>(loadSessions);
  const [projects] = useState(loadProjects);
  const [config] = useState(() => loadConfig());
  const [sessionCursor, setSessionCursor] = useState(0);
  const [prCursor, setPrCursor] = useState(0);
  const [conflictCounts, setConflictCounts] = useState<Map<string, number>>(new Map());
  const [mergedSet, setMergedSet] = useState<Set<string>>(new Set());
  const [prMap, setPrMap] = useState<BranchPrMap>(new Map());
  const [ghAvailable, setGhAvailable] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const prFetching = useRef(false);
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const [message, setMessage] = useState('');
  const [termLines, setTermLines] = useState<string[]>([]);
  const [statusVersion, setStatusVersion] = useState(0);
  const [topPaneMode, setTopPaneMode] = useState(TopPaneMode.SESSIONS);
  const [branchInput, setBranchInput] = useState<{ projectName: string; value: string } | null>(null);
  const [savedSessionCursor, setSavedSessionCursor] = useState(0);

  const localBranches = useMemo(() => new Set(sessions.map((s) => s.branch)), [sessions]);
  const sessionRows = useMemo(() => buildSessionRows(sessions), [sessions]);
  const projectRows = useMemo(() => buildProjectRows(projects), [projects]);
  const prRows = useMemo(() => buildPrRows(prMap), [prMap]);
  const topRows = topPaneMode === TopPaneMode.SESSIONS ? sessionRows : projectRows;

  const ptySessions = useRef(new Map<string, PtySession>());
  const renderPending = useRef(false);
  const focusRef = useRef(focus);
  const activeKeyRef = useRef(activeKey);
  const sessionCursorRef = useRef(sessionCursor);
  const prCursorRef = useRef(prCursor);
  const sessionsRef = useRef(sessions);
  const topPaneModeRef = useRef(topPaneMode);
  const branchInputRef = useRef(branchInput);
  const topRowsRef = useRef(topRows);
  const prRowsRef = useRef(prRows);

  // Keep refs in sync
  focusRef.current = focus;
  activeKeyRef.current = activeKey;
  sessionCursorRef.current = sessionCursor;
  prCursorRef.current = prCursor;
  sessionsRef.current = sessions;
  topPaneModeRef.current = topPaneMode;
  branchInputRef.current = branchInput;
  topRowsRef.current = topRows;
  prRowsRef.current = prRows;

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
  // Split left column: 60% sessions, 40% PRs (min 5 rows each)
  const prPaneHeight = Math.max(5, Math.floor(contentHeight * 0.4));
  const sessionPaneHeight = contentHeight - prPaneHeight;

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

  const computeConflictsAndMerged = useCallback((sessionList: WorktreeSession[]) => {
    const counts = new Map<string, number>();
    const merged = new Set<string>();
    for (const s of sessionList) {
      const existing = s.paths.find((p) => fs.existsSync(p));
      if (!existing || !s.branch) continue;
      const key = sessionKey(s);
      try {
        const c = countConflicts(s.branch, existing);
        if (c > 0) counts.set(key, c);
      } catch { /* ignore */ }
      try {
        const { merged: isMerged } = isBranchMerged(s.branch, existing);
        if (isMerged) merged.add(key);
      } catch { /* ignore */ }
    }
    setConflictCounts(counts);
    setMergedSet(merged);
  }, []);

  const refreshPrs = useCallback(() => {
    if (!ghAvailable || !config || prFetching.current) return;
    prFetching.current = true;
    setMessage('Loading PRs...');
    fetchAllPullRequests(config.repos)
      .then((prs) => {
        setPrMap(prs);
        setMessage('');
      })
      .catch(() => {})
      .finally(() => { prFetching.current = false; });
  }, [ghAvailable, config]);

  const refreshSessions = useCallback(() => {
    const updated = loadSessions();
    setSessions(updated);
    computeConflictsAndMerged(updated);
  }, [computeConflictsAndMerged]);

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

  // Initial sync: fetch remotes, check gh, then refresh everything
  useEffect(() => {
    let cancelled = false;
    setSyncing(true);

    (async () => {
      const [, ghOk] = await Promise.all([
        config
          ? Promise.all(
              Object.values(config.repos).map((repoPath) =>
                fetchRemoteAsync(repoPath).catch(() => {}),
              ),
            )
          : Promise.resolve(),
        isGhAvailable(),
      ]);

      if (cancelled) return;
      setSyncing(false);
      refreshSessions();
      setGhAvailable(ghOk);
    })();

    return () => { cancelled = true; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Fetch PRs once gh is confirmed available
  useEffect(() => {
    if (ghAvailable) refreshPrs();
  }, [ghAvailable, refreshPrs]);

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
  const switchDisplay = useCallback((s: WorktreeSession) => {
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

  /** Move cursor within the top (session/project) pane. */
  const moveSessionCursor = useCallback((delta: number) => {
    const max = countSelectable(topRowsRef.current) - 1;
    if (max < 0) return;
    const next = Math.max(0, Math.min(max, sessionCursorRef.current + delta));
    setSessionCursor(next);

    // Auto-switch display if in sessions mode
    if (topPaneModeRef.current === TopPaneMode.SESSIONS) {
      const row = cursorToRow(topRowsRef.current, next);
      if (row?.type === 'session') {
        switchDisplay(row.session);
      }
    }
  }, [switchDisplay]);

  /** Move cursor within the PR pane. */
  const movePrCursor = useCallback((delta: number) => {
    const max = countSelectable(prRowsRef.current) - 1;
    if (max < 0) return;
    const next = Math.max(0, Math.min(max, prCursorRef.current + delta));
    setPrCursor(next);
  }, []);

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
    const pty = new PtySession(dir, termInner, contentHeight - 2, unsafe, undefined, config?.aiCommand);
    ptySessions.current.set(key, pty);
    upsertSession(s.target, s.isGroup, s.branch, s.paths);

    pty.onExit = () => {
      ptySessions.current.delete(key);
      if (activeKeyRef.current === key) {
        setActiveKey(null);
        setFocus(Focus.SESSIONS);
        setTermLines([]);
        setMessage(`Session exited: ${s.target} / ${s.branch}`);
      }
      setStatusVersion((v) => v + 1);
    };
    pty.onStatusChange = () => setStatusVersion((v) => v + 1);
    setStatusVersion((v) => v + 1);
    return pty;
  }, [unsafe, termInner, contentHeight, refreshSessions]);

  const activateSession = useCallback((s: WorktreeSession) => {
    const key = sessionKey(s);
    let pty = ptySessions.current.get(key);

    if (!pty || pty.exited) {
      pty = startPtyForSession(s, key);
      if (!pty) return;
    }
    connectPty(key, pty);
  }, [startPtyForSession, connectPty]);

  const syncSessionCursorToActive = useCallback(() => {
    if (!activeKeyRef.current) return;
    let selectableIdx = 0;
    for (const row of topRowsRef.current) {
      if (row.type === 'header') continue;
      if (row.type === 'session' && sessionKey(row.session) === activeKeyRef.current) {
        setSessionCursor(selectableIdx);
        return;
      }
      selectableIdx++;
    }
  }, []);

  /** Spawn `work2 tree` in a PTY. */
  const handleCreateWorktree = useCallback((projectName: string, branchName: string) => {
    // Return to sessions view
    setTopPaneMode(TopPaneMode.SESSIONS);
    setSessionCursor(savedSessionCursor);

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
        setFocus(Focus.SESSIONS);
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
  }, [unsafe, termInner, contentHeight, refreshSessions, connectPty, savedSessionCursor]);

  // Raw stdin input handling
  useEffect(() => {
    const handler = (data: Buffer) => {
      const key = data.toString('utf8');

      // Branch input mode (top pane)
      if (branchInputRef.current) {
        if (key === '\x1B' || key === '\x03') {
          setBranchInput(null);
          setTopPaneMode(TopPaneMode.PROJECTS);
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

      // Tab: cycle focus SESSIONS → PRS → TERMINAL → SESSIONS
      if (key === TAB_KEY) {
        if (topPaneModeRef.current !== TopPaneMode.SESSIONS) return;
        if (focusRef.current === Focus.SESSIONS) {
          if (countSelectable(prRowsRef.current) > 0) {
            setFocus(Focus.PRS);
          } else {
            const activePty = activeKeyRef.current ? ptySessions.current.get(activeKeyRef.current) : undefined;
            if (activePty && !activePty.exited) setFocus(Focus.TERMINAL);
          }
        } else if (focusRef.current === Focus.PRS) {
          const activePty = activeKeyRef.current ? ptySessions.current.get(activeKeyRef.current) : undefined;
          if (activePty && !activePty.exited) {
            setFocus(Focus.TERMINAL);
          } else {
            setFocus(Focus.SESSIONS);
            syncSessionCursorToActive();
          }
        } else {
          setFocus(Focus.SESSIONS);
          syncSessionCursorToActive();
        }
        setMessage('');
        return;
      }

      // Terminal mode
      if (focusRef.current === Focus.TERMINAL) {
        if (key === DETACH_KEY) {
          setFocus(Focus.SESSIONS);
          syncSessionCursorToActive();
          setMessage('');
          return;
        }
        ptySessions.current.get(activeKeyRef.current!)?.write(key);
        return;
      }

      // --- Left pane navigation ---
      setMessage('');

      // Project picker mode (top pane)
      if (topPaneModeRef.current === TopPaneMode.PROJECTS) {
        if (key === '\x1B' || key === '\x03' || key === 'q') {
          setTopPaneMode(TopPaneMode.SESSIONS);
          setSessionCursor(savedSessionCursor);
          setMessage('');
          return;
        }
        if (key === '\x1B[A' || key === 'k') { moveSessionCursor(-1); return; }
        if (key === '\x1B[B' || key === 'j') { moveSessionCursor(1); return; }
        if (key === '\r') {
          const row = cursorToRow(topRowsRef.current, sessionCursorRef.current);
          if (row?.type === 'project') {
            setTopPaneMode(TopPaneMode.BRANCH_INPUT);
            setBranchInput({ projectName: row.name, value: '' });
            setMessage('Type branch name, Enter to create, Esc to cancel');
          }
          return;
        }
        return;
      }

      // PR pane focused
      if (focusRef.current === Focus.PRS) {
        if (key === '\x1B[A' || key === 'k') { movePrCursor(-1); return; }
        if (key === '\x1B[B' || key === 'j') { movePrCursor(1); return; }

        if (key === '\r') {
          const row = cursorToRow(prRowsRef.current, prCursorRef.current);
          if (row?.type === 'pr' && config) {
            const pr = row.pr;
            const projectName = repoToProject(pr.repoAlias, config);

            // Check if any session already has this branch (regardless of target name)
            const existing = sessionsRef.current.find(
              (s) => s.branch === pr.branch,
            );
            if (existing) {
              setFocus(Focus.SESSIONS);
              activateSession(existing);
              setMessage(`Resumed: ${existing.target}/${pr.branch}`);
            } else {
              handleCreateWorktree(projectName, pr.branch);
            }
          }
          return;
        }

        if (key === '\x03' || key === 'q') {
          for (const pty of ptySessions.current.values()) pty.dispose();
          ptySessions.current.clear();
          onExit();
          return;
        }

        if (key === 'g') {
          if (syncing) return;
          setSyncing(true);
          setMessage('Syncing...');
          (async () => {
            if (config) {
              await Promise.all(
                Object.values(config.repos).map((repoPath) =>
                  fetchRemoteAsync(repoPath).catch(() => {}),
                ),
              );
            }
            refreshSessions();
            refreshPrs();
            setSyncing(false);
            if (!ghAvailable) setMessage('Synced');
          })();
          return;
        }

        if (key === 'r') {
          refreshSessions();
          refreshPrs();
          if (!ghAvailable) setMessage('Refreshed');
          return;
        }

        return;
      }

      // Sessions pane focused
      if (key === '\x03' || key === 'q') {
        for (const pty of ptySessions.current.values()) pty.dispose();
        ptySessions.current.clear();
        onExit();
        return;
      }

      if (key === '\x1B[A' || key === 'k') { moveSessionCursor(-1); return; }
      if (key === '\x1B[B' || key === 'j') { moveSessionCursor(1); return; }

      if (key === '\r') {
        const row = cursorToRow(topRowsRef.current, sessionCursorRef.current);
        if (row?.type === 'session') {
          activateSession(row.session);
        }
        return;
      }

      if (key === 'd') {
        const row = cursorToRow(topRowsRef.current, sessionCursorRef.current);
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
        setSavedSessionCursor(sessionCursorRef.current);
        setTopPaneMode(TopPaneMode.PROJECTS);
        setSessionCursor(0);
        setMessage('Select project, Esc to cancel');
        return;
      }

      if (key === '.') {
        const row = cursorToRow(topRowsRef.current, sessionCursorRef.current);
        if (row?.type !== 'session') return;
        const s = row.session;
        const existing = s.paths.find((p) => fs.existsSync(p));
        if (!existing) { setMessage('Session path no longer exists'); return; }
        const dir = s.isGroup ? path.dirname(existing) : existing;
        const editor = config?.editor ?? 'code';
        spawn(editor, [dir], { detached: true, stdio: 'ignore' }).unref();
        setMessage(`Opened in ${editor}: ${s.branch}`);
        return;
      }

      if (key === 'u') {
        const row = cursorToRow(topRowsRef.current, sessionCursorRef.current);
        if (row?.type !== 'session') return;
        const s = row.session;
        const existing = s.paths.find((p) => fs.existsSync(p));
        if (!existing) { setMessage('Session path no longer exists'); return; }
        setMessage(`Rebasing ${s.branch}...`);
        const err = rebaseOntoMain(s.branch, existing);
        if (err) {
          setMessage(`Rebase failed: ${err}`);
        } else {
          setMessage(`Rebased ${s.branch} onto main`);
          computeConflictsAndMerged(sessionsRef.current);
        }
        return;
      }

      if (key === 'g') {
        if (syncing) return;
        setSyncing(true);
        setMessage('Syncing...');
        (async () => {
          if (config) {
            await Promise.all(
              Object.values(config.repos).map((repoPath) =>
                fetchRemoteAsync(repoPath).catch(() => {}),
              ),
            );
          }
          refreshSessions();
          refreshPrs();
          setSyncing(false);
          if (!ghAvailable) setMessage('Synced');
        })();
        return;
      }

      if (key === 'r') {
        refreshSessions();
        refreshPrs();
        if (!ghAvailable) setMessage('Refreshed');
        return;
      }
    };

    process.stdin.on('data', handler);
    return () => { process.stdin.removeListener('data', handler); };
  }, [onExit, activateSession, refreshSessions, refreshPrs, moveSessionCursor, movePrCursor, syncSessionCursorToActive, handleCreateWorktree, savedSessionCursor, config, computeConflictsAndMerged, syncing, ghAvailable, prMap]);

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
        <Box flexDirection="column" width={sidebarWidth}>
          <Sidebar
            sidebarRows={topRows}
            cursor={sessionCursor}
            focused={focus === Focus.SESSIONS}
            statusMap={statusMap}
            conflictCounts={conflictCounts}
            mergedSet={mergedSet}
            prMap={prMap}
            width={sidebarWidth}
            height={sessionPaneHeight}
            branchInput={branchInput}
          />
          <PrPane
            prRows={prRows}
            cursor={prCursor}
            focused={focus === Focus.PRS}
            localBranches={localBranches}
            width={sidebarWidth}
            height={prPaneHeight}
          />
        </Box>
        <TerminalPane
          lines={termLines}
          width={termWidth}
          height={contentHeight}
          focused={focus === Focus.TERMINAL}
          placeholder={placeholder}
        />
      </Box>
      <StatusBar message={message} syncing={syncing} />
    </Box>
  );
}
