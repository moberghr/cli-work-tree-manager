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
const allows = (rules: string[], command: string) =>
  rules.some((r) => {
    const m = r.match(/^Bash\((.*)\)$/);
    if (!m) return false;
    return m[1].endsWith(':*') ? command.startsWith(m[1].slice(0, -2)) : command === m[1];
  });

describe('the assistant folder', () => {
  it('has a CLAUDE.md, the context hook, and read-only commands pre-allowed', () => {
    const dir = prepareAssistantDir();
    expect(dir).toBe(path.join(home, '.work', 'assistant'));
    expect(fs.readFileSync(path.join(dir, 'CLAUDE.md'), 'utf-8')).toContain('work sessions --json');
    const settings = JSON.parse(fs.readFileSync(path.join(dir, '.claude', 'settings.json'), 'utf-8'));
    expect(settings.hooks.UserPromptSubmit[0].hooks[0].command).toBe('work hook assistant-context');
    expect(settings.permissions.allow).toEqual(ASSISTANT_ALLOW);
    expect(settings.permissions.defaultMode).toBeUndefined(); // never bypass
  });

  it('never pre-allows anything that changes things', () => {
    for (const read of ['work sessions --json', 'work digest --json --since today', 'work cleanup --json', 'work overlaps --json']) {
      expect(allows(ASSISTANT_ALLOW, read), read).toBe(true);
    }
    for (const change of [
      'work cleanup --json --apply abc --action delete',
      'work cleanup --apply abc',
      'work cleanup --json --no-fetch --apply abc',
      'work remove api feat/x',
      'work tree api feat/x',
      'git push --force',
    ]) {
      expect(allows(ASSISTANT_ALLOW, change), change).toBe(false);
    }
  });

  it("rewriting it leaves the user's own settings.local.json alone", () => {
    const dir = prepareAssistantDir();
    fs.writeFileSync(path.join(dir, '.claude', 'settings.local.json'), '{"mine":true}');
    prepareAssistantDir();
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
