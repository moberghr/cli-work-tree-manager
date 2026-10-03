import { lastAssistantText } from '../../src/core/agents/claude/hooks.js';
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
  lastTurnEntryMs,
  withLiveClaude,
  markSeen,
  notifyKindForTransition,
  oneLine,
  readStatus,
  recordStatusEvent,
  type SessionStatus,
} from '../../src/core/session-status.js';
import { claudeEntries } from '../../src/core/agents/claude/entries.js';
import { attentionRank, compareAttention, compareInbox, inboxRank, needsAttention, wantsYou } from '../../src/core/attention.js';

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

  it('a finished turn that asks for a decision → needs_input with the question', () => {
    const working = applyStatusEvent(null, { kind: 'prompt', prompt: 'x' }, T0);
    const ask = applyStatusEvent(
      working,
      { kind: 'stop', lastMessage: 'Fixed two review comments.\n\n**DECISION NEEDED:** keep the v1 endpoint for old clients?\n\n> reviewer: drop v1' },
      at(60),
    );
    expect(ask).toMatchObject({ state: 'needs_input', seen: false, summary: 'keep the v1 endpoint for old clients?' });
    // Mentioning the words mid-sentence is not asking.
    const done = applyStatusEvent(working, { kind: 'stop', lastMessage: 'No DECISION NEEDED here, all fixed.' }, at(60));
    expect(done.state).toBe('idle');
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
    const a = applyStatusEvent(null, { kind: 'prompt', prompt: 'first' }, T0);
    const b = applyStatusEvent(a, { kind: 'prompt' }, at(30));
    expect(b.since).toBe(T0.toISOString());
    expect(b.summary).toBe('first');
  });

  it('a Stop always starts its own `since` (a turn ended now), even idle → idle', () => {
    const a = applyStatusEvent(null, { kind: 'stop', lastMessage: 'first' }, T0);
    const b = applyStatusEvent(a, { kind: 'stop' }, at(30));
    expect(b).toMatchObject({ state: 'idle', since: at(30).toISOString(), turnEndedAt: at(30).toISOString(), seen: false, summary: 'first' });
  });

  it('a Stop that handed Claude more work: still working', () => {
    const working = applyStatusEvent(null, { kind: 'prompt', prompt: 'go' }, T0);
    expect(applyStatusEvent(working, { kind: 'continue', what: 'Working on the comments you sent' }, at(5))).toMatchObject({ state: 'working', summary: 'Working on the comments you sent' });
  });

  it('notification types: a permission prompt or a dialog waits on you; idle at its prompt ends an interrupted turn', () => {
    const working = applyStatusEvent(null, { kind: 'prompt', prompt: 'go' }, T0);
    expect(applyStatusEvent(working, { kind: 'notification', type: 'permission_prompt', message: 'Claude needs your permission to use Bash' }, at(1)).state).toBe('needs_input');
    expect(applyStatusEvent(working, { kind: 'notification', type: 'elicitation_dialog', message: 'Claude needs your input' }, at(1)).state).toBe('needs_input');
    expect(applyStatusEvent(working, { kind: 'notification', type: 'idle_prompt', message: 'Claude is waiting for your input' }, at(60))).toMatchObject({ state: 'idle', seen: true, turnEndedAt: at(60).toISOString() });
    const done = applyStatusEvent(working, { kind: 'stop' }, at(10));
    expect(applyStatusEvent(done, { kind: 'notification', type: 'idle_prompt' }, at(70))).toMatchObject({ state: 'idle', seen: false }); // the nudge after a real stop: still Done
    expect(applyStatusEvent(working, { kind: 'notification', type: 'auth_success', message: 'approval granted' }, at(1)).state).toBe('working'); // typed: not the text
    // No type (an older Claude Code): the message decides, now also "needs your input".
    expect(applyStatusEvent(working, { kind: 'notification', message: 'Claude needs your input' }, at(1)).state).toBe('needs_input');
  });
});

describe('permission requests', () => {
  const bash = { tool: 'Bash', detail: 'npm test' };
  const blocked = () =>
    applyStatusEvent(applyStatusEvent(null, { kind: 'prompt', prompt: 'go' }, at(0)), {
      kind: 'notification', message: 'Claude needs your permission to use Bash', request: bash,
    }, at(5));

  it('a permission notification keeps the tool call it is about', () => {
    expect(blocked()).toMatchObject({ state: 'needs_input', request: bash });
  });

  it('allowed from the dashboard → working again; denied → idle, waiting for you; both seen', () => {
    const allowed = applyStatusEvent(blocked(), { kind: 'answered', answer: 'allow' }, at(9));
    expect(allowed).toMatchObject({ state: 'working', seen: true, summary: 'Allowed Bash: npm test' });
    const denied = applyStatusEvent(blocked(), { kind: 'answered', answer: 'deny' }, at(9));
    expect(denied).toMatchObject({ state: 'idle', seen: true });
    expect(denied.summary).toContain('Denied Bash: npm test');
  });

  it('the request is dropped by the next state change (never answered twice)', () => {
    expect(applyStatusEvent(blocked(), { kind: 'answered', answer: 'allow' }, at(9)).request).toBeUndefined();
    expect(applyStatusEvent(blocked(), { kind: 'stop', lastMessage: 'done' }, at(9)).request).toBeUndefined();
    // …but the 60 s idle nudge while still blocked keeps it.
    expect(applyStatusEvent(blocked(), { kind: 'notification', message: 'Claude is waiting for your input' }, at(65)).request).toEqual(bash);
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
    const now = T0.getTime() + 10_000;
    expect(effectiveStatus(s, T0.getTime() + ANSWERED_AFTER_MS + 500, now).state).toBe('working');
    expect(effectiveStatus(s, T0.getTime() + 1000, now).state).toBe('needs_input');
  });

  it("only a turn's message answers it — not the away summary or the exit lines Claude Code writes on its own — and an answer goes quiet after 15 min", () => {
    const s = base('needs_input');
    const wrote = T0.getTime() + 5 * 60_000; // the away summary, 5 min later
    expect(effectiveStatus(s, wrote, wrote + 1000, T0.getTime() - 1000).state).toBe('needs_input'); // newest turn entry: before the question
    expect(effectiveStatus(s, wrote, wrote + 1000, T0.getTime() + 30_000).state).toBe('working'); // a tool result after it
    expect(effectiveStatus(s, wrote, T0.getTime() + 30_000 + STALE_WORKING_MS + 1000, T0.getTime() + 30_000)).toMatchObject({ state: 'idle', stale: true });
  });

  it('an idle session with a message in its transcript after its turn ended is working (a `!` command fires no prompt hook)', () => {
    // The turn ended at T0; then an idle → idle stop keeps `since` but moves turnEndedAt.
    const ended = applyStatusEvent(applyStatusEvent(null, { kind: 'stop' }, at(0)), { kind: 'stop' }, at(100));
    expect(ended).toMatchObject({ since: at(100).toISOString(), turnEndedAt: at(100).toISOString() });
    const now = at(200).getTime();
    expect(effectiveStatus(ended, now, now, at(150).getTime())).toMatchObject({ state: 'working', seen: true, stale: false });
    // Before the last turn ended (Claude's final message precedes the Stop hook): idle.
    expect(effectiveStatus(ended, now, now, at(99).getTime()).state).toBe('idle');
    // Unknown (the caller didn't read it), or quiet for 15 min: idle.
    expect(effectiveStatus(ended, now, now, 0).state).toBe('idle');
    expect(effectiveStatus(ended, now, at(150).getTime() + STALE_WORKING_MS + 1000, at(150).getTime()).state).toBe('idle');
    // A row from before turnEndedAt: compared with since.
    const old: SessionStatus = { state: 'idle', since: at(0).toISOString(), seen: true, updatedAt: at(0).toISOString() };
    expect(effectiveStatus(old, now, now, at(10).getTime()).state).toBe('working');
  });

  it('a stop that asks for a decision records when the turn ended too', () => {
    expect(applyStatusEvent(null, { kind: 'stop', lastMessage: 'DECISION NEEDED: which one?' }, at(5)).turnEndedAt).toBe(at(5).toISOString());
  });
});

describe('lastTurnEntryMs', () => {
  it("the newest message of a turn: prompts, `!` commands and output, Claude's messages, tool results — not what Claude Code writes around a turn", () => {
    const entries = [
      { type: 'user', timestamp: '2026-10-01T08:40:36Z', message: { content: '<bash-input>dotnet publish</bash-input>' } },
      { type: 'user', timestamp: '2026-10-01T08:41:25Z', message: { content: '<bash-stdout>Build succeeded</bash-stdout>' } },
      { type: 'assistant', timestamp: '2026-10-01T08:42:22Z', message: { content: [{ type: 'text', text: 'done' }] } },
      { type: 'system', subtype: 'stop_hook_summary', timestamp: '2026-10-01T08:42:23Z' },
      { type: 'system', subtype: 'turn_duration', timestamp: '2026-10-01T08:42:23Z' },
      { type: 'user', isMeta: true, timestamp: '2026-10-01T08:45:00Z', message: { content: 'meta' } },
      { type: 'pr-link', timestamp: '2026-10-01T08:46:00Z' },
      { type: 'system', subtype: 'away_summary', timestamp: '2026-10-01T08:49:45Z' },
      { type: 'summary', summary: 'title, no timestamp' },
    ];
    expect(lastTurnEntryMs(claudeEntries(entries))).toBe(Date.parse('2026-10-01T08:42:22Z'));
    expect(lastTurnEntryMs(claudeEntries([{ type: 'system', timestamp: '2026-10-01T08:42:23Z' }]))).toBe(0);
  });

  it('slash commands and compaction are no turn; a background task’s result is', () => {
    const turn = { type: 'assistant', timestamp: '2026-10-01T08:42:22Z', message: { content: [{ type: 'text', text: 'done' }] } };
    const after = (content: string, extra: object = {}) => lastTurnEntryMs(claudeEntries([turn, { type: 'user', timestamp: '2026-10-01T08:50:00Z', message: { content }, ...extra }]));
    expect(after('<command-name>/model</command-name>')).toBe(Date.parse(turn.timestamp));
    expect(after('<local-command-stdout>Set model to opus</local-command-stdout>')).toBe(Date.parse(turn.timestamp));
    expect(after('This session is being continued…', { isCompactSummary: true })).toBe(Date.parse(turn.timestamp));
    expect(after('<task-notification>agent finished</task-notification>')).toBe(Date.parse('2026-10-01T08:50:00Z'));
    expect(after('<bash-input>ls</bash-input>')).toBe(Date.parse('2026-10-01T08:50:00Z'));
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

  it('the inbox puts review comments after done and before working, and counts them as wanting you', () => {
    const items = [
      { id: 'working', attention: s('working', true, 40), openReviewThreads: 2 }, // mid-turn: working, not review
      { id: 'review-quiet', attention: s('idle', true, 10), openReviewThreads: 1 },
      { id: 'review-untracked', attention: null, openReviewThreads: 3 },
      { id: 'quiet', attention: s('idle', true, 20) },
      { id: 'done', attention: s('idle', false, 5), openReviewThreads: 1 }, // done wins
      { id: 'blocked', attention: s('needs_input', false, 0) },
      { id: 'none', attention: null },
    ];
    expect([...items].sort(compareInbox).map((x) => x.id)).toEqual(['blocked', 'done', 'review-untracked', 'review-quiet', 'working', 'quiet', 'none']);
    expect(items.filter(wantsYou).map((x) => x.id).sort()).toEqual(['blocked', 'done', 'review-quiet', 'review-untracked']);
    expect(inboxRank({ attention: null })).toBe(5);
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

  it('a turn that paused for a permission prompt still notifies when it finishes', () => {
    // Approving the prompt fires no hook, so the stored state is still
    // needs_input when the turn's Stop arrives.
    expect(notifyKindForTransition({ state: 'needs_input' }, { state: 'idle' })).toBe('idle');
  });

  it('a Stop with no prompt hook before it (a `!` command, a background task) still notifies "Finished"', async () => {
    await recordStatusEvent('p2', { kind: 'stop', lastMessage: 'first' }, T0);
    const { prev, next } = await recordStatusEvent('p2', { kind: 'stop', lastMessage: 'background task done' }, at(300));
    expect(prev?.state).toBe('idle');
    expect(next?.prevState).toBe('working');
    expect(notifyKindForTransition({ state: next!.prevState! }, next)).toBe('idle');
  });

  it('end to end: prompt → permission → (approved, no hook) → Stop notifies "Finished"', async () => {
    await recordStatusEvent('p1', { kind: 'prompt', prompt: 'go' }, T0);
    await recordStatusEvent('p1', { kind: 'notification', message: 'Claude needs your permission to use Bash' }, at(5));
    const { prev, next } = await recordStatusEvent('p1', { kind: 'stop', lastMessage: 'done' }, at(30));
    expect(notifyKindForTransition(prev, next)).toBe('idle');
  });
});

describe('persistence', () => {
  it('records events with prevState and marks seen', async () => {
    await recordStatusEvent('s1', { kind: 'prompt', prompt: 'go' }, T0);
    await recordStatusEvent('s1', { kind: 'stop', lastMessage: 'done' }, at(10));
    expect(readStatus('s1')).toMatchObject({ state: 'idle', seen: false, prevState: 'working' });
    await markSeen('s1');
    expect(readStatus('s1')?.seen).toBe(true);
  });

  it('markSeen on an unknown session is a no-op', async () => {
    expect(await markSeen('nope')).toBeNull();
  });

  it('concurrent events for one session leave one valid status (transactional read-modify-write)', async () => {
    await Promise.all([
      recordStatusEvent('s2', { kind: 'prompt', prompt: 'a' }, T0),
      recordStatusEvent('s2', { kind: 'notification', message: 'needs your permission' }, at(1)),
      recordStatusEvent('s2', { kind: 'stop', lastMessage: 'b' }, at(2)),
    ]);
    const s = readStatus('s2');
    expect(s).not.toBeNull();
    expect(['working', 'needs_input', 'idle']).toContain(s!.state);
    expect(s!.prevState).not.toBeUndefined();
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

describe('withLiveClaude (Claude Code\'s own state over the hooks, when newer)', () => {
  const rec = (state: SessionStatus['state'], sec = 0) => ({ state, since: at(sec).toISOString(), seen: true, updatedAt: at(sec).toISOString(), stale: false });
  const known = { known: true, hosted: false };

  it('busy → working, waiting → needs input, idle ends a working or waiting record', () => {
    expect(withLiveClaude(rec('idle'), { state: 'busy', stateAt: at(5).getTime() }, known).state).toBe('working'); // a turn the hooks missed
    expect(withLiveClaude(rec('working'), { state: 'waiting', stateAt: at(5).getTime(), waitingFor: 'input needed' }, known)).toMatchObject({ state: 'needs_input', seen: false, summary: 'Waiting for you: input needed' });
    expect(withLiveClaude(rec('needs_input'), { state: 'busy', stateAt: at(5).getTime() }, known).state).toBe('working'); // answered in its terminal
    expect(withLiveClaude(rec('working'), { state: 'idle', stateAt: at(5).getTime() }, known)).toMatchObject({ state: 'idle', seen: true }); // a Stop missed, an Esc
    expect(withLiveClaude({ ...rec('idle'), seen: false }, { state: 'idle', stateAt: at(5).getTime() }, known)).toMatchObject({ state: 'idle', seen: false }); // Done stays Done
  });

  it('older than what the hooks recorded: the hooks win (the file lags a turn edge)', () => {
    expect(withLiveClaude(rec('idle', 10), { state: 'busy', stateAt: at(9).getTime() }, known).state).toBe('idle');
  });

  it('nothing running anywhere: working / waiting is over at once — unless a PTY or chat of ours runs it, or the process list was not read', () => {
    expect(withLiveClaude(rec('working'), null, known)).toMatchObject({ state: 'idle', stale: true });
    expect(withLiveClaude(rec('needs_input'), null, known).state).toBe('idle');
    expect(withLiveClaude(rec('working'), null, { known: true, hosted: true }).state).toBe('working');
    expect(withLiveClaude(rec('working'), null, { known: false, hosted: false }).state).toBe('working');
    expect(withLiveClaude({ ...rec('idle'), seen: false }, null, known)).toMatchObject({ state: 'idle', seen: false });
  });
});
