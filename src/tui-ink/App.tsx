import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { Box } from 'ink';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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
import { rebaseOntoMainAsync, countConflictsAsync, isBranchMergedAsync, fetchRemoteAsync } from '../core/git.js';
import { fetchAllPullRequests, isGhAvailable, type BranchPrMap } from '../core/pr.js';
import { fetchMyJiraIssues, isAcliAvailable, type JiraIssue } from '../core/jira.js';
import { getTasks, addTask, completeTask, uncompleteTask, removeTask, editTask, getTasksPath_, type Task } from '../core/tasks.js';
import { getAiTool, buildAiLaunchArgs } from '../core/ai-launcher.js';
import { openUrl } from '../utils/platform.js';
import { PtySession, type SessionStatus } from '../tui/session.js';
import { debug } from '../core/logger.js';
import { HookServer, type HookEvent } from '../core/hook-server.js';
import { notifyDesktop, notifyKindForEvent } from '../core/notifier.js';
import { runStatusHooks } from '../core/status-hooks.js';
import { renderBufferLines } from './renderer-lines.js';
import {
  Sidebar, PrPane, JiraPane, TaskPane,
  buildSessionRows, buildProjectRows, buildPrRows, buildJiraRows, buildTaskRows,
  countSelectable, cursorToRow, visualRowToCursor, computeScrollOffset, sessionKey,
  type SidebarRow,
} from './Sidebar.js';
import { TerminalPane } from './TerminalPane.js';
import { StatusBar } from './StatusBar.js';
import { HelpOverlay } from './HelpOverlay.js';
import { splitInputChunks, editLine, KEYS, type LineState } from './line-editor.js';

const DETACH_KEY = '\x1D'; // Ctrl+]
const TAB_KEY = '\t';
const RENDER_INTERVAL_MS = 50;

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


/** Check if Claude has an existing conversation for a directory. */
function hasClaudeConversation(dir: string): boolean {
  try {
    const resolved = path.resolve(dir);
    // Claude Code encodes project dirs by replacing EVERY non-alphanumeric
    // char with '-' (verified against ~/.claude/projects: ".claude" → "-claude").
    const projectDir = resolved.replace(/[^a-zA-Z0-9-]/g, '-');
    const claudeProjectPath = path.join(os.homedir(), '.claude', 'projects', projectDir);
    if (!fs.existsSync(claudeProjectPath)) return false;
    const files = fs.readdirSync(claudeProjectPath);
    return files.some((f) => f.endsWith('.jsonl'));
  } catch {
    return false;
  }
}

/**
 * Stable notification-dedup key for a PTY: its resolved launch directory.
 * findPtyByCwd matches hook cwds by prefix against this, so deriving the key
 * here collapses all sub-repo / group child cwds onto the one PtySession.
 */
function ptyDedupKey(pty: PtySession): string {
  return path.resolve(pty.cwd).toLowerCase();
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
      { encoding: 'utf-8', timeout: 10000, windowsHide: true },
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

/**
 * Module-level cleanup registry. App registers its PTY/HookServer cleanup
 * here so that index.tsx's signal handlers (SIGINT/SIGTERM/uncaughtException)
 * can run it before calling process.exit(), which otherwise leaves orphaned
 * `claude` processes and stale hook entries in ~/.claude/settings.json.
 */
let dashboardCleanup: (() => void) | null = null;
export function runDashboardCleanup(): void {
  dashboardCleanup?.();
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
  const [taskInput, setTaskInput] = useState<LineState | null>(null);
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
  const [branchInput, setBranchInput] = useState<{ projectName: string; value: string; pos: number; isGroup: boolean } | null>(null);
  const [pendingBranch, setPendingBranch] = useState<string | null>(null);
  const [pendingJiraIssue, setPendingJiraIssue] = useState<JiraIssue | null>(null);
  const [pendingTask, setPendingTask] = useState<Task | null>(null);
  const [savedSessionCursor, setSavedSessionCursor] = useState(0);
  const [showHelp, setShowHelp] = useState(false);
  /** Session-list filter; `editing` = '/' input mode is active. */
  const [filter, setFilter] = useState<{ value: string; editing: boolean } | null>(null);
  /** Session key armed for removal — second `d` confirms (destructive op). */
  const [pendingRemoveKey, setPendingRemoveKey] = useState<string | null>(null);
  /** State mirror of termScrollBack (ref) so the UI can show a paused badge. */
  const [termScroll, setTermScroll] = useState(0);
  const setScrollBack = useCallback((n: number) => {
    termScrollBack.current = n;
    setTermScroll(n);
  }, []);

  const localBranches = useMemo(() => new Set(sessions.map((s) => s.branch)), [sessions]);
  const projectRows = useMemo(() => buildProjectRows(projects), [projects]);
  const prRows = useMemo(() => buildPrRows(prMap), [prMap]);
  const jiraRows = useMemo(() => buildJiraRows(jiraIssues), [jiraIssues]);
  const taskRows = useMemo(() => buildTaskRows(tasks), [tasks]);

  /** Sessions narrowed by the `/` filter (matches branch or target). */
  const filteredSessions = useMemo(() => {
    const q = filter?.value.trim().toLowerCase();
    if (!q) return sessions;
    return sessions.filter(
      (s) => s.branch.toLowerCase().includes(q) || s.target.toLowerCase().includes(q),
    );
  }, [sessions, filter]);

  const ptySessions = useRef(new Map<string, PtySession>());
  const sessionRows = useMemo(() => {
    const sMap = new Map<string, SessionStatus>();
    for (const [key, pty] of ptySessions.current) {
      if (pty.exited) continue;
      sMap.set(key, pty.status);
    }
    return buildSessionRows(filteredSessions, sMap);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filteredSessions, statusVersion]);
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
  const acliAvailableRef = useRef(acliAvailable);
  acliAvailableRef.current = acliAvailable;
  const showHelpRef = useRef(showHelp);
  showHelpRef.current = showHelp;
  const filterRef = useRef(filter);
  filterRef.current = filter;
  const pendingRemoveRef = useRef(pendingRemoveKey);
  pendingRemoveRef.current = pendingRemoveKey;
  /** Guards against overlapping `u` rebases (async, may take seconds). */
  const rebasingRef = useRef(false);
  const hookServerRef = useRef<HookServer | null>(null);
  // Sessions already alerted for their current idle period (notification dedupe).
  const notifiedSessionsRef = useRef<Set<string>>(new Set());

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

  // Layout snapshot for the stdin handler — refreshed every render so mouse
  // hit-testing stays correct after resizes / pane-visibility changes.
  const layoutRef = useRef({ sidebarWidth, termInner, contentHeight, sessionPaneHeight, prPaneHeight, jiraPaneHeight, taskPaneHeight });
  layoutRef.current = { sidebarWidth, termInner, contentHeight, sessionPaneHeight, prPaneHeight, jiraPaneHeight, taskPaneHeight };

  // Update terminal title — icon + count per state, hide if 0
  useEffect(() => {
    let attentionCount = 0;
    let idleCount = 0;
    let runningCount = 0;
    for (const pty of ptySessions.current.values()) {
      if (pty.exited) continue;
      if (pty.status === 'attention') attentionCount++;
      else if (pty.status === 'idle') idleCount++;
      else runningCount++;
    }
    const parts: string[] = [];
    if (attentionCount > 0) parts.push(`🟡 ${attentionCount}`);
    if (idleCount > 0) parts.push(`🔵 ${idleCount}`);
    if (runningCount > 0) parts.push(`🟢 ${runningCount}`);
    const title = parts.length > 0 ? parts.join('  ') : 'work dash';
    process.stdout.write(`\x1B]0;${title}\x07`);
  }, [statusVersion, activeKey]);

  const computeGeneration = useRef(0);
  const computeConflictsAndMerged = useCallback((sessionList: WorktreeSession[]) => {
    const generation = ++computeGeneration.current;

    (async () => {
      const counts = new Map<string, number>();
      const merged = new Set<string>();

      for (const s of sessionList) {
        if (computeGeneration.current !== generation) return; // cancelled

        const existing = s.paths.find((p) => fs.existsSync(p));
        if (!existing || !s.branch) continue;
        const key = sessionKey(s);
        try {
          const c = await countConflictsAsync(s.branch, existing);
          if (c > 0) counts.set(key, c);
        } catch { /* ignore */ }
        try {
          const { merged: isMerged } = await isBranchMergedAsync(s.branch, existing);
          if (isMerged) merged.add(key);
        } catch { /* ignore */ }
      }

      if (computeGeneration.current === generation) {
        setConflictCounts(counts);
        setMergedSet(merged);
      }
    })();
  }, []);

  /** Returns a promise so callers can report "synced" only when done. */
  const refreshPrs = useCallback((): Promise<void> => {
    if (!ghAvailable || !config || prFetching.current) return Promise.resolve();
    prFetching.current = true;
    setMessage('Loading PRs...');
    return fetchAllPullRequests(config.repos)
      .then((prs) => {
        setPrMap(prs);
        setMessage('');
      })
      .catch(() => {})
      .finally(() => { prFetching.current = false; });
  }, [ghAvailable, config]);

  /** Returns a promise so callers can report "synced" only when done. */
  const refreshJira = useCallback((): Promise<void> => {
    if (!acliAvailable || jiraFetching.current) return Promise.resolve();
    jiraFetching.current = true;
    return fetchMyJiraIssues()
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

  // Memoized so the memoized Sidebar isn't invalidated by a fresh Map each
  // render (terminal output re-renders App every 50ms while Claude streams).
  const statusMap = useMemo(() => {
    const map = new Map<string, SessionStatus>();
    for (const [key, pty] of ptySessions.current) {
      if (pty.exited) continue;
      map.set(key, pty.status);
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
        // The active session may have changed within the debounce window —
        // never paint a stale PTY's buffer over the current one.
        const activeKey = activeKeyRef.current;
        if (!activeKey || ptySessions.current.get(activeKey) !== pty) return;
        // If scrolled back, don't auto-update (user is reading scrollback)
        if (termScrollBack.current > 0) return;
        const lines = renderBufferLines(pty.terminal.buffer.active, termInner, contentHeight - 2);
        setTermLines(lines);
      } catch { /* buffer not ready */ }
    }, RENDER_INTERVAL_MS);
  }, [termInner, contentHeight]);

  /** Re-render terminal at current scroll offset. */
  const renderTermAtScroll = useCallback(() => {
    if (!activeKeyRef.current) return;
    const pty = ptySessions.current.get(activeKeyRef.current);
    if (!pty || pty.exited) return;
    try {
      setTermLines(renderBufferLines(pty.terminal.buffer.active, termInner, contentHeight - 2, termScrollBack.current));
    } catch { /* */ }
  }, [termInner, contentHeight]);

  /** Scroll the active terminal's history. Positive = up (into history). */
  const scrollTerminal = useCallback((linesUp: number) => {
    const pty = activeKeyRef.current ? ptySessions.current.get(activeKeyRef.current) : undefined;
    if (!pty || pty.exited) return;
    const maxScroll = pty.terminal.buffer.active.baseY;
    const next = Math.max(0, Math.min(maxScroll, termScrollBack.current + linesUp));
    if (next !== termScrollBack.current) {
      setScrollBack(next);
      renderTermAtScroll();
    }
  }, [setScrollBack, renderTermAtScroll]);

  const findPtyByCwd = useCallback((cwd: string): PtySession | undefined => {
    const normalized = path.resolve(cwd).toLowerCase();
    for (const pty of ptySessions.current.values()) {
      if (pty.exited) continue;
      // Match if hook cwd is inside the PTY's launch directory
      if (normalized.startsWith(path.resolve(pty.cwd).toLowerCase())) return pty;
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

  // Watch history file for changes (e.g. when work tree creates a new session)
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
    const hookServer = new HookServer({
      owner: 'dash',
      callback: (cwd: string, event: HookEvent) => {
        const pty = findPtyByCwd(cwd);
        if (!pty) return;
        if (event === 'notification') {
          pty.setStatus('attention'); // explicitly waiting on user input
        } else if (event === 'stop') {
          pty.setStatus('idle'); // turn finished
        } else if (event === 'prompt_submit') {
          pty.setStatus('running');
        }
        // Desktop notification (opt-in; no-op when disabled/unsupported).
        // De-duped per session per idle period via notifyKindForEvent, so the
        // first idle alerts and repeated Stop events don't spam — independent
        // of PtySession's initial idle state.
        //
        // The dedup key is derived from the resolved PtySession identity
        // (its launch dir), NOT the raw hook cwd. findPtyByCwd matches by
        // prefix, so multiple sub-repo / group cwds resolve to one PtySession;
        // keying off the raw cwd would let that single session notify multiple
        // times for distinct child paths.
        const dedupKey = ptyDedupKey(pty);
        const kind = notifyKindForEvent(
          event,
          dedupKey,
          notifiedSessionsRef.current,
        );
        if (kind) {
          notifyDesktop(path.basename(pty.cwd), kind, {
            enabled: config?.notifications === true,
          });
          // User-configurable status-change commands (opt-in via config).
          // Fire-and-forget; independent of the desktop-notification path.
          // Use the resolved PtySession launch dir (pty.cwd), not the raw hook
          // cwd, so a group/sub-repo cwd doesn't run the hook in a sub-repo
          // directory or expose a sub-repo basename as $WORK_SESSION — matching
          // the notifyDesktop call above.
          runStatusHooks(
            kind,
            pty.cwd,
            path.basename(pty.cwd),
            config?.statusHooks,
          );
        }
      },
    });
    hookServerRef.current = hookServer;
    hookServer.start().catch(() => {});
    return () => {
      if (hookServerRef.current === hookServer) hookServerRef.current = null;
      hookServer.stop().catch(() => {});
    };
  }, [findPtyByCwd]);

  // Reliable cleanup that also runs on signal/crash exit (not just React
  // unmount). Disposes every live PTY (kills spawned `claude` processes) and
  // restores the injected Claude hook settings synchronously via
  // hookServer.cleanupSync(). Idempotent — guarded against double-run.
  useEffect(() => {
    let done = false;
    const cleanup = () => {
      if (done) return;
      done = true;
      try {
        for (const pty of ptySessions.current.values()) {
          try { pty.dispose(); } catch { /* already gone */ }
        }
        ptySessions.current.clear();
        notifiedSessionsRef.current.clear();
      } catch { /* best effort */ }
      // cleanupSync() is synchronous fs work, safe in a process 'exit' handler.
      try { hookServerRef.current?.cleanupSync(); } catch { /* best effort */ }
    };
    dashboardCleanup = cleanup;
    process.once('exit', cleanup);
    return () => {
      process.removeListener('exit', cleanup);
      if (dashboardCleanup === cleanup) dashboardCleanup = null;
    };
  }, []);

  /** Switch the right pane to show a different session's terminal. */
  const switchDisplay = useCallback((s: WorktreeSession) => {
    const k = sessionKey(s);
    if (activeKeyRef.current === k) return;

    setScrollBack(0);
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
    if (activeKeyRef.current && activeKeyRef.current !== key) {
      ptySessions.current.get(activeKeyRef.current)?.setOutputHandler(undefined);
    }
    setScrollBack(0);
    setActiveKey(key);
    setFocus(Focus.TERMINAL);
    pty.resize(termInner, contentHeight - 2);
    pty.setOutputHandler(() => scheduleTerminalRender(pty));
    try {
      setTermLines(renderBufferLines(pty.terminal.buffer.active, termInner, contentHeight - 2));
    } catch { /* */ }
  }, [termInner, contentHeight, scheduleTerminalRender]);

  /** Register a PTY: wire up exit/status handlers and track in the sessions map. */
  const registerPty = useCallback((key: string, pty: PtySession, exitMessage: string, onExitExtra?: () => void) => {
    ptySessions.current.set(key, pty);
    pty.onExit = (code: number) => {
      debug('onExit PTY', { key, code });
      // Evict the notification-dedup entry so a future PTY for the same dir
      // re-arms (and the Set doesn't grow unbounded across the session).
      notifiedSessionsRef.current.delete(ptyDedupKey(pty));
      pty.dispose();
      ptySessions.current.delete(key);
      if (activeKeyRef.current === key) {
        setActiveKey(null);
        setFocus(Focus.SESSIONS);
        setTermLines([]);
        setMessage(`${exitMessage} (code ${code})`);
      }
      setStatusVersion((v) => v + 1);
      onExitExtra?.();
    };
    pty.onStatusChange = () => setStatusVersion((v) => v + 1);
    setStatusVersion((v) => v + 1);
  }, []);

  const startPtyForSession = useCallback((s: WorktreeSession, key: string) => {
    const existing = s.paths.find((p) => fs.existsSync(p));
    if (!existing) {
      setMessage('Session path no longer exists');
      refreshSessions();
      return;
    }

    const dir = s.isGroup ? path.dirname(existing) : existing;
    const resume = hasClaudeConversation(dir);
    const tool = getAiTool(config ?? {});
    const pty = new PtySession(dir, termInner, contentHeight - 2, undefined, { tool, unsafe, resume, port: s.port });
    void upsertSession(s.target, s.isGroup, s.branch, s.paths).catch((err) =>
      setMessage(`Failed to save session: ${(err as Error).message}`),
    );
    registerPty(key, pty, `Session exited: ${s.target} / ${s.branch}`);
    return pty;
  }, [unsafe, termInner, contentHeight, refreshSessions, registerPty, config]);

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
    void upsertSession(projectName, false, branch, [repoPath]).catch((err) =>
      setMessage(`Failed to save session: ${(err as Error).message}`),
    );
    refreshSessions();

    const tool = getAiTool(config);
    const pty = new PtySession(repoPath, termInner, contentHeight - 2, undefined, { tool, unsafe });
    registerPty(key, pty, `Session exited: ${projectName} (base)`);
    connectPty(key, pty);
    setMessage(`Launched: ${projectName} (base repo)`);
  }, [unsafe, termInner, contentHeight, connectPty, refreshSessions, savedSessionCursor, config]);

  /** Create a worktree (visible in terminal pane) then launch Claude in it. */
  const handleCreateWorktree = useCallback((projectName: string, branchName: string, jiraIssue?: JiraIssue | null) => {
    setTopPaneMode(TopPaneMode.SESSIONS);
    setSessionCursor(savedSessionCursor);

    if (!config) { setMessage('No config loaded'); return; }

    const key = `${projectName}:${branchName}`;

    // Build prompt file for Jira issues
    let promptFile: string | undefined;
    if (jiraIssue) {
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
      promptFile = path.join(os.tmpdir(), `work-prompt-${Date.now()}.txt`);
      fs.writeFileSync(promptFile, prompt, 'utf-8');
    }

    // Phase 1: Run `work tree --setup-only` in a PTY to show setup progress
    const setupArgs = ['tree', projectName, branchName, '--setup-only'];
    if (jiraIssue?.key) setupArgs.push('--jira-key', jiraIssue.key);
    const setupPty = new PtySession(process.cwd(), termInner, contentHeight - 2,
      { cmd: 'work', args: setupArgs });
    ptySessions.current.set(key, setupPty);
    setStatusVersion((v) => v + 1);

    setupPty.onExit = (code: number) => {
      setupPty.dispose();
      ptySessions.current.delete(key);

      if (code !== 0) {
        setMessage(`Failed to create worktree: ${projectName}/${branchName}`);
        if (activeKeyRef.current === key) {
          setActiveKey(null);
          setFocus(Focus.SESSIONS);
          setTermLines([]);
        }
        setStatusVersion((v) => v + 1);
        return;
      }

      // Phase 2: Setup succeeded — refresh sessions and launch Claude in the worktree
      refreshSessions();
      const sessions = getRecentSessions(loadHistory(), 50);
      const session = sessions.find((s) => s.target === projectName && s.branch === branchName);
      if (!session) {
        setMessage(`Worktree created but session not found: ${projectName}/${branchName}`);
        setStatusVersion((v) => v + 1);
        return;
      }

      const existing = session.paths.find((p) => fs.existsSync(p));
      if (!existing) {
        setMessage(`Worktree path not found after setup`);
        setStatusVersion((v) => v + 1);
        return;
      }

      const launchDir = session.isGroup ? path.dirname(existing) : existing;
      const tool = getAiTool(config);
      const aiPty = new PtySession(launchDir, termInner, contentHeight - 2, undefined,
        { tool, unsafe, promptFile, port: session.port });
      registerPty(key, aiPty, `Session exited: ${projectName} / ${branchName}`);
      connectPty(key, aiPty);
      setMessage(`Launched: ${projectName}/${branchName}`);
    };

    setMessage(`Creating: ${projectName}/${branchName}...`);
    connectPty(key, setupPty);
  }, [unsafe, termInner, contentHeight, refreshSessions, connectPty, registerPty, savedSessionCursor, config]);

  // Raw stdin input handling
  useEffect(() => {
    /** Handle one decoded token (escape sequence, control char, or text run). */
    const handleKey = (key: string) => {
      // Layout snapshot — read via ref so mouse hit-testing survives resizes
      const layout = layoutRef.current;

      // Mouse wheel: scroll the pane under the cursor
      const mouseMatch = MOUSE_SGR_RE.exec(key);
      if (mouseMatch) {
        const button = parseInt(mouseMatch[1], 10);
        const col = parseInt(mouseMatch[2], 10);
        const row = parseInt(mouseMatch[3], 10);
        if (button === 64 || button === 65) {
          const delta = button === 64 ? -1 : 1;
          // Determine which pane the mouse is over based on column and row
          if (col <= layout.sidebarWidth) {
            // Left column — determine which pane by row
            if (row <= layout.sessionPaneHeight) {
              moveSessionCursor(delta);
            } else if (row <= layout.sessionPaneHeight + layout.prPaneHeight) {
              movePrCursor(delta);
            } else if (layout.jiraPaneHeight > 0 && row <= layout.sessionPaneHeight + layout.prPaneHeight + layout.jiraPaneHeight) {
              moveJiraCursor(delta);
            } else {
              moveTaskCursor(delta);
            }
          } else {
            // Right column (terminal) — scroll through scrollback buffer
            scrollTerminal(-delta * 3);
          }
          return;
        }
        // Left click (button 0): focus the pane under cursor and select the clicked row
        if (button === 0) {
          if (col <= layout.sidebarWidth) {
            // row is 1-indexed, each pane has a 1-row top border, so content
            // starts at paneStart + 2. Clicked visual row + the pane's scroll
            // offset = the actual row index in the full rows array.
            if (row <= layout.sessionPaneHeight) {
              setFocus(Focus.SESSIONS);
              const visualIdx = row - 2; // skip top border
              if (visualIdx >= 0) {
                const offset = computeScrollOffset(topRowsRef.current, sessionCursorRef.current, layout.sessionPaneHeight - 2);
                setSessionCursor(visualRowToCursor(topRowsRef.current, visualIdx + offset));
              }
            } else if (row <= layout.sessionPaneHeight + layout.prPaneHeight) {
              setFocus(Focus.PRS);
              const visualIdx = row - layout.sessionPaneHeight - 2;
              if (visualIdx >= 0) {
                const offset = computeScrollOffset(prRowsRef.current, prCursorRef.current, layout.prPaneHeight - 2);
                setPrCursor(visualRowToCursor(prRowsRef.current, visualIdx + offset));
              }
            } else if (layout.jiraPaneHeight > 0 && row <= layout.sessionPaneHeight + layout.prPaneHeight + layout.jiraPaneHeight) {
              setFocus(Focus.JIRA);
              const visualIdx = row - layout.sessionPaneHeight - layout.prPaneHeight - 2;
              if (visualIdx >= 0) {
                const offset = computeScrollOffset(jiraRowsRef.current, jiraCursorRef.current, layout.jiraPaneHeight - 2);
                setJiraCursor(visualRowToCursor(jiraRowsRef.current, visualIdx + offset));
              }
            } else {
              setFocus(Focus.TASKS);
              const taskStart = layout.sessionPaneHeight + layout.prPaneHeight + layout.jiraPaneHeight;
              const visualIdx = row - taskStart - 2;
              if (visualIdx >= 0) {
                const offset = computeScrollOffset(taskRowsRef.current, taskCursorRef.current, layout.taskPaneHeight - 2);
                setTaskCursor(visualRowToCursor(taskRowsRef.current, visualIdx + offset));
              }
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

      // Help overlay: swallow everything; ?, esc or q closes
      if (showHelpRef.current) {
        if (key === '?' || key === KEYS.ESC || key === 'q' || key === KEYS.CTRL_C) {
          setShowHelp(false);
        }
        return;
      }

      // Branch input mode (top pane) — full line editing via editLine
      if (branchInputRef.current) {
        const { projectName, isGroup, value, pos } = branchInputRef.current;
        const { state, action } = editLine({ value, pos }, key);
        if (action === 'cancel') {
          setBranchInput(null);
          setTopPaneMode(TopPaneMode.PROJECTS);
          setMessage('Esc to go back');
          return;
        }
        if (action === 'submit') {
          setBranchInput(null);
          if (state.value.trim()) {
            handleCreateWorktree(projectName, state.value.trim());
          } else if (!isGroup) {
            handleLaunchBaseRepo(projectName);
          } else {
            setMessage('Branch name is required for groups');
          }
          return;
        }
        setBranchInput({ projectName, isGroup, ...state });
        return;
      }

      // Session-filter input mode (`/` in the sessions pane)
      if (filterRef.current?.editing) {
        // Arrows still navigate the (live-filtered) list while typing
        if (key === KEYS.UP) { moveSessionCursor(-1); return; }
        if (key === KEYS.DOWN) { moveSessionCursor(1); return; }
        const current = filterRef.current.value;
        const { state, action } = editLine({ value: current, pos: current.length }, key);
        if (action === 'cancel') {
          setFilter(null);
          setSessionCursor(0);
          setMessage('');
          return;
        }
        if (action === 'submit' || key === TAB_KEY) {
          const value = current.trim();
          setFilter(value ? { value, editing: false } : null);
          setMessage(value ? `Filtering: ${value} (esc clears)` : '');
          return;
        }
        if (state.value !== current) {
          setFilter({ value: state.value, editing: true });
          setSessionCursor(0);
        }
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
          setFocus(acliAvailableRef.current ? Focus.JIRA : Focus.TASKS);
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
        // Keyboard scrollback (mirrors the mouse wheel)
        if (key === KEYS.PAGE_UP) {
          scrollTerminal(Math.max(1, layout.contentHeight - 3));
          return;
        }
        if (key === KEYS.PAGE_DOWN) {
          scrollTerminal(-Math.max(1, layout.contentHeight - 3));
          return;
        }
        // Reset scroll to bottom when typing
        if (termScrollBack.current > 0) setScrollBack(0);
        ptySessions.current.get(activeKeyRef.current!)?.write(key);
        return;
      }

      // --- Left pane navigation ---
      setMessage('');

      // Any key other than a second `d` disarms a pending worktree removal
      if (pendingRemoveRef.current && key !== 'd') setPendingRemoveKey(null);

      // Help overlay from any left pane
      if (key === '?') {
        setShowHelp(true);
        return;
      }

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
          await Promise.all([refreshPrs(), refreshJira()]);
          refreshTasks();
          computeConflictsAndMerged(sessionsRef.current);
          setSyncing(false);
          setMessage('All synced');
        })();
        return;
      }

      // Page jumps in the focused left pane (skip while typing a task)
      if (taskInputRef.current === null) {
        const pageJump = (dir: 1 | -1, full: boolean) => {
          const heightFor =
            focusRef.current === Focus.PRS ? layout.prPaneHeight :
            focusRef.current === Focus.JIRA ? layout.jiraPaneHeight :
            focusRef.current === Focus.TASKS ? layout.taskPaneHeight :
            layout.sessionPaneHeight;
          const page = Math.max(1, full ? heightFor - 2 : Math.floor((heightFor - 2) / 2));
          const delta = page * dir;
          if (focusRef.current === Focus.PRS) movePrCursor(delta);
          else if (focusRef.current === Focus.JIRA) moveJiraCursor(delta);
          else if (focusRef.current === Focus.TASKS) moveTaskCursor(delta);
          else moveSessionCursor(delta);
        };
        if (key === KEYS.PAGE_UP) { pageJump(-1, true); return; }
        if (key === KEYS.PAGE_DOWN) { pageJump(1, true); return; }
        if (key === KEYS.CTRL_U) { pageJump(-1, false); return; }
        if (key === KEYS.CTRL_D) { pageJump(1, false); return; }
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
              setBranchInput({ projectName: row.name, value: '', pos: 0, isGroup: row.isGroup });
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
        // Task input mode — full line editing via editLine
        if (taskInputRef.current !== null) {
          const { state, action } = editLine(taskInputRef.current, key);
          if (action === 'cancel') {
            setTaskInput(null);
            setTaskEditId(null);
            setMessage('');
            return;
          }
          if (action === 'submit') {
            const text = taskInputRef.current.value.trim();
            const editId = taskEditIdRef.current;
            setTaskInput(null);
            setTaskEditId(null);
            if (text) {
              if (editId !== null) {
                void editTask(editId, text).then(() => refreshTasks());
                setMessage(`Updated task #${editId}`);
              } else {
                void addTask(text).then(() => refreshTasks());
                setMessage(`Added task: ${text}`);
              }
            }
            return;
          }
          setTaskInput(state);
          return;
        }

        if (key === '\x1B[A' || key === 'k') { moveTaskCursor(-1); return; }
        if (key === '\x1B[B' || key === 'j') { moveTaskCursor(1); return; }

        // Toggle done/undone
        if (key === '\r' || key === 'x') {
          const row = cursorToRow(taskRowsRef.current, taskCursorRef.current);
          if (row?.type === 'task') {
            const p = row.task.done
              ? uncompleteTask(row.task.id)
              : completeTask(row.task.id);
            void p.then(() => refreshTasks());
          }
          return;
        }

        // Add new task
        if (key === 'a') {
          setTaskInput({ value: '', pos: 0 });
          setMessage('Type task, Enter to add, Esc to cancel');
          return;
        }

        // Edit task
        if (key === 'e') {
          const row = cursorToRow(taskRowsRef.current, taskCursorRef.current);
          if (row?.type === 'task') {
            setTaskEditId(row.task.id);
            setTaskInput({ value: row.task.text, pos: row.task.text.length });
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
            void removeTask(row.task.id).then(() => refreshTasks());
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

      // Esc clears an active filter
      if (key === KEYS.ESC && filterRef.current) {
        setFilter(null);
        setSessionCursor(0);
        return;
      }

      // / starts (or edits) the session filter
      if (key === '/' && topPaneModeRef.current === TopPaneMode.SESSIONS) {
        setFilter({ value: filterRef.current?.value ?? '', editing: true });
        setMessage('Type to filter, Enter to keep, Esc to clear');
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

        // Destructive (`work remove --force`): require a second `d` to confirm
        if (pendingRemoveRef.current !== k) {
          setPendingRemoveKey(k);
          setMessage(`Remove ${s.target}/${s.branch}? Press d again to confirm, any other key cancels`);
          return;
        }
        setPendingRemoveKey(null);

        const pty = ptySessions.current.get(k);
        if (pty) {
          notifiedSessionsRef.current.delete(ptyDedupKey(pty));
          pty.dispose();
          ptySessions.current.delete(k);
        }
        if (activeKeyRef.current === k) {
          setActiveKey(null);
          setTermLines([]);
        }
        setMessage(`Removing: ${s.target} / ${s.branch}...`);

        // Spawn work remove in a PTY so output shows in the right pane
        const removeKey = `remove:${s.target}:${s.branch}`;
        const removePty = new PtySession(
          process.cwd(),
          termInner,
          contentHeight - 2,
          { cmd: 'work', args: ['remove', s.target, s.branch, '--force'] },
        );
        registerPty(removeKey, removePty, `Removed: ${s.target} / ${s.branch}`, () => {
          refreshSessions();
          setMessage(`Removed: ${s.target} / ${s.branch}`);
        });
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
        if (rebasingRef.current) { setMessage('A rebase is already running'); return; }
        rebasingRef.current = true;
        setMessage(`Rebasing ${s.branch}...`);
        // Async — includes a network fetch; the sync version froze the UI
        void rebaseOntoMainAsync(s.branch, existing)
          .then((err) => {
            if (err) {
              setMessage(`Rebase failed: ${err}`);
            } else {
              setMessage(`Rebased ${s.branch} onto main`);
              computeConflictsAndMerged(sessionsRef.current);
            }
          })
          .catch((e: unknown) => setMessage(`Rebase failed: ${(e as Error).message}`))
          .finally(() => { rebasingRef.current = false; });
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
          await refreshPrs();
          computeConflictsAndMerged(sessionsRef.current);
          setSyncing(false);
          setMessage('Sessions synced');
        })();
        return;
      }

      if (key === 'r') {
        refreshSessions();
        void refreshPrs();
        void refreshJira();
        refreshTasks();
        if (!ghAvailable) setMessage('Refreshed');
        return;
      }
    };

    const handler = (data: Buffer) => {
      // Tokenize the chunk so batched input (held-down keys, fast mouse
      // wheel, pasted text) is handled event-by-event instead of dropped.
      for (const key of splitInputChunks(data.toString('utf8'))) {
        handleKey(key);
      }
    };

    process.stdin.on('data', handler);
    return () => { process.stdin.removeListener('data', handler); };
  }, [onExit, activateSession, refreshSessions, refreshPrs, refreshJira, refreshTasks, moveSessionCursor, movePrCursor, moveJiraCursor, moveTaskCursor, syncSessionCursorToActive, handleCreateWorktree, handleLaunchBaseRepo, savedSessionCursor, config, computeConflictsAndMerged, syncing, ghAvailable, prMap, scrollTerminal, setScrollBack]); // eslint-disable-line react-hooks/exhaustive-deps

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
          // Re-render immediately — otherwise the pane shows stale-width
          // lines until the PTY happens to produce output.
          try {
            setTermLines(renderBufferLines(pty.terminal.buffer.active, newTermInner, newContentHeight, termScrollBack.current));
          } catch { /* buffer not ready */ }
        }
      }
    };
    process.stdout.on('resize', handler);
    return () => { process.stdout.removeListener('resize', handler); };
  }, []);

  // Periodically clear scrollback for non-active PTYs to free memory
  useEffect(() => {
    const interval = setInterval(() => {
      for (const [key, pty] of ptySessions.current) {
        if (pty.exited) continue;
        if (key !== activeKeyRef.current) {
          pty.resetTerminal();
        }
      }
    }, 5 * 60 * 1000);
    return () => clearInterval(interval);
  }, []);

  const placeholder = !activeKey
    ? 'Select a session and press Enter'
    : 'Press Enter to start session';

  return (
    <Box flexDirection="column" width={cols} height={rows}>
      {showHelp ? (
        <HelpOverlay width={cols} height={contentHeight} />
      ) : (
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
              filter={filter}
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
            scrollback={termScroll}
          />
        </Box>
      )}
      <StatusBar message={message} pane={focus === Focus.TERMINAL ? 'terminal' : focus === Focus.PRS ? 'prs' : focus === Focus.JIRA ? 'jira' : focus === Focus.TASKS ? 'tasks' : 'sessions'} syncing={syncing} />
    </Box>
  );
}
