import { describe, it, expect } from 'vitest';
import {
  MAX_RECORDS,
  parseProgramStatus,
  parseProgress,
  StreamStatus,
  streamSignalFrom,
  summarize,
  type ProgramRecord,
} from '../../../src/core/pty/stream-status.js';

const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');

describe('parseProgress (OSC 9;4, as @xterm/addon-progress reads it)', () => {
  it('reads the five states', () => {
    expect(parseProgress('4;1;40', 0)).toEqual({ state: 1, percent: 40 });
    expect(parseProgress('4;0;', 40)).toEqual({ state: 0, percent: 0 });
    expect(parseProgress('4;3;', 40)).toEqual({ state: 3, percent: 40 }); // indeterminate keeps the last percent
    expect(parseProgress('4;2;0', 40)).toEqual({ state: 2, percent: 40 }); // error / paused keep it when given 0
    expect(parseProgress('4;4;70', 40)).toEqual({ state: 4, percent: 70 });
  });

  it('a missing percent is 0, a percent over 100 is 100', () => {
    expect(parseProgress('4;1', 50)).toEqual({ state: 1, percent: 0 });
    expect(parseProgress('4;1;', 50)).toEqual({ state: 1, percent: 0 });
    expect(parseProgress('4;1;250', 0)).toEqual({ state: 1, percent: 100 });
    expect(parseProgress('4;0', 50)).toEqual({ state: 0, percent: 0 });
  });

  it('ignores what is not progress or is malformed', () => {
    expect(parseProgress('Build finished', 0)).toBeUndefined(); // an iTerm2 notification
    expect(parseProgress('4', 0)).toBeUndefined(); // no `4;`
    expect(parseProgress('3;tab title', 0)).toBeUndefined(); // ConEmu's other subcommands
    expect(parseProgress('4;1;40;extra', 0)).toBeUndefined(); // more than three fields
    expect(parseProgress('4;5;40', 0)).toBeUndefined(); // state past 4
    expect(parseProgress('4;x;40', 0)).toBeUndefined();
    expect(parseProgress('4;1;-5', 0)).toBeUndefined();
    expect(parseProgress('4;1;4a', 0)).toBeUndefined();
    expect(parseProgress('4;3;junk', 20)).toEqual({ state: 3, percent: 20 }); // indeterminate never reads its percent
  });
});

describe('parseProgramStatus (OSC 7501, as @xterm/addon-program-status reads it)', () => {
  it("reads Codex's reports (codex-rs/tui/src/terminal_program_status.rs)", () => {
    expect(parseProgramStatus('state=working:app=codex')).toEqual({ id: '', state: 'working', app: 'codex' });
    expect(parseProgramStatus('state=blocked:app=codex:kind=permission')).toEqual({
      id: '',
      state: 'blocked',
      kind: 'permission',
      app: 'codex',
    });
    expect(parseProgramStatus('state=done:app=codex')).toEqual({ id: '', state: 'done', app: 'codex' });
    expect(parseProgramStatus('state=error:app=codex')).toEqual({ id: '', state: 'error', app: 'codex' });
    expect(parseProgramStatus('state=clear')).toEqual({ state: 'clear', id: '' });
  });

  it("reads Claude Code's and opencode's (ids, progress, base64 title and msg)", () => {
    const r = parseProgramStatus(
      `state=blocked:app=claude-code:id=agent1:kind=question:progress=040:title=${b64('Plan')}:msg=${b64('Pick one')}`,
    );
    expect(r).toEqual({ id: 'agent1', state: 'blocked', kind: 'question', progress: 40, app: 'claude-code', message: 'Pick one' });
    expect(parseProgramStatus(`state=working:id=ses_ab12/sub:app=opencode:title=${b64('Fix the build')}`)).toEqual({
      id: 'ses_ab12/sub',
      state: 'working',
      app: 'opencode',
    });
    expect(parseProgramStatus('state=clear:id=agent1')).toEqual({ state: 'clear', id: 'agent1' });
  });

  it('skips what it may skip: pairs without =, unknown keys, unreadable values, progress/kind where they do not apply', () => {
    expect(parseProgramStatus('junk:state=working:future=1')).toEqual({ id: '', state: 'working' });
    expect(parseProgramStatus(' state = idle ')).toEqual({ id: '', state: 'idle' });
    expect(parseProgramStatus('state=idle:progress=50:kind=auth')).toEqual({ id: '', state: 'idle' });
    expect(parseProgramStatus('state=working:progress=101')).toEqual({ id: '', state: 'working' });
    expect(parseProgramStatus('state=working:progress=4.5')).toEqual({ id: '', state: 'working' });
    expect(parseProgramStatus('state=blocked:kind=coffee')).toEqual({ id: '', state: 'blocked' });
    expect(parseProgramStatus('state=working:app=bad app')).toEqual({ id: '', state: 'working' }); // unreadable app is skipped
    expect(parseProgramStatus('state=idle:state=working')).toEqual({ id: '', state: 'working' }); // the last wins
  });

  it('discards bad reports whole', () => {
    expect(parseProgramStatus('?')).toBeUndefined(); // the probe
    expect(parseProgramStatus('')).toBeUndefined();
    expect(parseProgramStatus('app=codex')).toBeUndefined(); // no state
    expect(parseProgramStatus('state=sleeping')).toBeUndefined();
    expect(parseProgramStatus('state=working:id=a//b')).toBeUndefined();
    expect(parseProgramStatus('state=working:id=has space')).toBeUndefined();
    expect(parseProgramStatus(`state=working:id=${'a/'.repeat(8)}a`)).toBeUndefined(); // 9 segments
    expect(parseProgramStatus(`state=working:app=${'a'.repeat(33)}`)).toBeUndefined();
    expect(parseProgramStatus(`state=working:${'k'.repeat(17)}=1`)).toBeUndefined(); // an unknown key over 16 bytes
    expect(parseProgramStatus(`state=working:msg=${b64('a\nb')}`)).toBeUndefined(); // control characters
    expect(parseProgramStatus('state=working:msg=YR')).toBeUndefined(); // not the canonical encoding of "a" (YQ)
    expect(parseProgramStatus('state=working:msg=Y')).toBeUndefined();
    expect(parseProgramStatus(`state=working:msg=${b64('x'.repeat(2049))}`)).toBeUndefined();
    expect(parseProgramStatus(`state=working:junk=${'x'.repeat(4100)}`)).toBeUndefined(); // over the 4087-byte payload
  });

  it('padding is optional', () => {
    expect(parseProgramStatus('state=blocked:msg=YQ')?.state).toBe('blocked');
    expect(parseProgramStatus('state=blocked:msg=YQ==')).toMatchObject({ message: 'a' });
  });
});

describe('summarize', () => {
  const rec = (id: string, state: ProgramRecord['state']): ProgramRecord => ({ id, state });
  it('blocked beats working beats the root; the latest of each', () => {
    expect(summarize([rec('', 'idle'), rec('a', 'working'), rec('b', 'blocked'), rec('c', 'blocked')])?.id).toBe('c');
    expect(summarize([rec('', 'idle'), rec('a', 'working'), rec('b', 'done')])?.id).toBe('a');
    expect(summarize([rec('a', 'done'), rec('', 'idle'), rec('b', 'error')])?.id).toBe('');
    expect(summarize([rec('a', 'done'), rec('b', 'error')])?.id).toBe('b');
    expect(summarize([])).toBeUndefined();
  });
});

describe('StreamStatus', () => {
  const clock = () => {
    let t = Date.parse('2026-11-23T10:00:00Z');
    return { now: () => t, tick: (ms: number) => (t += ms) };
  };

  it('says nothing until something is said; a cleared bar or record says nothing again', () => {
    const s = new StreamStatus();
    expect(s.signal()).toBeNull();
    s.osc9('4;3;');
    expect(s.signal()?.progress?.state).toBe(3);
    s.osc9('4;0;');
    expect(s.signal()).toBeNull();
  });

  it("since is when the state began: Codex's repeated working keeps it, a new state moves it", () => {
    const c = clock();
    const s = new StreamStatus(c.now);
    s.osc7501('state=working:app=codex');
    const first = s.signal()?.program?.since;
    c.tick(5_000);
    s.osc7501('state=working:app=codex');
    expect(s.signal()?.program?.since).toBe(first);
    s.osc7501('state=blocked:app=codex:kind=permission');
    expect(s.signal()?.program).toMatchObject({ state: 'blocked', kind: 'permission', since: new Date(c.now()).toISOString() });
  });

  it('once OSC 7501 came, OSC 9;4 is not followed until a full reset (the spec)', () => {
    const s = new StreamStatus();
    s.osc9('4;1;30');
    expect(s.signal()).toMatchObject({ progress: { state: 1, percent: 30 } });
    s.osc7501('state=idle:app=claude-code');
    expect(s.signal()).toEqual({ program: expect.objectContaining({ state: 'idle' }) });
    s.osc7501('state=clear');
    s.osc9('4;3;');
    expect(s.signal()).toBeNull();
    s.reset();
    s.osc9('4;3;');
    expect(s.signal()?.progress?.state).toBe(3);
  });

  it('clear removes the record and those beneath it; the root clears all', () => {
    const s = new StreamStatus();
    s.osc7501('state=working:id=a');
    s.osc7501('state=blocked:id=a/b');
    s.osc7501('state=working:id=ab');
    s.osc7501('state=clear:id=a');
    expect(s.signal()?.program?.id).toBe('ab'); // not a prefix of `a/`
    s.osc7501('state=idle');
    s.osc7501('state=clear');
    expect(s.signal()).toBeNull();
  });

  it(`keeps at most ${MAX_RECORDS} records, dropping the least recently updated`, () => {
    const s = new StreamStatus();
    s.osc7501('state=blocked:id=first');
    for (let i = 0; i < MAX_RECORDS; i++) s.osc7501(`state=working:id=r${i}`);
    expect(s.signal()?.program).toMatchObject({ state: 'working', id: `r${MAX_RECORDS - 1}` }); // `first` was pushed out
    s.osc7501('state=blocked:id=r0'); // an update moves r0 to the end, so r1 goes next
    s.osc7501('state=working:id=new');
    s.osc7501('state=clear:id=r0');
    expect(s.signal()?.program).toMatchObject({ id: 'new' });
  });

  it('RIS forgets everything', () => {
    const s = new StreamStatus();
    s.osc7501('state=blocked:kind=auth');
    s.reset();
    expect(s.signal()).toBeNull();
  });
});

describe('streamSignalFrom (PtyInfo.signal off the wire: shape-checked, never cast)', () => {
  const since = '2026-11-23T12:00:00.000Z';
  it('keeps what has the shape this build reads', () => {
    const signal = {
      program: { id: 'a', state: 'blocked', kind: 'question', progress: 40, app: 'codex', message: 'Which one?', since },
      progress: { state: 3, percent: 0, since },
    };
    expect(streamSignalFrom(signal)).toEqual(signal);
  });

  it('drops the parts that do not, and an unknown kind or a bad percentage from a part it keeps', () => {
    expect(streamSignalFrom({ program: { id: '', state: 'blocked', kind: 'telepathy', progress: 400, since } })).toEqual({
      program: { id: '', state: 'blocked', since },
    });
    expect(streamSignalFrom({ program: { id: '', state: 'dancing', since }, progress: { state: 1, percent: 50, since } })).toEqual({
      progress: { state: 1, percent: 50, since },
    });
    expect(streamSignalFrom({ progress: { state: 9, percent: 50, since } })).toBeNull();
    expect(streamSignalFrom({ program: { state: 'working', since } })).toBeNull(); // no id
    for (const junk of [null, undefined, 'working', 7, [], {}]) expect(streamSignalFrom(junk)).toBeNull();
  });
});
