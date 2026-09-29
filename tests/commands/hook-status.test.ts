import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { statusEventFor } from '../../src/commands/hook.js';

let tmpDir: string;
beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hook-status-'));
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('statusEventFor (Claude hook payload → status event)', () => {
  it('UserPromptSubmit carries the prompt', () => {
    expect(statusEventFor('status-prompt', { prompt: 'do the thing' })).toEqual({ kind: 'prompt', prompt: 'do the thing' });
  });

  it('Notification carries the message', () => {
    expect(statusEventFor('status-notify', { message: 'Claude needs your permission to use Edit' }))
      .toEqual({ kind: 'notification', message: 'Claude needs your permission to use Edit' });
  });

  it('Stop reads the last assistant message from the transcript', () => {
    const t = path.join(tmpDir, 't.jsonl');
    fs.writeFileSync(t, JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'All tests pass.' }] } }) + '\n');
    expect(statusEventFor('status-stop', { transcript_path: t })).toEqual({ kind: 'stop', lastMessage: 'All tests pass.' });
    expect(statusEventFor('status-stop', {})).toEqual({ kind: 'stop', lastMessage: undefined });
  });

  it('a permission Notification carries the tool call from the transcript', () => {
    const t = path.join(tmpDir, 't.jsonl');
    const lines = [
      { type: 'user', message: { content: 'ship it' } },
      { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'x1', name: 'Bash', input: { command: 'git push' } }] } },
    ];
    fs.writeFileSync(t, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
    expect(statusEventFor('status-notify', { message: 'Claude needs your permission to use Bash', transcript_path: t })).toEqual({
      kind: 'notification',
      message: 'Claude needs your permission to use Bash',
      request: { tool: 'Bash', detail: 'git push' },
    });
  });

  it('non-status hooks map to nothing', () => {
    expect(statusEventFor('stop', {})).toBeNull();
    expect(statusEventFor('checkpoint', {})).toBeNull();
  });
});
