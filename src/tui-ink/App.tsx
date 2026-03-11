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
import { rebaseOntoMain, countConflicts, isBranchMerged, fetchRemoteAsync } from '../core/git.js';
import { fetchAllPullRequests, isGhAvailable, type BranchPrMap } from '../core/pr.js';
import { fetchMyJiraIssues, isAcliAvailable, type JiraIssue } from '../core/jira.js';
import { getTasks, addTask, completeTask, uncompleteTask, removeTask, editTask, getTasksPath_, type Task } from '../core/tasks.js';
import { PtySession } from '../tui/session.js';
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
  const sessionRows = useMemo(() => buildSessionRows(sessions), [sessions]);
  const projectRows = useMemo(() => buildProjectRows(projects), [projects]);
  const prRows = useMemo(() => buildPrRows(prMap), [prMap]);
  const jiraRows = useMemo(() => buildJiraRows(jiraIssues), [jiraIssues]);
  const taskRows = useMemo(() => buildTaskRows(tasks), [tasks]);
  const topRows = topPaneMode === TopPaneMode.SESSIONS ? sessionRows : projectRows;

  const ptySessions = useRef(new Map<string, PtySession>());
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

  const scheduleTerminalRender = useCallback((pty: PtySession) => {
    if (renderPending.current) return;
    renderPending.current = true;
    setTimeout(() => {
      renderPending.current = false;
      try {
        // If scrolled back, don't auto-update (user is reading scrollback)
        if (termScrollBack.current > 0) return;
        const lines = renderBufferLines(pty.terminal.buffer.active, termInner, contentHeight - 2);
        setTermLines((prev) => {
          if (prev.length === lines.length && prev.every((l, i) => l === lines[i])) return prev;
          return lines;
        });
      } catch { /* buffer not ready */ }
    }, RENDER_INTERVAL_MS);
  }, [termInner, contentHeight]);

  /** Re-render terminal at current scroll offset. */
  const renderTermAtScroll = useCallback(() => {
    if (!activeKeyRef.current) return;
    const pty = ptySessions.current.get(activeKeyRef.current);
    if (!pty || pty.exited) return;
    try {
      const lines = renderBufferLines(pty.terminal.buffer.active, termInner, contentHeight - 2, termScrollBack.current);
      setTermLines(lines);
    } catch { /* */ }
  }, [termInner, contentHeight]);

  const findPtyByCwd = useCallback((cwd: string): PtySession | undefined => {
    const normalized = path.resolve(cwd).toLowerCase();
    for (const pty of ptySessions.current.values()) {
      if (path.resolve(pty.cwd).toLowerCase() === normalized) return pty;
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

    pty.onExit = () => {
      ptySessions.current.delete(key);
      if (activeKeyRef.current === key) {
        setActiveKey(null);
        setFocus(Focus.SESSIONS);
        setTermLines([]);
        setMessage(`Session exited: ${projectName} (base)`);
      }
      setStatusVersion((v) => v + 1);
    };
    pty.onStatusChange = () => setStatusVersion((v) => v + 1);
    setStatusVersion((v) => v + 1);
    connectPty(key, pty);
    setMessage(`Launched: ${projectName} (base repo)`);
  }, [unsafe, termInner, contentHeight, connectPty, refreshSessions, savedSessionCursor, config]);

  /** Spawn `work2 tree --no-launch` in a PTY to set up the worktree (visible output),
   *  then on success launch Claude in a separate PTY session. */
  const handleCreateWorktree = useCallback((projectName: string, branchName: string, jiraIssue?: JiraIssue | null) => {
    setTopPaneMode(TopPaneMode.SESSIONS);
    setSessionCursor(savedSessionCursor);

    const key = `${projectName}:${branchName}`;
    const setupArgs = ['tree', projectName, branchName, '--setup-only'];

    // Build prompt args for the Claude session (used after setup completes)
    let promptFile: string | undefined;
    if (jiraIssue) {
      const prompt = [
        `Read Jira issue ${jiraIssue.key} (${jiraIssue.url}) and plan how to implement it.`,
        '',
        '1. Read the Jira issue details to understand requirements, acceptance criteria, and context.',
        '',
        '2. Analyze the codebase to understand:',
        '   - Which files/components will need to be modified',
        '   - Existing patterns and conventions to follow',
        '   - Dependencies and related code',
        '   - Potential impact areas',
        '',
        '3. Present a structured implementation plan:',
        '',
        '   **Summary**: Brief overview of what the issue requires.',
        '',
        '   **Affected Areas**: List the files, components, or modules that will need changes.',
        '',
        '   **Implementation Approach**:',
        '   - For simple issues (bug fixes, small features): provide a single clear approach with step-by-step details.',
        '   - For complex issues (new features, architectural changes): present 2-3 alternative approaches, each with Description, Pros, Cons, and Effort (Low/Medium/High). Include a Recommendation with reasoning.',
        '',
        '   **Key Considerations**: Security, performance, testing requirements, migration needs, backwards compatibility.',
        '',
        '   **Next Steps**: Ordered list of implementation tasks, ready to be executed.',
        '',
        '4. Ask if I want to proceed with the recommended approach, choose a different one, get more details, or make adjustments.',
      ].join('\n');
      promptFile = path.join(os.tmpdir(), `work2-prompt-${Date.now()}.txt`);
      fs.writeFileSync(promptFile, prompt, 'utf-8');
    }

    // Phase 1: Run setup in PTY (output visible in terminal pane)
    const setupPty = new PtySession(
      process.cwd(),
      termInner,
      contentHeight - 2,
      false,
      { cmd: 'work2', args: setupArgs },
    );
    ptySessions.current.set(key, setupPty);

    setupPty.onExit = (code: number) => {
      ptySessions.current.delete(key);
      setStatusVersion((v) => v + 1);
      refreshSessions();

      if (code !== 0) {
        if (activeKeyRef.current === key) {
          setActiveKey(null);
          setFocus(Focus.SESSIONS);
          setTermLines([]);
        }
        if (promptFile) try { fs.unlinkSync(promptFile); } catch { /* */ }
        return;
      }

      // Phase 2: Setup succeeded — launch Claude
      refreshSessions();

      const launchArgs = ['tree', projectName, branchName];
      if (unsafe) launchArgs.push('--unsafe');
      if (promptFile) launchArgs.push('--prompt-file', promptFile);

      const claudePty = new PtySession(
        process.cwd(),
        termInner,
        contentHeight - 2,
        false,
        { cmd: 'work2', args: launchArgs },
      );
      ptySessions.current.set(key, claudePty);

      claudePty.onExit = () => {
        ptySessions.current.delete(key);
        if (activeKeyRef.current === key) {
          setActiveKey(null);
          setFocus(Focus.SESSIONS);
          setTermLines([]);
          setMessage(`Session exited: ${projectName} / ${branchName}`);
        }
        setStatusVersion((v) => v + 1);
      };
      claudePty.onStatusChange = () => setStatusVersion((v) => v + 1);
      setStatusVersion((v) => v + 1);
      connectPty(key, claudePty);
      setMessage(`Created: ${projectName}/${branchName}`);
    };
    setupPty.onStatusChange = () => setStatusVersion((v) => v + 1);
    setStatusVersion((v) => v + 1);
    setMessage(`Creating: ${projectName}/${branchName}...`);
    connectPty(key, setupPty);
  }, [unsafe, termInner, contentHeight, refreshSessions, connectPty, startPtyForSession, savedSessionCursor]);

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
        // Ignore other mouse events (clicks, etc.)
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

            // Check if any existing session matches this issue key
            const keyLower = issue.key.toLowerCase();
            const existing = sessionsRef.current.find((s) =>
              s.branch.includes(keyLower),
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
        removePty.onExit = () => {
          ptySessions.current.delete(removeKey);
          if (activeKeyRef.current === removeKey) {
            setActiveKey(null);
            setTermLines([]);
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
