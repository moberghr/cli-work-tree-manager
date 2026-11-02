import { describe, expect, it } from 'vitest';
import { openBackgroundCommands } from '../../../../src/core/agents/claude/background-commands.js';

/** Transcript lines as Claude Code writes them (shapes taken from a real transcript). */
const at = (min: number) => new Date(Date.parse('2026-10-28T10:00:00Z') + min * 60_000).toISOString();
const call = (
  id: string,
  min: number,
  input: Record<string, unknown> = { command: 'npm test', run_in_background: true },
  name = 'Bash',
) => ({
  type: 'assistant',
  timestamp: at(min),
  message: { content: [{ type: 'tool_use', id, name, input }] },
});
const result = (useId: string, min: number, text: string, isError = false) => ({
  type: 'user',
  timestamp: at(min),
  message: { content: [{ type: 'tool_result', tool_use_id: useId, content: text, ...(isError ? { is_error: true } : {}) }] },
});
const started = (useId: string, task: string, min: number) =>
  result(useId, min, `Command running in background with ID: ${task}. Output is being written to: C:\\tmp\\${task}.output.`);
const notified = (useId: string, task: string, min: number) => ({
  type: 'user',
  timestamp: at(min),
  message: {
    content: `<task-notification>\n<task-id>${task}</task-id>\n<tool-use-id>${useId}</tool-use-id>\n<status>completed</status>\n</task-notification>`,
  },
});

describe('openBackgroundCommands — what a Claude still has running in the background', () => {
  it('started and not ended: running; ended by its notification: not', () => {
    const lines = [call('u1', 1), started('u1', 'b1', 1), call('u2', 2), started('u2', 'b2', 2), notified('u2', 'b2', 5)];
    expect(openBackgroundCommands(lines)).toEqual(['u1']);
  });

  it('stopped with TaskStop (KillShell before) by its task id: not running', () => {
    const lines = [
      call('u1', 1),
      started('u1', 'b1', 1),
      call('u2', 2),
      started('u2', 'b2', 2),
      call('s1', 3, { task_id: 'b1' }, 'TaskStop'),
      call('s2', 3, { shell_id: 'b2' }, 'KillShell'),
    ];
    expect(openBackgroundCommands(lines)).toEqual([]);
  });

  it('a notification naming only the task ends it too; one in a text block is read', () => {
    const lines = [
      call('u1', 1),
      started('u1', 'b1', 1),
      {
        type: 'user',
        timestamp: at(4),
        message: { content: [{ type: 'text', text: '<task-notification><task-id>b1</task-id></task-notification>' }] },
      },
    ];
    expect(openBackgroundCommands(lines)).toEqual([]);
  });

  it('an end notice counts wherever Claude Code wrote it: queued, as an attachment, or only in an api-request-blob', () => {
    const note = (useId: string, task: string) =>
      `<task-notification>\n<task-id>${task}</task-id>\n<tool-use-id>${useId}</tool-use-id>\n<status>completed</status>\n</task-notification>`;
    const lines = [
      call('u1', 1),
      started('u1', 'b1', 1),
      call('u2', 2),
      started('u2', 'b2', 2),
      call('u3', 3),
      started('u3', 'b3', 3),
      { type: 'queue-operation', operation: 'enqueue', timestamp: at(4), content: note('u1', 'b1') },
      { type: 'attachment', timestamp: at(4), attachment: { type: 'queued_command', prompt: note('u2', 'b2') } },
      { type: 'api-request-blob', message: { role: 'system', content: note('u3', 'b3') } },
    ];
    expect(openBackgroundCommands(lines)).toEqual([]);
  });

  it("an api-request-blob copy of a call after its stop doesn't start it again (59 of 259 looked open in a real transcript)", () => {
    const copy = { ...call('u1', 1), type: 'api-request-blob' };
    const lines = [call('u1', 1), started('u1', 'b1', 1), call('s1', 2, { task_id: 'b1' }, 'TaskStop'), copy, call('u1', 1)];
    expect(openBackgroundCommands(lines)).toEqual([]);
  });

  it('a call that failed never ran; a foreground call is not a background one', () => {
    const lines = [call('u1', 1), result('u1', 1, 'Error: refused', true), call('u2', 2, { command: 'ls' }), result('u2', 2, 'a b')];
    expect(openBackgroundCommands(lines)).toEqual([]);
  });

  it('only calls made since the Claude started (a restarted Claude lost its old ones without a word)', () => {
    const lines = [call('old', 1), started('old', 'b0', 1), call('new', 10), started('new', 'b9', 10)];
    expect(openBackgroundCommands(lines, Date.parse(at(5)))).toEqual(['new']);
    expect(openBackgroundCommands(lines)).toEqual(['old', 'new']);
  });

  it("run_in_background as a string (as Claude Code sometimes writes it) counts; lines that aren't objects are skipped", () => {
    expect(openBackgroundCommands([null, 'x', call('u1', 1, { run_in_background: 'true' })])).toEqual(['u1']);
  });
});
