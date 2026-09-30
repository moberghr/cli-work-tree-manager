import { describe, expect, it } from 'vitest';
import { chatItems, resultText, type ChatMessage } from '../../src/core/chat-view.js';

const msgs = (...raws: unknown[]): ChatMessage[] => raws.map((raw, seq) => ({ seq, raw }));

describe('chatItems', () => {
  it('draws user and assistant text, and leaves the protocol noise out', () => {
    const items = chatItems(msgs(
      { type: 'system', subtype: 'init', session_id: 's' },
      { type: 'user', message: { role: 'user', content: 'Fix the login bug' } },
      { type: 'stream_event', event: { type: 'content_block_delta' } },
      { type: 'rate_limit_event', rate_limit_info: {} },
      { type: 'assistant', message: { content: [{ type: 'thinking', thinking: '' }, { type: 'text', text: 'On it.' }] } },
    ));
    expect(items.map((i) => [i.kind, 'text' in i ? i.text : ''])).toEqual([
      ['user', 'Fix the login bug'],
      ['text', 'On it.'],
    ]);
  });

  it('pairs each tool call with its result, whatever the tool', () => {
    const items = chatItems(msgs(
      { type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'SomeNewTool', input: { x: 1 } }] } },
      { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: 'done' }], is_error: true }] } },
    ));
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: 'tool', name: 'SomeNewTool', input: { x: 1 }, result: { text: 'done', isError: true } });
  });

  it('shows what it does not know raw instead of dropping it', () => {
    const items = chatItems(msgs(
      { type: 'assistant', message: { content: [{ type: 'brand_new_block', data: 1 }] } },
      { type: 'something_new', payload: true },
      { type: 'system', subtype: 'new_subtype' },
    ));
    expect(items.map((i) => (i.kind === 'raw' ? i.label : i.kind))).toEqual(['brand_new_block', 'something_new', 'system new_subtype']);
  });

  it('turns results, interrupts and compaction into short lines', () => {
    const items = chatItems(msgs(
      { type: 'user', message: { content: [{ type: 'text', text: '[Request interrupted by user]' }] } },
      { type: 'result', subtype: 'success', is_error: false, duration_ms: 4200, total_cost_usd: 0.02 },
      { type: 'system', subtype: 'compact_boundary' },
    ));
    expect(items).toMatchObject([
      { kind: 'notice', text: 'Interrupted' },
      { kind: 'result', ok: true, durationMs: 4200, costUsd: 0.02 },
      { kind: 'notice', text: 'Conversation compacted' },
    ]);
  });

  it('skips meta and subagent entries from a transcript', () => {
    expect(chatItems(msgs(
      { type: 'user', isMeta: true, message: { content: 'caveat' } },
      { type: 'assistant', isSidechain: true, message: { content: [{ type: 'text', text: 'subagent' }] } },
    ))).toEqual([]);
  });

  it('reads tool results as text', () => {
    expect(resultText('plain')).toBe('plain');
    expect(resultText([{ type: 'text', text: 'a' }, { type: 'image' }])).toBe('a\n[image]');
  });
});
