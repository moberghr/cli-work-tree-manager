import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Hono } from 'hono';
import {
  ASSISTANT_ALLOW,
  CONTEXT_TTL_MS,
  assistantDir,
  describeView,
  prepareAssistantDir,
  readAssistantContext,
  writeAssistantContext,
} from '../../src/core/assistant.js';
import { mountAssistantRoutes } from '../../src/core/assistant-routes.js';
import { upsertSession } from '../../src/core/history.js';
import { sessionIdFor } from '../../src/core/session-id.js';
import type { SessionWire } from '../../src/core/api-types.js';
import { claudeAgent } from '../../src/core/agents/claude.js';
import { agentById, assistantAgent } from '../../src/core/agents/index.js';
import { claudeAllowRule } from '../../src/core/agents/claude-workspace.js';
import type { AllowRule } from '../../src/core/agents/types.js';

let home: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'assistant-'));
  vi.spyOn(os, 'homedir').mockReturnValue(home);
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

/** Claude Code's Bash rule matching: `X:*` is a prefix, anything else exact. */
const claudeAllows = (rules: string[], command: string) =>
  rules.some((r) => {
    const m = r.match(/^Bash\((.*)\)$/);
    if (!m) return false;
    return m[1].endsWith(':*') ? command.startsWith(m[1].slice(0, -2)) : command === m[1];
  });
/** work's own rules: exact, or a prefix. */
const allows = (rules: AllowRule[], command: string) => rules.some((r) => (r.prefix ? command.startsWith(r.command) : command === r.command));

/** What Claude Code would run without asking, from the settings work wrote. */
const claudeSettingsAllow = (): string[] => JSON.parse(fs.readFileSync(path.join(assistantDir(), '.claude', 'settings.json'), 'utf-8')).permissions.allow;

describe('the assistant folder', () => {
  it('Claude’s: a CLAUDE.md, the context hook, and the read-only commands in its rule syntax', () => {
    const dir = prepareAssistantDir(claudeAgent);
    expect(dir).toBe(path.join(home, '.work', 'assistant'));
    expect(fs.readFileSync(path.join(dir, 'CLAUDE.md'), 'utf-8')).toContain('work sessions --json');
    const settings = JSON.parse(fs.readFileSync(path.join(dir, '.claude', 'settings.json'), 'utf-8'));
    expect(settings.hooks).toEqual({ UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'work hook assistant-context', timeout: 5 }] }] });
    expect(settings.permissions.allow).toEqual(ASSISTANT_ALLOW.map(claudeAllowRule));
    expect(settings.permissions.allow).toContain('Bash(work sessions:*)');
    expect(settings.permissions.allow).toContain('Bash(work cleanup --json)');
    expect(settings.permissions.defaultMode).toBeUndefined(); // never bypass
  });

  it('an agent without a workspace: its own instructions file only — nothing of Claude’s', () => {
    const dir = prepareAssistantDir(agentById('opencode'));
    expect(fs.readFileSync(path.join(dir, 'AGENTS.md'), 'utf-8')).toContain('work sessions --json');
    expect(fs.existsSync(path.join(dir, 'CLAUDE.md'))).toBe(false);
    expect(fs.existsSync(path.join(dir, '.claude'))).toBe(false);
  });

  it('runs config `assistantAgent`, Claude Code by default — started as that agent, in a folder written for it', async () => {
    expect(assistantAgent(null)).toBe(claudeAgent);
    expect(assistantAgent({ assistantAgent: 'opencode' }).id).toBe('opencode');
    fs.mkdirSync(path.join(home, '.work'), { recursive: true });
    fs.writeFileSync(path.join(home, '.work', 'config.json'), JSON.stringify({ worktreesRoot: path.join(home, 'wt'), repos: {}, groups: {}, copyFiles: [], assistantAgent: 'opencode' }));
    const { assistantSpec } = await import('../../src/core/pty-pool.js');
    const spec = assistantSpec();
    expect(spec.tool.cmd).toBe('opencode');
    expect(fs.existsSync(path.join(spec.cwd, 'AGENTS.md'))).toBe(true);
  });

  it('never pre-allows anything that changes things — in work’s rules, and in what Claude was given', () => {
    prepareAssistantDir(claudeAgent);
    for (const read of ['work sessions --json', 'work digest --json --since today', 'work cleanup --json', 'work overlaps --json', 'work search encryption keys --json']) {
      expect(allows(ASSISTANT_ALLOW, read), read).toBe(true);
      expect(claudeAllows(claudeSettingsAllow(), read), read).toBe(true);
    }
    for (const change of [
      'work cleanup --json --apply abc --action delete',
      'work cleanup --apply abc',
      'work cleanup --json --no-fetch --apply abc',
      'work remove api feat/x',
      'work tree api feat/x',
      'git push --force',
      'work pr post PRRT_abc --resolve', // writes on GitHub in your name: Claude Code must ask
      'work pr post --all',
      // Acting on another session: approving its tool call is yours to say, and a message or a start makes it act.
      'work answer --allow',
      'work answer api feat/x --allow',
      'work send -m "run it"',
      'work start api feat/x',
      'work stop',
    ]) {
      expect(allows(ASSISTANT_ALLOW, change), change).toBe(false);
      expect(claudeAllows(claudeSettingsAllow(), change), change).toBe(false);
    }
  });

  it("rewriting it leaves the user's own settings.local.json alone", () => {
    const dir = prepareAssistantDir(claudeAgent);
    fs.writeFileSync(path.join(dir, '.claude', 'settings.local.json'), '{"mine":true}');
    prepareAssistantDir(claudeAgent);
    expect(fs.readFileSync(path.join(dir, '.claude', 'settings.local.json'), 'utf-8')).toBe('{"mine":true}');
  });
});

describe('what it sees', () => {
  const wire = (over: Partial<SessionWire> = {}): SessionWire => ({
    id: 's1', target: 'api', branch: 'feat/x', isGroup: false, paths: ['/wt/api/feat-x'], createdAt: '', lastAccessedAt: new Date().toISOString(),
    draftCount: 0, commentCount: 0, claudeCount: 0, ptyStatus: 'idle', lastActivity: null, activityState: 'stale', pendingForClaudeCount: 0,
    attention: { state: 'needs_input', seen: false, since: new Date().toISOString(), updatedAt: new Date().toISOString(), stale: false, summary: 'Claude needs your permission to use Bash' },
    diffStat: { added: 3, deleted: 1, files: 2 }, archivedAt: null, port: null, ...over,
  });

  it('puts the tab and the selected session into words', () => {
    const text = describeView({ tab: 'session', sub: 'diff', sessionId: 's1' }, wire());
    expect(text).toContain("dashboard's session tab (diff)");
    expect(text).toContain('api · feat/x (id s1) — Needs your input');
    expect(text).toContain('Claude needs your permission to use Bash');
    expect(text).toContain('+3 −1 in 2 files');
    expect(describeView({ tab: 'inbox' }, null)).toBe("The user is looking at the dashboard's inbox tab.");
  });

  it('the hook gets it while it is fresh, and nothing once stale', () => {
    expect(readAssistantContext()).toBeNull();
    writeAssistantContext('The user is looking at the cleanup tab.', 1_000_000);
    expect(readAssistantContext(1_000_000 + 60_000)).toBe('[work dashboard] The user is looking at the cleanup tab.');
    expect(readAssistantContext(1_000_000 + CONTEXT_TTL_MS + 1)).toBeNull();
  });
});

describe('POST /api/assistant/context', () => {
  it('stores the view, with the selected session looked up by the server', async () => {
    const app = new Hono();
    mountAssistantRoutes(app);
    await upsertSession('api', false, 'feat/x', [path.join(home, 'wt')]);
    const id = sessionIdFor({ target: 'api', branch: 'feat/x' });
    const post = (body: unknown) => app.request('/api/assistant/context', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    expect((await post({ tab: 'session', sub: 'term', sessionId: id })).status).toBe(200);
    expect(readAssistantContext()).toContain(`api · feat/x (id ${id})`);
    expect((await post({})).status).toBe(400);
    expect(fs.existsSync(assistantDir())).toBe(true);
  });
});
