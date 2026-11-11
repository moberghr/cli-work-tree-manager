import { describe, expect, it } from 'vitest';
import { stallWhat, TerminalPerfLog } from '../../src/web/src/state/terminal-perf.js';
import { cleanPerfReport, perfLine } from '../../src/core/pty/terminal-perf.js';

/** What the Terminal tab sends to the debug log (reported: typing froze now and then, and a tooltip can't be copied). */

const base = { sessionId: 's1', route: 'direct' as const, renderer: 'webgl' as const };

describe('TerminalPerfLog', () => {
  it('collects keys and freezes, hands them over once, and nothing when nothing happened', () => {
    const log = new TerminalPerfLog();
    expect(log.take(base)).toBeNull();
    log.key({ arrived: 10.4, shown: 27.6 });
    log.key(null); // no sample: nothing
    log.stall(
      {
        startTime: 5,
        duration: 412.3,
        blockingDuration: 380,
        scripts: [
          {
            invoker: 'Response.json.then',
            sourceFunctionName: 'load',
            sourceURL: 'http://127.0.0.1:1/assets/index-ab.js?x=1',
            duration: 60,
          },
          { invoker: 'WebSocket.onmessage', sourceFunctionName: '', sourceURL: 'http://127.0.0.1:1/assets/pty-cd.js', duration: 300 },
        ],
      },
      1_000,
    );
    const r = log.take(base)!;
    expect(r.keys).toEqual([{ arrived: 10, shown: 28 }]);
    expect(r.stalls).toEqual([
      { at: 1_000, ms: 412, blocking: 380, what: 'WebSocket.onmessage pty-cd.js 300ms; Response.json.then load index-ab.js 60ms' },
    ]);
    expect(log.take(base)).toBeNull();
    // What it sends is what the server takes.
    expect(cleanPerfReport(JSON.parse(JSON.stringify(r)))).toEqual(r);
    expect(perfLine(r)).toContain('1 keys: echo 10 / 10 / 10 ms, on screen 28 / 28 / 28 ms');
  });

  it("keeps at most a window's worth between sends; a longtask (no scripts) says nothing of what ran", () => {
    const log = new TerminalPerfLog();
    for (let i = 0; i < 500; i++) log.key({ arrived: 1, shown: 2 });
    for (let i = 0; i < 500; i++) log.stall({ startTime: 0, duration: 60 }, i);
    const r = log.take(base)!;
    expect(r.keys).toHaveLength(200);
    expect(r.stalls).toHaveLength(100);
    expect(r.stalls[0]).toEqual({ at: 0, ms: 60, blocking: null, what: '' });
    expect(stallWhat({ startTime: 0, duration: 1 })).toBe('');
  });
});
