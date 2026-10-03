// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { ChatSnapshot } from '../../src/core/api-types.js';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const api = vi.hoisted(() => ({
  sendChatMessage: vi.fn(async () => {}),
  interruptChat: vi.fn(async () => {}),
  answerChatPermission: vi.fn(async () => {}),
}));
vi.mock('../../src/web/src/api/client.js', () => api);

import { ChatView } from '../../src/web/src/components/Chat/ChatView.js';

/** An EventSource the test drives. */
class FakeEventSource {
  static last: FakeEventSource | null = null;
  private handlers = new Map<string, (e: MessageEvent) => void>();
  closed = false;
  constructor(readonly url: string) {
    FakeEventSource.last = this;
  }
  addEventListener(type: string, fn: (e: MessageEvent) => void) {
    this.handlers.set(type, fn);
  }
  close() {
    this.closed = true;
  }
  fire(type: string, payload: unknown) {
    act(() => this.handlers.get(type)?.({ data: JSON.stringify(payload) } as MessageEvent));
  }
}

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  (globalThis as { EventSource: unknown }).EventSource = FakeEventSource;
  for (const f of Object.values(api)) f.mockClear();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const snapshot = (over: Partial<ChatSnapshot> = {}): ChatSnapshot => ({
  sessionId: 's1',
  state: 'idle',
  error: null,
  conversationId: 'c1',
  messages: [
    { seq: 0, records: [{ kind: 'you', text: 'Run the tests' }] },
    {
      seq: 1,
      records: [
        { kind: 'text', text: 'Running them.' },
        { kind: 'tool', id: 't1', name: 'Bash', input: { command: 'npm test', description: 'Run tests' } },
      ],
    },
  ],
  partial: null,
  permissions: [],
  ...over,
});

const mount = () => act(() => root.render(createElement(ChatView, { sessionId: 's1' })));
const text = () => container.textContent?.replace(/\s+/g, ' ') ?? '';

describe('ChatView', () => {
  it('draws the conversation from the stream: messages, tool cards, live text', () => {
    mount();
    expect(FakeEventSource.last!.url).toBe('/api/sessions/s1/chat/events');
    FakeEventSource.last!.fire('snapshot', { type: 'snapshot', snapshot: snapshot() });
    expect(text()).toContain('Run the tests');
    expect(text()).toContain('Running them.');
    expect(container.querySelector('.wd-chat-tool-name')?.textContent).toBe('Bash');
    expect(container.querySelector('.wd-chat-tool-summary')?.textContent).toBe('Run tests');

    FakeEventSource.last!.fire('partial', { type: 'partial', partial: { kind: 'text', text: 'All 12 pass' } });
    expect(container.querySelector('.wd-chat-live')?.textContent).toContain('All 12 pass');
    FakeEventSource.last!.fire('message', {
      type: 'message',
      message: { seq: 2, records: [{ kind: 'tool-result', toolId: 't1', text: '12 passed', isError: false }] },
    });
    expect(container.querySelector('.wd-chat-tool-running')).toBeNull(); // the result arrived
  });

  it('shows a `!` command as a command with its output, not as tags', () => {
    mount();
    FakeEventSource.last!.fire('snapshot', {
      type: 'snapshot',
      snapshot: snapshot({
        messages: [
          { seq: 0, records: [{ kind: 'tagged', parts: [{ tag: 'bash-input', text: 'wd' }] }] },
          {
            seq: 1,
            records: [
              {
                kind: 'tagged',
                parts: [
                  { tag: 'bash-stdout', text: 'Opening: http://x' },
                  { tag: 'bash-stderr', text: '' },
                ],
              },
            ],
          },
        ],
      }),
    });
    const blocks = [...container.querySelectorAll('.wd-chat-local')].map((b) => b.textContent);
    expect(blocks).toEqual(['$ wd', 'Opening: http://x']);
    expect(text()).not.toContain('<bash');
  });

  it('asks for a pending permission on its tool card, and answers', () => {
    mount();
    FakeEventSource.last!.fire('snapshot', {
      type: 'snapshot',
      snapshot: snapshot({
        state: 'needs_input',
        permissions: [{ id: 'p1', toolName: 'Bash', input: { command: 'npm test' }, toolUseId: 't1', at: 1 }],
      }),
    });
    const allow = [...container.querySelectorAll('button')].find((b) => b.textContent === 'Allow')!;
    act(() => allow.click());
    expect(api.answerChatPermission).toHaveBeenCalledWith('s1', 'p1', true);
  });

  it('sends on Enter and offers to move a terminal session into the chat', async () => {
    api.sendChatMessage.mockRejectedValueOnce(new Error('terminal-running'));
    mount();
    FakeEventSource.last!.fire('snapshot', { type: 'snapshot', snapshot: snapshot() });
    const box = container.querySelector('textarea')!;
    const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
    act(() => {
      setValue.call(box, 'Now fix the failing one');
      box.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => {
      box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    expect(api.sendChatMessage).toHaveBeenCalledWith('s1', 'Now fix the failing one', false);
    const move = [...container.querySelectorAll('button')].find((b) => b.textContent === 'Move it here and send')!;
    expect(move).toBeDefined();
    await act(async () => move.click());
    expect(api.sendChatMessage).toHaveBeenLastCalledWith('s1', 'Now fix the failing one', true);
  });
});
