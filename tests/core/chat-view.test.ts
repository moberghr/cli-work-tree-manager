import { describe, expect, it } from 'vitest';
import { chatItems, splitTagged, stripAnsi, type ChatMessage, type ChatRecord } from '../../src/core/chat-view.js';

/** The chat in work's terms: records an adapter read, drawn the same whatever the agent. */

const msgs = (...lines: ChatRecord[][]): ChatMessage[] => lines.map((records, seq) => ({ seq, records }));

describe('chatItems', () => {
  it('draws your messages and the agent’s text and thinking', () => {
    const items = chatItems(msgs([{ kind: 'you', text: 'Fix the login bug' }], [{ kind: 'thinking', text: 'hm' }, { kind: 'text', text: 'On it.' }]));
    expect(items.map((i) => [i.kind, 'text' in i ? i.text : ''])).toEqual([
      ['user', 'Fix the login bug'],
      ['thinking', 'hm'],
      ['text', 'On it.'],
    ]);
    expect(new Set(items.map((i) => i.key)).size).toBe(3); // a key each
  });

  it('pairs each tool call with its result, whatever the tool', () => {
    const items = chatItems(msgs([{ kind: 'tool', id: 't1', name: 'SomeNewTool', input: { x: 1 } }], [{ kind: 'tool-result', toolId: 't1', text: 'done', isError: true }]));
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: 'tool', name: 'SomeNewTool', input: { x: 1 }, result: { text: 'done', isError: true } });
  });

  it('a result for no call it knows is a short line; a tool waiting has no result yet', () => {
    const items = chatItems(msgs([{ kind: 'tool-result', toolId: 'gone', text: 'orphan', isError: false }], [{ kind: 'tool', id: 't2', name: 'Bash', input: {} }]));
    expect(items).toMatchObject([{ kind: 'notice', text: 'orphan' }, { kind: 'tool', result: null }]);
  });

  it('a turn’s end, notices, tagged text and raw records pass through', () => {
    const items = chatItems(msgs(
      [{ kind: 'turn-end', ok: true, subtype: 'success', durationMs: 4200, costUsd: 0.02 }],
      [{ kind: 'notice', text: 'Interrupted' }],
      [{ kind: 'tagged', parts: [{ tag: 'bash-input', text: 'wd' }] }],
      [{ kind: 'raw', label: 'something_new', raw: { a: 1 } }],
    ));
    expect(items).toMatchObject([
      { kind: 'result', ok: true, durationMs: 4200, costUsd: 0.02 },
      { kind: 'notice', text: 'Interrupted' },
      { kind: 'tagged', parts: [{ tag: 'bash-input', text: 'wd' }] },
      { kind: 'raw', label: 'something_new', raw: { a: 1 } },
    ]);
  });
});

describe('text helpers', () => {
  it('strips terminal codes', () => {
    expect(stripAnsi('\u001b[1;31mred\u001b[0m \u001b]8;;http://x\u0007link\u001b]8;;\u0007')).toBe('red link');
  });
  it('splits tagged segments out of text', () => {
    expect(splitTagged('Look at <custom-tag>\u001b[90mx\u001b[39m</custom-tag> this')).toEqual({ plain: 'Look at  this', parts: [{ tag: 'custom-tag', text: 'x' }] });
  });
});
