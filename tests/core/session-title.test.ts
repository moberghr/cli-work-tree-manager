import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorktreeSession } from '../../src/core/session-types.js';

const files = vi.hoisted(() => ({ list: [] as Array<{ file: string; mtimeMs: number; size: number }> }));
vi.mock('../../src/core/context-usage.js', () => ({ listTranscripts: () => files.list }));

import { firstPromptOf, sessionTitle } from '../../src/core/session-title.js';

let tmp: string;
const line = (o: object) => JSON.stringify(o) + '\n';
const write = (name: string, prompts: string[], mtimeMs: number) => {
  const file = path.join(tmp, name);
  fs.writeFileSync(file, prompts.map((p, i) => line({ type: 'user', uuid: `${name}-${i}`, timestamp: `2026-09-0${i + 1}T10:00:00Z`, message: { content: p } })).join(''));
  files.list.push({ file, mtimeMs, size: fs.statSync(file).size });
  return file;
};
const s = (over: Partial<WorktreeSession> = {}): WorktreeSession =>
  ({ target: 'api', branch: 'fix/keys', isGroup: false, paths: ['/wt'], createdAt: '', lastAccessedAt: '', ...over }) as WorktreeSession;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'title-'));
  files.list = [];
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe('sessionTitle', () => {
  it('is your name for it when you gave one', () => {
    write('a.jsonl', ['Rotate the keys'], 1);
    expect(sessionTitle(s({ title: '  Key rotation  ' }))).toBe('Key rotation');
  });

  it('else the first prompt of its OLDEST conversation, shortened', () => {
    write('new.jsonl', ['Later work on it'], 200);
    write('old.jsonl', ['Rotate the terminal encryption keys for stage and check Adyen accepts the new shape of the key identifier', 'more'], 100);
    const t = sessionTitle(s())!;
    expect(t.startsWith('Rotate the terminal encryption keys')).toBe(true);
    expect(t.length).toBeLessThanOrEqual(80);
    expect(t.endsWith('…')).toBe(true);
  });

  it('else what the archive kept, else its Jira key, else nothing', () => {
    expect(sessionTitle(s(), 'From the archive')).toBe('From the archive');
    expect(sessionTitle(s({ jiraKey: 'PAY-12' }))).toBe('PAY-12');
    expect(sessionTitle(s())).toBeNull();
  });

  it('reads a prompt from the start of the file only once', () => {
    const f = write('a.jsonl', ['First thing'], 1);
    expect(firstPromptOf(f)).toBe('First thing');
    fs.appendFileSync(f, line({ type: 'user', uuid: 'x', timestamp: '2026-09-09T00:00:00Z', message: { content: 'appended' } }));
    expect(firstPromptOf(f)).toBe('First thing');
  });
});
