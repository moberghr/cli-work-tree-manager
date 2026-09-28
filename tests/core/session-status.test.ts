import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

let configDir: string;
vi.mock('../../src/core/config.js', () => ({ getConfigDir: () => configDir }));

import {
  ANSWERED_AFTER_MS,
  STALE_WORKING_MS,
  applyStatusEvent,
  effectiveStatus,
  lastAssistantText,
  markSeen,
  notifyKindForTransition,
  oneLine,
  readStatus,
  recordStatusEvent,
  type SessionStatus,
} from '../../src/core/session-status.js';
import { attentionRank, compareAttention, needsAttention } from '../../src/core/attention.js';

const T0 = new Date('2026-09-28T10:00:00Z');
const at = (sec: number) => new Date(T0.getTime() + sec * 1000);

beforeEach(() => {
  configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'status-'));
});
afterEach(() => fs.rmSync(configDir, { recursive: true, force: true }));

describe('applyStatusEvent', () => {
  it('prompt → working, seen, summary is the prompt', () => {
    const s = applyStatusEvent(null, { kind: 'prompt', prompt: 'Add the virtual card list\nwith paging' }, T0);
    expect(s).toMatchObject({ state: 'working', seen: true, summary: 'Add the virtual card list', since: T0.toISOString() });
  });

  it('stop → idle and unseen, summary is the last message', () => {
    const working = applyStatusEvent(null, { kind: 'prompt', prompt: 'x' }, T0);
    const done = applyStatusEvent(working, { kind: 'stop', lastMessage: '## Done\n\nAdded the endpoint.' }, at(60));
    expect(done).toMatchObject({ state: 'idle', seen: false, summary: 'Done', since: at(60).toISOString() });
  });

  it('a permission notification → needs_input with the request as summary', () => {
    const s = applyStatusEvent(null, { kind: 'notification', message: 'Claude needs your permission to use Bash' }, T0);
    expect(s).toMatchObject({ state: 'needs_input', seen: false, summary: 'Claude needs your permission to use Bash' });
  });

  it('the idle nudge notification changes nothing (stays seen if it was seen)', () => {
    const idleSeen: SessionStatus = { state: 'idle', since: T0.toISOString(), seen: true, updatedAt: T0.toISOString() };
    const s = applyStatusEvent(idleSeen, { kind: 'notification', message: 'Claude is waiting for your input' }, at(60));
    expect(s).toMatchObject({ state: 'idle', seen: true, since: T0.toISOString() });
  });

  it('keeps `since` when the state does not change, and the old summary when none is given', () => {
    const a = applyStatusEvent(null, { kind: 'stop', lastMessage: 'first' }, T0);
    const b = applyStatusEvent(a, { kind: 'stop' }, at(30));
    expect(b.since).toBe(T0.toISOString());
    expect(b.summary).toBe('first');
  });
});

describe('oneLine', () => {
  it('takes the first non-empty line, strips markdown, truncates', () => {
    expect(oneLine('\n\n# **Title** `x`\nmore')).toBe('Title x');
    expect(oneLine('- item')).toBe('item');
    expect(oneLine('a'.repeat(200), 10)).toBe('aaaaaaaaa…');
    expect(oneLine('   \n  ')).toBeUndefined();
    expect(oneLine(undefined)).toBeUndefined();
  });
});

describe('effectiveStatus', () => {
  const base = (state: SessionStatus['state'], sinceSec = 0): SessionStatus => ({
    state, since: at(sinceSec).toISOString(), seen: false, updatedAt: at(sinceSec).toISOString(),
  });

  it('decays a working status that went quiet into idle (stale)', () => {
    const now = T0.getTime() + STALE_WORKING_MS + 1000;
    expect(effectiveStatus(base('working'), 0, now)).toMatchObject({ state: 'idle', stale: true, seen: true });
    expect(effectiveStatus(base('working'), now - 1000, now)).toMatchObject({ state: 'working', stale: false });
  });

  it('treats transcript activity after a permission prompt as answered', () => {
    const s = base('needs_input');
    expect(effectiveStatus(s, T0.getTime() + ANSWERED_AFTER_MS + 500).state).toBe('working');
    expect(effectiveStatus(s, T0.getTime() + 1000).state).toBe('needs_input');
  });
});

describe('attention ordering', () => {
  const s = (state: SessionStatus['state'], seen: boolean, sinceSec: number) => ({
    state, seen, since: at(sinceSec).toISOString(),
  });

  it('ranks blocked < done-unseen < working < idle-seen < unknown', () => {
    expect(attentionRank(s('needs_input', false, 0))).toBe(0);
    expect(attentionRank(s('idle', false, 0))).toBe(1);
    expect(attentionRank(s('working', true, 0))).toBe(2);
    expect(attentionRank(s('idle', true, 0))).toBe(3);
    expect(attentionRank(null)).toBe(4);
    expect(needsAttention(s('idle', false, 0))).toBe(true);
    expect(needsAttention(s('working', true, 0))).toBe(false);
  });

  it('longest-waiting first among blocked/done, newest first among working', () => {
    const items = [
      { id: 'blockedNew', a: s('needs_input', false, 50) },
      { id: 'working-old', a: s('working', true, 0) },
      { id: 'blockedOld', a: s('needs_input', false, 10) },
      { id: 'working-new', a: s('working', true, 40) },
      { id: 'none', a: null },
      { id: 'done', a: s('idle', false, 5) },
    ];
    const order = [...items].sort((x, y) => compareAttention(x.a, y.a)).map((x) => x.id);
    expect(order).toEqual(['blockedOld', 'blockedNew', 'done', 'working-new', 'working-old', 'none']);
  });
});

describe('notifyKindForTransition', () => {
  it('notifies on entering needs_input and on a finished turn only', () => {
    expect(notifyKindForTransition({ state: 'working' }, { state: 'needs_input' })).toBe('needs_input');
    expect(notifyKindForTransition(null, { state: 'needs_input' })).toBe('needs_input');
    expect(notifyKindForTransition({ state: 'needs_input' }, { state: 'needs_input' })).toBeNull();
    expect(notifyKindForTransition({ state: 'working' }, { state: 'idle' })).toBe('idle');
    expect(notifyKindForTransition({ state: 'idle' }, { state: 'idle' })).toBeNull(); // repeat Stop
    expect(notifyKindForTransition(null, { state: 'idle' })).toBeNull();
    expect(notifyKindForTransition({ state: 'idle' }, { state: 'working' })).toBeNull();
  });
});

describe('persistence', () => {
  it('records events with prevState and marks seen', async () => {
    await recordStatusEvent('s1', { kind: 'prompt', prompt: 'go' }, T0);
    await recordStatusEvent('s1', { kind: 'stop', lastMessage: 'done' }, at(10));
    expect(readStatus('s1')).toMatchObject({ state: 'idle', seen: false, prevState: 'working' });
    await markSeen('s1');
    expect(readStatus('s1')?.seen).toBe(true);
    expect(fs.existsSync(path.join(configDir, 'status', 's1.json'))).toBe(true);
  });

  it('markSeen on an unknown session is a no-op', async () => {
    expect(await markSeen('nope')).toBeNull();
  });

  it('concurrent events for one session all land (locked read-modify-write)', async () => {
    await Promise.all([
      recordStatusEvent('s2', { kind: 'prompt', prompt: 'a' }, T0),
      recordStatusEvent('s2', { kind: 'notification', message: 'needs your permission' }, at(1)),
      recordStatusEvent('s2', { kind: 'stop', lastMessage: 'b' }, at(2)),
    ]);
    const s = readStatus('s2');
    expect(s).not.toBeNull();
    expect(['working', 'needs_input', 'idle']).toContain(s!.state);
    expect(() => JSON.parse(fs.readFileSync(path.join(configDir, 'status', 's2.json'), 'utf-8'))).not.toThrow();
  });
});

describe('lastAssistantText', () => {
  it('returns the last assistant text block from a JSONL transcript', () => {
    const file = path.join(configDir, 't.jsonl');
    const lines = [
      { type: 'user', message: { content: 'hi' } },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'first answer' }] } },
      { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash' }] } },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'Final: shipped it' }] } },
      { type: 'user', message: { content: [{ type: 'tool_result' }] } },
    ];
    fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
    expect(lastAssistantText(file)).toBe('Final: shipped it');
  });

  it('copes with a missing file, garbage lines and a cut-off first line', () => {
    expect(lastAssistantText(path.join(configDir, 'missing.jsonl'))).toBeNull();
    expect(lastAssistantText(undefined)).toBeNull();
    const file = path.join(configDir, 'g.jsonl');
    fs.writeFileSync(file, 'xt":"partial"}\nnot json\n' + JSON.stringify({ type: 'assistant', message: { content: 'plain string' } }) + '\n');
    expect(lastAssistantText(file)).toBe('plain string');
  });
});
