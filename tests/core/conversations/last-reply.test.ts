import { describe, expect, it } from 'vitest';
import { lastReplyOf } from '../../../src/core/conversations/last-reply.js';
import type { ConversationEntry } from '../../../src/core/agents/types.js';

const e = (role: ConversationEntry['role'], text: string, over: Partial<ConversationEntry> = {}): ConversationEntry => ({
  at: '2026-10-28T08:00:00Z',
  role,
  text,
  ...over,
});

describe('lastReplyOf', () => {
  it("the agent's newest message, as written — not a tool call, a tool result, a sub-agent's message or an empty one", () => {
    const entries = [
      e('you', 'Fix it'),
      e('agent', 'First answer'),
      e('agent', '## Fixed\n\nThe **build** passes.\n'),
      e('tool', 'Bash npm test'),
      e('tool-result', 'ok'),
      e('agent', 'a sub-agent says hi', { sidechain: true }),
      e('agent', '   '),
    ];
    expect(lastReplyOf(entries)).toBe('## Fixed\n\nThe **build** passes.');
  });

  it('none yet: null', () => {
    expect(lastReplyOf([e('you', 'hello')])).toBeNull();
    expect(lastReplyOf([])).toBeNull();
  });
});
