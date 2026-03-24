import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { Box } from 'ink';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import v8 from 'node:v8';
import { execFile } from 'node:child_process';
import spawn from 'cross-spawn';
import {
  loadHistory,
  getRecentSessions,
  upsertSession,
  getHistoryPath,
  type WorktreeSession,
} from '../core/history.js';
import { loadConfig } from '../core/config.js';
import { rebaseOntoMain, countConflicts, isBranchMerged, fetchRemoteAsync } from '../core/git.js';
import { fetchAllPullRequests, isGhAvailable, type BranchPrMap } from '../core/pr.js';
import { fetchMyJiraIssues, isAcliAvailable, type JiraIssue } from '../core/jira.js';
import { getTasks, addTask, completeTask, uncompleteTask, removeTask, editTask, getTasksPath_, type Task } from '../core/tasks.js';
import { openUrl } from '../utils/platform.js';
import { PtySession, type SessionStatus } from '../tui/session.js';
import { debug } from '../core/logger.js';
import { HookServer, type HookEvent } from '../tui/hooks.js';
import { renderBufferLines } from './renderer-lines.js';
import {
  Sidebar, PrPane, JiraPane, TaskPane,
  buildSessionRows, buildProjectRows, buildPrRows, buildJiraRows, buildTaskRows,
  countSelectable, cursorToRow,
  type SidebarRow,
} from './Sidebar.js';
import { TerminalPane } from './TerminalPane.js';
import { StatusBar } from './StatusBar.js';

const DETACH_KEY = '\x1D'; // Ctrl+]
const TAB_KEY = '\t';
const RENDER_INTERVAL_MS = 16;

// SGR mouse: \x1b[<button;col;rowM or \x1b[<button;col;rowm
// Button 64 = scroll up, 65 = scroll down
const MOUSE_SGR_RE = /\x1b\[<(\d+);(\d+);(\d+)[Mm]/;

enum Focus {
  SESSIONS,
  TASKS,
  PRS,
  JIRA,
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

function mechanicalSlug(summary: string): string {
  return summary
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 50);
}

function generateSlug(summary: string): Promise<string> {
  const fallback = mechanicalSlug(summary);
  return new Promise((resolve) => {
    const child = execFile(
      'claude',
      ['-p', '--model', 'haiku'],
      { encoding: 'utf-8', timeout: 10000 },
      (err, stdout) => {
        const result = stdout?.trim()
          .toLowerCase()
          .replace(/[^a-z0-9-]/g, '')
          .replace(/^-|-$/g, '');
        resolve(result || fallback);
      },
    );
    child.stdin?.write(
      `Generate a short git branch slug (max 40 chars, lowercase, hyphens only) for: ${summary}\nOutput ONLY the slug, nothing else.`,
    );
    child.stdin?.end();
  });
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
  const [jiraCursor, setJiraCursor] = useState(0);
  const [taskCursor, setTaskCursor] = useState(0);
  const [tasks, setTasks] = useState<Task[]>(getTasks);
  const [taskInput, setTaskInput] = useState<string | null>(null);
  const [taskEditId, setTaskEditId] = useState<number | null>(null);
  const taskEditIdRef = useRef(taskEditId);
  const [jiraIssues, setJiraIssues] = useState<JiraIssue[]>([]);
  const [acliAvailable, setAcliAvailable] = useState(false);
  const jiraFetching = useRef(false);
  const [conflictCounts, setConflictCounts] = useState<Map<string, number>>(new Map());
  const [mergedSet, setMergedSet] = useState<Set<string>>(new Set());
  const [prMap, setPrMap] = useState<BranchPrMap>(new Map());
  const [ghAvailable, setGhAvailable] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const prFetching = useRef(false);
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const [message, setMessage] = useState('');
  const [termLines, setTermLines] = useState<string[]>([]);
  const termScrollBack = useRef(0);
  const [statusVersion, setStatusVersion] = useState(0);
  const [topPaneMode, setTopPaneMode] = useState(TopPaneMode.SESSIONS);
  const [branchInput, setBranchInput] = useState<{ projectName: string; value: string; isGroup: boolean } | null>(null);
  const [pendingBranch, setPendingBranch] = useState<string | null>(null);
  const [pendingJiraIssue, setPendingJiraIssue] = useState<JiraIssue | null>(null);
  const [pendingTask, setPendingTask] = useState<Task | null>(null);
  const [savedSessionCursor, setSavedSessionCursor] = useState(0);

  const localBranches = useMemo(() => new Set(sessions.map((s) => s.branch)), [sessions]);
  const projectRows = useMemo(() => buildProjectRows(projects), [projects]);
  const prRows = useMemo(() => buildPrRows(prMap), [prMap]);
  const jiraRows = useMemo(() => buildJiraRows(jiraIssues), [jiraIssues]);
  const taskRows = useMemo(() => buildTaskRows(tasks), [tasks]);

  const ptySessions = useRef(new Map<string, PtySession>());
  const sessionRows = useMemo(() => {
    const sMap = new Map<string, SessionStatus>();
    for (const [key, pty] of ptySessions.current) {
      if (pty.exited) continue;
      sMap.set(key, pty.idle ? 'idle' : 'running');
    }
    return buildSessionRows(sessions, sMap);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessions, statusVersion]);
  const topRows = topPaneMode === TopPaneMode.SESSIONS ? sessionRows : projectRows;
  const renderPending = useRef(false);
  const focusRef = useRef(focus);
  const activeKeyRef = useRef(activeKey);
  const sessionCursorRef = useRef(sessionCursor);
  const prCursorRef = useRef(prCursor);
  const jiraCursorRef = useRef(jiraCursor);
  const jiraRowsRef = useRef(jiraRows);
  const taskCursorRef = useRef(taskCursor);
  const taskRowsRef = useRef(taskRows);
  const taskInputRef = useRef(taskInput);
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
  jiraCursorRef.current = jiraCursor;
  jiraRowsRef.current = jiraRows;
  taskCursorRef.current = taskCursor;
  taskRowsRef.current = taskRows;
  taskInputRef.current = taskInput;
  taskEditIdRef.current = taskEditId;
  sessionsRef.current = sessions;
  topPaneModeRef.current = topPaneMode;
  branchInputRef.current = branchInput;
  const pendingBranchRef = useRef(pendingBranch);
  pendingBranchRef.current = pendingBranch;
  const pendingJiraIssueRef = useRef(pendingJiraIssue);
  pendingJiraIssueRef.current = pendingJiraIssue;
  const pendingTaskRef = useRef(pendingTask);
  pendingTaskRef.current = pendingTask;
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
  // Split left column into 3 panes
  const jiraPaneHeight = acliAvailable ? Math.max(5, Math.floor(contentHeight * 0.20)) : 0;
  const taskPaneHeight = Math.max(5, Math.floor(contentHeight * 0.20));
  const prPaneHeight = Math.max(5, Math.floor((contentHeight - jiraPaneHeight - taskPaneHeight) * 0.45));
  const sessionPaneHeight = contentHeight - prPaneHeight - taskPaneHeight - jiraPaneHeight;

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

  const refreshJira = useCallback(() => {
    if (!acliAvailable || jiraFetching.current) return;
    jiraFetching.current = true;
    fetchMyJiraIssues()
      .then((issues) => setJiraIssues(issues))
      .catch(() => {})
      .finally(() => { jiraFetching.current = false; });
  }, [acliAvailable]);

  const refreshTasks = useCallback(() => {
    setTasks(getTasks());
  }, []);

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

  /** Write terminal lines directly to stdout, bypassing Ink's React reconciler. */
  const lastDirectLines = useRef<string[]>([]);
  const writeTermDirect = useCallback((lines: string[]) => {
    lastDirectLines.current = lines;
    const startCol = sidebarWidth + 2; // after sidebar border + left terminal border
    const maxRows = contentHeight - 2;
    const buf: string[] = [];
    for (let i = 0; i < maxRows; i++) {
      const row = i + 2; // 1-indexed, skip top border
      buf.push(`\x1B[${row};${startCol}H`); // move cursor
      if (i < lines.length) {
        buf.push(lines[i]);
      } else {
        buf.push(' '.repeat(termInner));
      }
    }
    buf.push('\x1B[?25l'); // keep cursor hidden
    process.stdout.write(buf.join(''));
  }, [sidebarWidth, contentHeight, termInner]);

  const scheduleTerminalRender = useCallback((pty: PtySession) => {
    if (renderPending.current) return;
    renderPending.current = true;
    setTimeout(() => {
      renderPending.current = false;
      try {
        // If scrolled back, don't auto-update (user is reading scrollback)
        if (termScrollBack.current > 0) return;
        const lines = renderBufferLines(pty.terminal.buffer.active, termInner, contentHeight - 2);
        writeTermDirect(lines);
      } catch { /* buffer not ready */ }
    }, RENDER_INTERVAL_MS);
  }, [termInner, contentHeight, writeTermDirect]);

  /** Re-render terminal at current scroll offset. */
  const renderTermAtScroll = useCallback(() => {
    if (!activeKeyRef.current) return;
    const pty = ptySessions.current.get(activeKeyRef.current);
    if (!pty || pty.exited) return;
    try {
      writeTermDirect(renderBufferLines(pty.terminal.buffer.active, termInner, contentHeight - 2, termScrollBack.current));
    } catch { /* */ }
  }, [termInner, contentHeight, writeTermDirect]);

  const findPtyByCwd = useCallback((cwd: string): PtySession | undefined => {
    const normalized = path.resolve(cwd).toLowerCase();

    // Direct match on PTY cwd or searchPaths
    for (const pty of ptySessions.current.values()) {
      if (pty.exited) continue;
      if (path.resolve(pty.cwd).toLowerCase() === normalized) return pty;
      if (pty.searchPaths.some((p) => normalized.startsWith(path.resolve(p).toLowerCase()))) return pty;
    }

    // Match via session paths (handles PTYs spawned from a different cwd)
    for (const s of sessionsRef.current) {
      const match = s.paths.some((p) => normalized.startsWith(path.resolve(p).toLowerCase()));
      if (match) {
        const k = `${s.target}:${s.branch}`;
        const pty = ptySessions.current.get(k);
        if (pty && !pty.exited) return pty;
      }
    }

    return undefined;
  }, []);

  // Enable SGR mouse tracking for scroll wheel support
  useEffect(() => {
    process.stdout.write('\x1b[?1000h\x1b[?1006h');
    return () => { process.stdout.write('\x1b[?1000l\x1b[?1006l'); };
  }, []);

  // Initial sync: fetch remotes, check gh, then refresh everything
  useEffect(() => {
    let cancelled = false;
    setSyncing(true);

    (async () => {
      const [, ghOk, acliOk] = await Promise.all([
        config
          ? Promise.all(
              Object.values(config.repos).map((repoPath) =>
                fetchRemoteAsync(repoPath).catch(() => {}),
              ),
            )
          : Promise.resolve(),
        isGhAvailable(),
        isAcliAvailable(),
      ]);

      if (cancelled) return;
      setSyncing(false);
      refreshSessions();
      setGhAvailable(ghOk);
      setAcliAvailable(acliOk);
    })();

    return () => { cancelled = true; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Watch history file for changes (e.g. when work2 tree creates a new session)
  useEffect(() => {
    const historyPath = getHistoryPath();
    try {
      const watcher = fs.watch(historyPath, () => refreshSessions());
      return () => watcher.close();
    } catch { /* file may not exist yet */ }
  }, [refreshSessions]);

  // Watch tasks file for external changes
  useEffect(() => {
    const tasksPath = getTasksPath_();
    try {
      const watcher = fs.watch(tasksPath, () => refreshTasks());
      return () => watcher.close();
    } catch { /* file may not exist yet */ }
  }, [refreshTasks]);

  // Fetch PRs once gh is confirmed available
  useEffect(() => {
    if (ghAvailable) refreshPrs();
  }, [ghAvailable, refreshPrs]);

  // Fetch Jira issues once acli is confirmed available
  useEffect(() => {
    if (acliAvailable) refreshJira();
  }, [acliAvailable, refreshJira]);

  // Hook server
  useEffect(() => {
    const hookServer = new HookServer((cwd: string, event: HookEvent) => {
      const pty = findPtyByCwd(cwd);
      if (!pty) {
        debug('hook event no PTY match', { cwd, event, ptyCwds: [...ptySessions.current.entries()].map(([k, p]) => ({ key: k, cwd: p.cwd, exited: p.exited })) });
        return;
      }
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

    termScrollBack.current = 0;
    if (activeKeyRef.current) {
      ptySessions.current.get(activeKeyRef.current)?.setOutputHandler(undefined);
    }

    setActiveKey(k);

    const pty = ptySessions.current.get(k);
    if (pty && !pty.exited) {
      pty.resize(termInner, contentHeight - 2);
      pty.setOutputHandler(() => scheduleTerminalRender(pty));
      try {
        writeTermDirect(renderBufferLines(pty.terminal.buffer.active, termInner, contentHeight - 2));
        setTermLines(['__direct__']); // signal to TerminalPane that direct rendering is active
      } catch { /* */ }
    } else {
      setTermLines([]);
    }
  }, [termInner, contentHeight, scheduleTerminalRender, writeTermDirect]);

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

  /** Move cursor within the Jira pane. */
  const moveJiraCursor = useCallback((delta: number) => {
    const max = countSelectable(jiraRowsRef.current) - 1;
    if (max < 0) return;
    const next = Math.max(0, Math.min(max, jiraCursorRef.current + delta));
    setJiraCursor(next);
  }, []);

  const moveTaskCursor = useCallback((delta: number) => {
    const max = countSelectable(taskRowsRef.current) - 1;
    if (max < 0) return;
    const next = Math.max(0, Math.min(max, taskCursorRef.current + delta));
    setTaskCursor(next);
  }, []);

  /** Connect a PTY to the display and focus on it. */
  const connectPty = useCallback((key: string, pty: PtySession) => {
    debug('connectPty', { key, exited: pty.exited, termInner, rows: contentHeight - 2 });
    if (activeKeyRef.current && activeKeyRef.current !== key) {
      ptySessions.current.get(activeKeyRef.current)?.setOutputHandler(undefined);
    }
    setActiveKey(key);
    setFocus(Focus.TERMINAL);
    pty.resize(termInner, contentHeight - 2);
    pty.setOutputHandler(() => scheduleTerminalRender(pty));
    try {
      writeTermDirect(renderBufferLines(pty.terminal.buffer.active, termInner, contentHeight - 2));
      setTermLines(['__direct__']);
    } catch (err) {
      debug('connectPty renderBufferLines error', err instanceof Error ? err.stack : String(err));
    }
  }, [termInner, contentHeight, scheduleTerminalRender]);

  const startPtyForSession = useCallback((s: WorktreeSession, key: string) => {
    const existing = s.paths.find((p) => fs.existsSync(p));
    debug('startPtyForSession', { target: s.target, branch: s.branch, isGroup: s.isGroup, paths: s.paths, existing, key });
    if (!existing) {
      setMessage('Session path no longer exists');
      refreshSessions();
      return;
    }

    const dir = s.isGroup ? path.dirname(existing) : existing;
    const hasConversation = fs.existsSync(path.join(dir, '.claude'));
    debug('startPtyForSession launching PTY', { dir, termInner, rows: contentHeight - 2, unsafe, aiCommand: config?.aiCommand, resume: hasConversation });
    const pty = new PtySession(dir, termInner, contentHeight - 2, unsafe, undefined, config?.aiCommand, hasConversation);
    pty.searchPaths = [...s.paths, dir];
    ptySessions.current.set(key, pty);
    upsertSession(s.target, s.isGroup, s.branch, s.paths);

    pty.onExit = (code: number) => {
      debug('onExit session PTY', { target: s.target, branch: s.branch, key, code });
      pty.dispose();
      ptySessions.current.delete(key);
      if (activeKeyRef.current === key) {
        setActiveKey(null);
        setFocus(Focus.SESSIONS);
        setTermLines([]);
        setMessage(`Session exited: ${s.target} / ${s.branch} (code ${code})`);
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

  /** Launch Claude directly in the base repo (no worktree). */
  const handleLaunchBaseRepo = useCallback((projectName: string) => {
    setTopPaneMode(TopPaneMode.SESSIONS);
    setSessionCursor(savedSessionCursor);

    if (!config) return;
    const repoPath = config.repos[projectName];
    if (!repoPath || !fs.existsSync(repoPath)) {
      setMessage(`Repo path not found for ${projectName}`);
      return;
    }

    const branch = '(base)';
    const key = `${projectName}:${branch}`;
    upsertSession(projectName, false, branch, [repoPath]);
    refreshSessions();

    const pty = new PtySession(repoPath, termInner, contentHeight - 2, unsafe, undefined, config.aiCommand);
    ptySessions.current.set(key, pty);

    pty.onExit = (code: number) => {
      debug('onExit base-repo PTY', { projectName, key, code });
      pty.dispose();
      ptySessions.current.delete(key);
      if (activeKeyRef.current === key) {
        setActiveKey(null);
        setFocus(Focus.SESSIONS);
        setTermLines([]);
        setMessage(`Session exited: ${projectName} (base) (code ${code})`);
      }
      setStatusVersion((v) => v + 1);
    };
    pty.onStatusChange = () => setStatusVersion((v) => v + 1);
    setStatusVersion((v) => v + 1);
    connectPty(key, pty);
    setMessage(`Launched: ${projectName} (base repo)`);
  }, [unsafe, termInner, contentHeight, connectPty, refreshSessions, savedSessionCursor, config]);

  /** Spawn `work2 tree` in a single PTY — sets up the worktree and launches Claude. */
  const handleCreateWorktree = useCallback((projectName: string, branchName: string, jiraIssue?: JiraIssue | null) => {
    setTopPaneMode(TopPaneMode.SESSIONS);
    setSessionCursor(savedSessionCursor);

    const key = `${projectName}:${branchName}`;
    const args = ['tree', projectName, branchName];
    if (unsafe) args.push('--unsafe');

    if (jiraIssue) {
      args.push('--jira-key', jiraIssue.key);
      const prompt = [
        `Read Jira issue ${jiraIssue.key} (${jiraIssue.url}) and determine how to handle it.`,
        '',
        '1. Read the Jira issue details to understand requirements, acceptance criteria, and context.',
        '',
        '2. Classify the issue:',
        '   - **One-time data task**: The issue asks for a data lookup, data fix, report, or one-off operation (e.g., "find all X", "update Y records", "generate a report for Z").',
        '   - **One-time script/query**: The issue asks for a SQL query, a script, or a one-off test client invocation — not a permanent code change.',
        '   - **Code change**: The issue requires modifying the codebase (bug fix, feature, refactor).',
        '',
        '3. Based on the classification:',
        '',
        '   **If one-time data task or script/query:**',
        '   - Generate the SQL query, script, or test client code directly.',
        '   - If a test client or similar tool exists in the codebase, use it.',
        '   - Present the output ready to run. Explain what it does and any parameters to adjust.',
        '   - Ask if I want to run it, modify it, or need something different.',
        '',
        '   **If code change:**',
        '   - Analyze the codebase to understand which files/components need changes, existing patterns, dependencies, and impact areas.',
        '   - Present a structured implementation plan:',
        '',
        '     **Summary**: Brief overview of what the issue requires.',
        '',
        '     **Affected Areas**: List the files, components, or modules that will need changes.',
        '',
        '     **Implementation Approach**:',
        '     - For simple issues (bug fixes, small features): provide a single clear approach with step-by-step details.',
        '     - For complex issues (new features, architectural changes): present 2-3 alternative approaches, each with Description, Pros, Cons, and Effort (Low/Medium/High). Include a Recommendation with reasoning.',
        '',
        '     **Key Considerations**: Security, performance, testing requirements, migration needs, backwards compatibility.',
        '',
        '     **Next Steps**: Ordered list of implementation tasks, ready to be executed.',
        '',
        '   - Ask if I want to proceed with the recommended approach, choose a different one, get more details, or make adjustments.',
      ].join('\n');
      const promptFile = path.join(os.tmpdir(), `work2-prompt-${Date.now()}.txt`);
      fs.writeFileSync(promptFile, prompt, 'utf-8');
      args.push('--prompt-file', promptFile);
    }

    const pty = new PtySession(
      process.cwd(),
      termInner,
      contentHeight - 2,
      false,
      { cmd: 'work2', args },
    );
    // Compute expected worktree paths so hook events can match this PTY
    if (config) {
      const branchDir = branchName.replace(/\//g, '-');
      const isGroup = !!config.groups[projectName];
      if (isGroup) {
        const groupRepos = config.groups[projectName];
        pty.searchPaths = groupRepos.map((alias) => {
          const repoPath = config.repos[alias];
          const repoName = path.basename(repoPath);
          return path.join(config.worktreesRoot, projectName, branchDir, repoName);
        });
        // Also add the group parent dir
        pty.searchPaths.push(path.join(config.worktreesRoot, projectName, branchDir));
      } else {
        const repoPath = config.repos[projectName];
        if (repoPath) {
          const repoName = path.basename(repoPath);
          pty.searchPaths = [path.join(config.worktreesRoot, repoName, branchDir)];
        }
      }
      debug('handleCreateWorktree searchPaths', { key, searchPaths: pty.searchPaths });
    }
    ptySessions.current.set(key, pty);

    pty.onExit = (code: number) => {
      debug('onExit work2-tree PTY', { projectName, branchName: branchName, key, code });
      pty.dispose();
      ptySessions.current.delete(key);
      if (activeKeyRef.current === key) {
        setActiveKey(null);
        setFocus(Focus.SESSIONS);
        setTermLines([]);
        setMessage(`Session exited: ${projectName} / ${branchName} (code ${code})`);
      }
      setStatusVersion((v) => v + 1);
      refreshSessions();
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

      // Mouse wheel: scroll the pane under the cursor
      const mouseMatch = MOUSE_SGR_RE.exec(key);
      if (mouseMatch) {
        const button = parseInt(mouseMatch[1], 10);
        const col = parseInt(mouseMatch[2], 10);
        const row = parseInt(mouseMatch[3], 10);
        if (button === 64 || button === 65) {
          const delta = button === 64 ? -1 : 1;
          // Determine which pane the mouse is over based on column and row
          if (col <= sidebarWidth) {
            // Left column — determine which pane by row
            if (row <= sessionPaneHeight) {
              moveSessionCursor(delta);
            } else if (row <= sessionPaneHeight + prPaneHeight) {
              movePrCursor(delta);
            } else if (jiraPaneHeight > 0 && row <= sessionPaneHeight + prPaneHeight + jiraPaneHeight) {
              moveJiraCursor(delta);
            } else {
              moveTaskCursor(delta);
            }
          } else {
            // Right column (terminal) — scroll through scrollback buffer
            const pty = activeKeyRef.current ? ptySessions.current.get(activeKeyRef.current) : undefined;
            if (pty && !pty.exited) {
              const maxScroll = pty.terminal.buffer.active.baseY;
              const newScroll = Math.max(0, Math.min(maxScroll, termScrollBack.current - delta * 3));
              if (newScroll !== termScrollBack.current) {
                termScrollBack.current = newScroll;
                renderTermAtScroll();
              }
            }
          }
          return;
        }
        // Left click (button 0): focus the pane under cursor and select the clicked row
        if (button === 0) {
          if (col <= sidebarWidth) {
            if (row <= sessionPaneHeight) {
              setFocus(Focus.SESSIONS);
              // row 1 = border, content starts at row 2, minus 1 for 0-index
              const clickedIdx = row - 2;
              if (clickedIdx >= 0) setSessionCursor(Math.min(clickedIdx, countSelectable(topRowsRef.current) - 1));
            } else if (row <= sessionPaneHeight + prPaneHeight) {
              setFocus(Focus.PRS);
              const clickedIdx = row - sessionPaneHeight - 2;
              if (clickedIdx >= 0) setPrCursor(Math.min(clickedIdx, countSelectable(prRowsRef.current) - 1));
            } else if (jiraPaneHeight > 0 && row <= sessionPaneHeight + prPaneHeight + jiraPaneHeight) {
              setFocus(Focus.JIRA);
              const clickedIdx = row - sessionPaneHeight - prPaneHeight - 2;
              if (clickedIdx >= 0) setJiraCursor(Math.min(clickedIdx, countSelectable(jiraRowsRef.current) - 1));
            } else {
              setFocus(Focus.TASKS);
              const taskStart = sessionPaneHeight + prPaneHeight + jiraPaneHeight;
              const clickedIdx = row - taskStart - 2;
              if (clickedIdx >= 0) setTaskCursor(Math.min(clickedIdx, countSelectable(taskRowsRef.current) - 1));
            }
          } else {
            const activePty = activeKeyRef.current ? ptySessions.current.get(activeKeyRef.current) : undefined;
            if (activePty && !activePty.exited) setFocus(Focus.TERMINAL);
          }
          setMessage('');
          return;
        }
        // Ignore other mouse events
        return;
      }

      // Branch input mode (top pane)
      if (branchInputRef.current) {
        if (key === '\x1B' || key === '\x03') {
          setBranchInput(null);
          setTopPaneMode(TopPaneMode.PROJECTS);
          setMessage('Esc to go back');
          return;
        }
        if (key === '\r') {
          const { projectName, value, isGroup } = branchInputRef.current;
          setBranchInput(null);
          if (value.trim()) {
            handleCreateWorktree(projectName, value.trim());
          } else if (!isGroup) {
            handleLaunchBaseRepo(projectName);
          } else {
            setMessage('Branch name is required for groups');
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

      // Tab: cycle focus SESSIONS → PRS → JIRA → TERMINAL → SESSIONS
      if (key === TAB_KEY) {
        if (topPaneModeRef.current !== TopPaneMode.SESSIONS) return;
        const activePty = activeKeyRef.current ? ptySessions.current.get(activeKeyRef.current) : undefined;
        const hasTerminal = activePty && !activePty.exited;

        if (focusRef.current === Focus.SESSIONS) {
          setFocus(Focus.PRS);
        } else if (focusRef.current === Focus.PRS) {
          setFocus(acliAvailable ? Focus.JIRA : Focus.TASKS);
        } else if (focusRef.current === Focus.JIRA) {
          setFocus(Focus.TASKS);
        } else if (focusRef.current === Focus.TASKS) {
          if (hasTerminal) setFocus(Focus.TERMINAL);
          else { setFocus(Focus.SESSIONS); syncSessionCursorToActive(); }
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
        // Reset scroll to bottom when typing
        termScrollBack.current = 0;
        ptySessions.current.get(activeKeyRef.current!)?.write(key);
        return;
      }

      // --- Left pane navigation ---
      setMessage('');

      // Global sync (G = shift+g) from any left pane
      if (key === 'G') {
        if (syncing) return;
        setSyncing(true);
        setMessage('Syncing all...');
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
          refreshJira();
          refreshTasks();
          computeConflictsAndMerged(sessionsRef.current);
          setSyncing(false);
          setMessage('All synced');
        })();
        return;
      }

      // Project picker mode (top pane)
      if (topPaneModeRef.current === TopPaneMode.PROJECTS) {
        if (key === '\x1B' || key === '\x03' || key === 'q') {
          setTopPaneMode(TopPaneMode.SESSIONS);
          setSessionCursor(savedSessionCursor);
          setPendingBranch(null);
          setPendingJiraIssue(null);
          setPendingTask(null);
          setMessage('');
          return;
        }
        if (key === '\x1B[A' || key === 'k') { moveSessionCursor(-1); return; }
        if (key === '\x1B[B' || key === 'j') { moveSessionCursor(1); return; }
        if (key === '\r') {
          const row = cursorToRow(topRowsRef.current, sessionCursorRef.current);
          if (row?.type === 'project') {
            const issue = pendingJiraIssueRef.current;
            const task = pendingTaskRef.current;
            if (issue) {
              // Jira flow: generate slug then create worktree in PTY
              setPendingJiraIssue(null);
              setMessage(`Generating branch name for ${issue.key}...`);
              const keyLower = issue.key.toLowerCase();
              generateSlug(issue.summary).then((slug) => {
                const branchName = `task/${keyLower}-${slug}`;
                handleCreateWorktree(row.name, branchName, issue);
              });
            } else if (task) {
              // Task flow: generate slug from task text
              setPendingTask(null);
              setMessage(`Generating branch name for task #${task.id}...`);
              generateSlug(task.text).then((slug) => {
                const branchName = `todo/${slug}`;
                handleCreateWorktree(row.name, branchName);
              });
            } else if (pendingBranchRef.current) {
              const branch = pendingBranchRef.current;
              setPendingBranch(null);
              handleCreateWorktree(row.name, branch);
            } else {
              setTopPaneMode(TopPaneMode.BRANCH_INPUT);
              setBranchInput({ projectName: row.name, value: '', isGroup: row.isGroup });
              setMessage(row.isGroup
                ? 'Type branch name, Enter to create, Esc to cancel'
                : 'Type branch name (empty for base repo), Enter to create, Esc to cancel');
            }
          }
          return;
        }
        return;
      }

      // Tasks pane focused
      if (focusRef.current === Focus.TASKS) {
        // Task input mode
        if (taskInputRef.current !== null) {
          if (key === '\x1B' || key === '\x03') {
            setTaskInput(null);
            setTaskEditId(null);
            setMessage('');
            return;
          }
          if (key === '\r') {
            const text = taskInputRef.current.trim();
            const editId = taskEditIdRef.current;
            setTaskInput(null);
            setTaskEditId(null);
            if (text) {
              if (editId !== null) {
                editTask(editId, text);
                refreshTasks();
                setMessage(`Updated task #${editId}`);
              } else {
                addTask(text);
                refreshTasks();
                setMessage(`Added task: ${text}`);
              }
            }
            return;
          }
          if (key === '\x7F' || key === '\b') {
            setTaskInput((prev) => prev !== null ? prev.slice(0, -1) : null);
            return;
          }
          if (key.charCodeAt(0) < 32) return;
          setTaskInput((prev) => prev !== null ? prev + key : null);
          return;
        }

        if (key === '\x1B[A' || key === 'k') { moveTaskCursor(-1); return; }
        if (key === '\x1B[B' || key === 'j') { moveTaskCursor(1); return; }

        // Toggle done/undone
        if (key === '\r' || key === 'x') {
          const row = cursorToRow(taskRowsRef.current, taskCursorRef.current);
          if (row?.type === 'task') {
            if (row.task.done) {
              uncompleteTask(row.task.id);
            } else {
              completeTask(row.task.id);
            }
            refreshTasks();
          }
          return;
        }

        // Add new task
        if (key === 'a') {
          setTaskInput('');
          setMessage('Type task, Enter to add, Esc to cancel');
          return;
        }

        // Edit task
        if (key === 'e') {
          const row = cursorToRow(taskRowsRef.current, taskCursorRef.current);
          if (row?.type === 'task') {
            setTaskEditId(row.task.id);
            setTaskInput(row.task.text);
            setMessage('Edit task, Enter to save, Esc to cancel');
          }
          return;
        }

        // Create worktree for task
        if (key === 'w') {
          const row = cursorToRow(taskRowsRef.current, taskCursorRef.current);
          if (row?.type === 'task') {
            setPendingTask(row.task);
            setSavedSessionCursor(sessionCursorRef.current);
            setFocus(Focus.SESSIONS);
            setTopPaneMode(TopPaneMode.PROJECTS);
            setSessionCursor(0);
            setMessage(`Select project for task #${row.task.id}`);
          }
          return;
        }

        // Remove task
        if (key === 'd') {
          const row = cursorToRow(taskRowsRef.current, taskCursorRef.current);
          if (row?.type === 'task') {
            removeTask(row.task.id);
            refreshTasks();
            setMessage(`Removed: ${row.task.text}`);
          }
          return;
        }

        if (key === 'g') {
          refreshTasks();
          setMessage('Tasks refreshed');
          return;
        }

        if (key === '\x03' || key === 'q') {
          for (const pty of ptySessions.current.values()) pty.dispose();
          ptySessions.current.clear();
          onExit();
          return;
        }

        return;
      }

      // Jira pane focused
      if (focusRef.current === Focus.JIRA) {
        if (key === '\x1B[A' || key === 'k') { moveJiraCursor(-1); return; }
        if (key === '\x1B[B' || key === 'j') { moveJiraCursor(1); return; }

        if (key === '\r') {
          const row = cursorToRow(jiraRowsRef.current, jiraCursorRef.current);
          if (row?.type === 'jira') {
            const issue = row.issue;

            // Check if any existing session is linked to this Jira issue
            const existing = sessionsRef.current.find((s) =>
              s.jiraKey === issue.key,
            );
            if (existing) {
              setFocus(Focus.SESSIONS);
              activateSession(existing);
              setMessage(`Resumed: ${existing.target}/${existing.branch}`);
            } else {
              // Show project picker immediately; slug generation happens after selection
              setPendingJiraIssue(issue);
              setSavedSessionCursor(sessionCursorRef.current);
              setFocus(Focus.SESSIONS);
              setTopPaneMode(TopPaneMode.PROJECTS);
              setSessionCursor(0);
              setMessage(`Select project for ${issue.key}`);
            }
          }
          return;
        }

        if (key === 'o') {
          const row = cursorToRow(jiraRowsRef.current, jiraCursorRef.current);
          if (row?.type === 'jira' && row.issue.url) {
            openUrl(row.issue.url);
            setMessage(`Opened: ${row.issue.key}`);
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
          setMessage('Syncing Jira...');
          (async () => {
            await refreshJira();
            setSyncing(false);
            setMessage('Jira synced');
          })();
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

        if (key === 'o') {
          const row = cursorToRow(prRowsRef.current, prCursorRef.current);
          if (row?.type === 'pr' && row.pr.url) {
            openUrl(row.pr.url);
            setMessage(`Opened: ${row.pr.title}`);
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
          setMessage('Syncing PRs...');
          (async () => {
            await refreshPrs();
            setSyncing(false);
            setMessage('PRs synced');
          })();
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
        setMessage(`Removing: ${s.target} / ${s.branch}...`);

        // Spawn work2 remove in a PTY so output shows in the right pane
        const removeKey = `remove:${s.target}:${s.branch}`;
        const removePty = new PtySession(
          process.cwd(),
          termInner,
          contentHeight - 2,
          false,
          { cmd: 'work2', args: ['remove', s.target, s.branch, '--force'] },
        );
        ptySessions.current.set(removeKey, removePty);
        removePty.onExit = (code: number) => {
          debug('onExit remove PTY', { target: s.target, branch: s.branch, removeKey, code });
          removePty.dispose();
          ptySessions.current.delete(removeKey);
          if (activeKeyRef.current === removeKey) {
            setActiveKey(null);
            setTermLines([]);
            setFocus(Focus.SESSIONS);
          }
          setStatusVersion((v) => v + 1);
          refreshSessions();
          setMessage(`Removed: ${s.target} / ${s.branch}`);
        };
        removePty.onStatusChange = () => setStatusVersion((v) => v + 1);
        connectPty(removeKey, removePty);
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
        setMessage('Syncing sessions...');
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
          computeConflictsAndMerged(sessionsRef.current);
          setSyncing(false);
          setMessage('Sessions synced');
        })();
        return;
      }

      if (key === 'r') {
        refreshSessions();
        refreshPrs();
        refreshJira();
        refreshTasks();
        if (!ghAvailable) setMessage('Refreshed');
        return;
      }
    };

    process.stdin.on('data', handler);
    return () => { process.stdin.removeListener('data', handler); };
  }, [onExit, activateSession, refreshSessions, refreshPrs, refreshJira, refreshTasks, moveSessionCursor, movePrCursor, moveJiraCursor, moveTaskCursor, syncSessionCursorToActive, handleCreateWorktree, savedSessionCursor, config, computeConflictsAndMerged, syncing, ghAvailable, prMap]);

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

  // Periodic heap monitoring and memory maintenance
  useEffect(() => {
    const interval = setInterval(() => {
      const heap = process.memoryUsage();
      const stats = v8.getHeapStatistics();
      let activePtys = 0;
      // Clear scrollback for non-active PTYs to free memory
      for (const [key, pty] of ptySessions.current) {
        if (pty.exited) continue;
        activePtys++;
        if (key !== activeKeyRef.current) {
          pty.clearScrollback();
        }
      }
      debug('HEAP', {
        rss: Math.round(heap.rss / 1024 / 1024) + 'MB',
        heapUsed: Math.round(heap.heapUsed / 1024 / 1024) + 'MB',
        heapTotal: Math.round(heap.heapTotal / 1024 / 1024) + 'MB',
        external: Math.round(heap.external / 1024 / 1024) + 'MB',
        heapLimit: Math.round(stats.heap_size_limit / 1024 / 1024) + 'MB',
        activePtys,
      });
    }, 5 * 60 * 1000);
    return () => clearInterval(interval);
  }, []);

  // Repaint direct terminal content after every Ink render (Ink overwrites the screen)
  useEffect(() => {
    if (activeKey && lastDirectLines.current.length > 0) {
      // Small delay to ensure Ink has finished writing to stdout
      setTimeout(() => {
        if (activeKeyRef.current && lastDirectLines.current.length > 0) {
          writeTermDirect(lastDirectLines.current);
        }
      }, 0);
    } else {
      lastDirectLines.current = [];
    }
  });

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
            activeKey={activeKey}
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
          {jiraPaneHeight > 0 && (
            <JiraPane
              jiraRows={jiraRows}
              cursor={jiraCursor}
              focused={focus === Focus.JIRA}
              width={sidebarWidth}
              height={jiraPaneHeight}
            />
          )}
          <TaskPane
            taskRows={taskRows}
            cursor={taskCursor}
            focused={focus === Focus.TASKS}
            width={sidebarWidth}
            height={taskPaneHeight}
            taskInput={taskInput}
          />
        </Box>
        <TerminalPane
          lines={termLines}
          width={termWidth}
          height={contentHeight}
          focused={focus === Focus.TERMINAL}
          placeholder={placeholder}
          title="Terminal"
        />
      </Box>
      <StatusBar message={message} pane={focus === Focus.TERMINAL ? 'terminal' : focus === Focus.PRS ? 'prs' : focus === Focus.JIRA ? 'jira' : focus === Focus.TASKS ? 'tasks' : 'sessions'} syncing={syncing} />
    </Box>
  );
}
