import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentAdapter, ConversationEntry, WorkHook } from '../../../src/core/agents/types.js';
import { typeThenEnter } from '../../../src/core/agents/typing.js';

/**
 * The proof that work is ready for another agent: a whole adapter for a
 * made-up "echo" agent — its own conversation format, its own hooks file,
 * its own process list, its own instructions file — registered like Codex
 * or Copilot would be, and a session run on it through the real modules.
 * Nothing here is Claude's: every Claude file is absent, and nothing reads
 * one.
 */

let home: string;
let wt: string;
let removeAgent: () => void;

/** The echo agent keeps a conversation per folder in ~/.echo/<folder name>/<n>.jsonl: {t, who, text, used?}. */
const echoDir = (cwd: string) => path.join(home, '.echo', path.basename(cwd));
const running: Array<{ pid: number; cwd: string }> = [];
const installed: WorkHook[] = [];

function echoAgent(): AgentAdapter {
  return {
    id: 'echo',
    name: 'Echo',
    launch: {
      tool: () => ({
        cmd: 'echo-agent',
        baseArgs: [],
        unsafeFlag: '--yolo',
        resumeFlag: '--again',
        promptFileFlag: '',
        promptFlag: '--say',
      }),
      canResume: (cwd) => fs.existsSync(echoDir(cwd)),
      resumeLaunch: (s) => ({ launchPath: s.paths[0], hasConversation: fs.existsSync(echoDir(s.paths[0])) }),
      cleanEnv: (env) => {
        const { ECHO_PARENT: _p, ...rest } = env;
        return rest;
      },
    },
    conversation: {
      files: (s) =>
        fs.existsSync(echoDir(s.paths[0]))
          ? fs.readdirSync(echoDir(s.paths[0])).map((f) => {
              const file = path.join(echoDir(s.paths[0]), f);
              const st = fs.statSync(file);
              return { file, mtimeMs: st.mtimeMs, size: st.size };
            })
          : [],
      entries: (lines) =>
        lines.flatMap((l): ConversationEntry[] => {
          const e = l as { t?: string; who?: string; text?: string; used?: number };
          if (!e || typeof e.t !== 'string') return [];
          const role = e.who === 'me' ? 'you' : e.who === 'echo' ? 'agent' : 'other';
          return [{ at: e.t, role, text: e.text ?? '', ...(e.used ? { usage: { prompt: e.used, reply: 0 } } : {}) }];
        }),
      contextWindow: () => 1000,
      read: () => [],
    },
    events: {
      install: async (hooks) => void installed.push(...hooks),
      removeSync: () => void installed.splice(0),
      read: (edge, payload) => {
        const p = payload as { dir?: string; said?: string };
        return {
          cwd: p.dir,
          status:
            edge === 'turn-start' ? { kind: 'prompt', prompt: p.said } : edge === 'turn-end' ? { kind: 'stop', lastMessage: p.said } : null,
        };
      },
      handOver: (_edge, text) => `ECHO-NOTE:${text}`,
    },
    live: {
      running: () =>
        running.map((r) => ({
          pid: r.pid,
          conversationId: `c${r.pid}`,
          cwd: r.cwd,
          busy: false,
          state: 'idle',
          stateAt: null,
          waitingFor: null,
          startedAt: null,
        })),
    },
    input: { submit: typeThenEnter },
    instructionsFile: 'ECHO.md',
  };
}

beforeEach(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'echo-agent-'));
  vi.spyOn(os, 'homedir').mockReturnValue(home);
  wt = path.join(home, 'wt', 'api', 'feat-x');
  fs.mkdirSync(wt, { recursive: true });
  fs.mkdirSync(path.join(home, '.work'), { recursive: true });
  fs.writeFileSync(
    path.join(home, '.work', 'config.json'),
    JSON.stringify({
      worktreesRoot: path.join(home, 'wt'),
      repos: { api: path.join(home, 'repo') },
      groups: {},
      copyFiles: [],
      aiCommand: 'echo',
    }),
  );
  const { registerAgent } = await import('../../../src/core/agents/index.js');
  removeAgent = registerAgent(echoAgent());
  running.splice(0);
  installed.splice(0);
  // Its conversation: a prompt, its answer (with usage), 3 minutes apart.
  fs.mkdirSync(echoDir(wt), { recursive: true });
  const now = Date.now();
  const at = (minsAgo: number) => new Date(now - minsAgo * 60_000).toISOString();
  fs.writeFileSync(
    path.join(echoDir(wt), '1.jsonl'),
    [
      { t: at(5), who: 'me', text: 'Add the CSV export' },
      { t: at(2), who: 'echo', text: 'Added it.', used: 250 },
    ]
      .map((l) => JSON.stringify(l))
      .join('\n') + '\n',
  );
});
afterEach(() => {
  removeAgent();
  vi.restoreAllMocks();
  fs.rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

describe('a session on the echo agent, through the real modules — no Claude anywhere', () => {
  it('is recorded with it, launched as it, and read through it', async () => {
    const { upsertSession, loadHistory, saveHistory } = await import('../../../src/core/sessions/history.js');
    await upsertSession('api', false, 'feat/x', [wt]);
    // Created an hour ago (the timeline shows what happened since it was made; the conversation is 5 minutes old).
    saveHistory(loadHistory().map((x) => ({ ...x, createdAt: new Date(Date.now() - 3600_000).toISOString() })));
    const s = loadHistory()[0];
    expect(s.agent).toBe('echo'); // a known agent: recorded

    const { agentOf } = await import('../../../src/core/agents/index.js');
    expect(agentOf(s).launch.tool(null).cmd).toBe('echo-agent');
    const { spawnSpecFor } = await import('../../../src/core/pty/pty-pool.js');
    expect(spawnSpecFor(s)?.tool.cmd).toBe('echo-agent');

    const { readContextUsage } = await import('../../../src/core/conversations/context-usage.js');
    expect(readContextUsage(s)).toEqual({ used: 250, window: 1000 });
    const { sessionTitle } = await import('../../../src/core/conversations/session-title.js');
    expect(sessionTitle(s)).toBe('Add the CSV export');
    const { readSessionActivity } = await import('../../../src/core/sessions/session-activity.js');
    expect(readSessionActivity(s).lastActivity).toBeGreaterThan(0);
    const { sessionWorkTime } = await import('../../../src/core/conversations/work-time-source.js');
    expect(await sessionWorkTime(s)).toMatchObject({ prompts: 1, workedMs: 3 * 60_000 });
    const { sessionTimeline } = await import('../../../src/core/conversations/timeline-source.js');
    const t = await sessionTimeline(s, { run: async () => ({ code: 1, stdout: '', stderr: '' }) });
    expect(t.find((e) => e.kind === 'prompt')?.text).toBe('Add the CSV export');
  });

  it('its hooks, its notes, its processes, its name on the wire', async () => {
    const { upsertSession, loadHistory } = await import('../../../src/core/sessions/history.js');
    await upsertSession('api', false, 'feat/x', [wt]);
    const s = loadHistory()[0];

    // work web installs work's hooks into it too.
    const { installAgentHooks } = await import('../../../src/commands/web.js');
    await installAgentHooks(false);
    expect(installed.map((h) => h.edge)).toEqual(['turn-start', 'turn-end', 'notify']);

    // A hook it ran, read its way; a pending note handed over its way.
    const { statusEventFor, computeHookOutput } = await import('../../../src/commands/hook.js');
    const { agentById } = await import('../../../src/core/agents/index.js');
    const echo = agentById('echo');
    expect(statusEventFor('status-prompt', { dir: wt, said: 'go' }, echo)).toEqual({ kind: 'prompt', prompt: 'go' });
    const { getCommentFileStore } = await import('../../../src/core/comments/comment-file-store.js');
    const { sessionIdFor } = await import('../../../src/core/sessions/session-id.js');
    getCommentFileStore(sessionIdFor(s)).post({ body: 'also quote commas' });
    const out = computeHookOutput({ event: 'prompt-submit', cwd: wt }, undefined, echo);
    expect(out?.stdout).toMatch(/^ECHO-NOTE:/);
    expect(out?.stdout).toContain('also quote commas');

    // Its running process, by session.
    running.push({ pid: 777, cwd: wt });
    const { liveAgents } = await import('../../../src/core/agents/index.js');
    const { agentsBySession, summarizeAgents } = await import('../../../src/core/sessions/live-agents.js');
    const mine = agentsBySession(liveAgents(), loadHistory()).get(sessionIdFor(s)) ?? [];
    expect(summarizeAgents(mine, new Set())).toMatchObject({ inTerminal: 1, busy: false });

    // The wire says which agent, and what work can do with it.
    const { sessionWire } = await import('../../../src/core/sessions/session-wire.js');
    expect(sessionWire(s).agent).toEqual({
      id: 'echo',
      name: 'Echo',
      can: { read: true, hooks: true, live: true, answer: false },
    });
  });

  it('a group’s instructions file is its file (ECHO.md)', async () => {
    fs.mkdirSync(path.join(home, 'repo'), { recursive: true });
    fs.writeFileSync(path.join(home, 'repo', 'ECHO.md'), '# echo notes for api');
    const cfg = JSON.parse(fs.readFileSync(path.join(home, '.work', 'config.json'), 'utf8'));
    const { generateGroupInstructions } = await import('../../../src/core/agents/group-instructions.js');
    generateGroupInstructions('shop', ['api'], { ...cfg, groups: { shop: ['api'] }, internalAgent: 'echo' });
    const made = fs.readFileSync(path.join(home, '.work', 'shop.claude.md'), 'utf8');
    expect(made).toContain('# echo notes for api'); // the template: echo writes no summaries (no oneShot)
  });
});
