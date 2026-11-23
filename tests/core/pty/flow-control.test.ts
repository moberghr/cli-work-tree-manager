import { describe, it, expect } from 'vitest';
import { ACK_EVERY, AckCounter, LOW_WATERMARK, ackFrame, utf16Length, withFlow } from '../../../src/core/pty/flow-control.js';

describe('utf16Length (a client counts what it drew in the host’s unit)', () => {
  const enc = new TextEncoder();
  it.each(['plain ascii', '\x1b[31mred\x1b[0m', 'čćžšđ', '日本語', '😀 emoji 👍🏽', 'é́', ''])('matches the string length of %j', (text) => {
    expect(utf16Length(enc.encode(text))).toBe(text.length);
  });

  it('adds up when the bytes are split inside a sequence (frames are cut anywhere)', () => {
    const text = 'a😀b€c日';
    const bytes = enc.encode(text);
    for (let cut = 0; cut <= bytes.length; cut++) {
      expect(utf16Length(bytes.subarray(0, cut)) + utf16Length(bytes.subarray(cut))).toBe(text.length);
    }
  });

  it('counts a lone surrogate as the one U+FFFD it is sent as', () => {
    const text = 'x\ud800y';
    expect(utf16Length(enc.encode(text))).toBe(text.length);
  });
});

describe('AckCounter', () => {
  it('acks once ACK_EVERY characters are drawn, with the exact count, and keeps the rest', () => {
    const sent: number[] = [];
    const acks = new AckCounter((n) => sent.push(n));
    acks.drawn(ACK_EVERY - 1);
    expect(sent).toEqual([]);
    acks.drawn(10);
    expect(sent).toEqual([ACK_EVERY + 9]);
    acks.drawn(ACK_EVERY - 10);
    expect(sent).toEqual([ACK_EVERY + 9]);
    acks.drawn(10);
    expect(sent).toEqual([ACK_EVERY + 9, ACK_EVERY]);
    acks.drawn(0);
    acks.drawn(-5);
    expect(sent).toHaveLength(2);
  });

  it('acks often enough that a client which drew everything counts as caught up', () => {
    expect(ACK_EVERY).toBeLessThanOrEqual(LOW_WATERMARK);
  });
});

describe('negotiation', () => {
  it('adds the flow parameter to an attach address, with or without a query', () => {
    expect(withFlow('ws://127.0.0.1:1/attach/s1')).toBe('ws://127.0.0.1:1/attach/s1?flow=1');
    expect(withFlow('ws://127.0.0.1:1/attach/s1?token=t')).toBe('ws://127.0.0.1:1/attach/s1?token=t&flow=1');
    expect(new URL(withFlow('ws://h/x?a=1')).searchParams.get('flow')).toBe('1');
    // work attach: its catch-up screens without the scrollback.
    const attach = new URL(withFlow('ws://h/x?token=t', { screenOnly: true }));
    expect([attach.searchParams.get('flow'), attach.searchParams.get('catchup')]).toEqual(['1', 'screen']);
    expect(withFlow('ws://h/x')).not.toContain('catchup');
  });

  it('the ack frame', () => {
    expect(JSON.parse(ackFrame(5123))).toEqual({ type: 'ack', chars: 5123 });
  });
});
