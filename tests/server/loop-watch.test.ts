import { describe, expect, it } from 'vitest';
import { describeStall, watchLoop, type Stall } from '../../src/server/loop-watch.js';

const block = (ms: number) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    /* a synchronous job holding the loop */
  }
};

describe('watchLoop', () => {
  it('reports a stall past the threshold, with the slowest request meanwhile — and nothing when the loop is free', async () => {
    const stalls: Stall[] = [];
    const w = watchLoop({ everyMs: 150, thresholdMs: 100, onStall: (s) => stalls.push(s) });
    await new Promise((r) => setTimeout(r, 400)); // free: nothing
    expect(stalls).toEqual([]);
    w.request('GET /api/sessions', 30); // fast: not remembered
    w.request('POST /api/sessions/x/archive', 320);
    block(300);
    await new Promise((r) => setTimeout(r, 400));
    w.stop();
    expect(stalls.length).toBeGreaterThanOrEqual(1);
    expect(stalls[0].blockedMs).toBeGreaterThanOrEqual(200);
    expect(stalls[0].slowest).toEqual({ what: 'POST /api/sessions/x/archive', ms: 320 });
  });

  it('says it in one line', () => {
    expect(describeStall({ blockedMs: 2400, slowest: { what: 'GET /api/digest', ms: 2300 } })).toBe(
      'the server was blocked for 2.4 s (status updates, terminals and notifications waited); slowest request: GET /api/digest (2.3 s)',
    );
  });
});
