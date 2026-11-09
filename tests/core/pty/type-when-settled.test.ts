import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PROMPT_SETTLE_MS, PROMPT_WAIT_MS, typeWhenSettled, type SettleTarget } from '../../../src/core/pty/pty-session.js';
import { agentById } from '../../../src/core/agents/index.js';
import { SUBMIT_DELAY_MS } from '../../../src/core/agents/typing.js';

/** A terminal that prints and ends when told: what typeWhenSettled watches, no process behind it. */
function fakeTerminal() {
  const data = new Set<(d: string) => void>();
  const exits: (() => void)[] = [];
  const target: SettleTarget = {
    onData(listener) {
      data.add(listener);
      return { dispose: () => data.delete(listener) };
    },
    onExit(listener) {
      exits.push(listener);
    },
  };
  return {
    target,
    print: (d = 'x') => [...data].forEach((l) => l(d)),
    exit: () => exits.forEach((l) => l()),
    listening: () => data.size,
  };
}

describe('typeWhenSettled: a prompt typed in once the agent is up', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const setup = (exited = () => false) => {
    const term = fakeTerminal();
    const submit = vi.fn(async (_text: string) => true);
    typeWhenSettled(term.target, 'fix it', { exited, submit });
    return { term, submit };
  };

  it('waits for the first output and then quiet, and types once', () => {
    const { term, submit } = setup();
    vi.advanceTimersByTime(PROMPT_SETTLE_MS * 3);
    expect(submit).not.toHaveBeenCalled(); // nothing printed yet: not up
    term.print();
    vi.advanceTimersByTime(PROMPT_SETTLE_MS - 1);
    term.print(); // still drawing: the quiet starts over
    vi.advanceTimersByTime(PROMPT_SETTLE_MS - 1);
    expect(submit).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(submit).toHaveBeenCalledTimes(1);
    expect(submit).toHaveBeenCalledWith('fix it');
    // Output after it was typed (its echo, the agent working) types nothing more, and nothing listens on.
    term.print();
    vi.advanceTimersByTime(PROMPT_WAIT_MS * 2);
    expect(submit).toHaveBeenCalledTimes(1);
    expect(term.listening()).toBe(0);
  });

  it('a terminal that never goes quiet gets it at the cap', () => {
    const { term, submit } = setup();
    const busy = setInterval(() => term.print(), PROMPT_SETTLE_MS / 2);
    vi.advanceTimersByTime(PROMPT_WAIT_MS - 1);
    expect(submit).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(submit).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(PROMPT_WAIT_MS);
    expect(submit).toHaveBeenCalledTimes(1);
    clearInterval(busy);
  });

  it('a silent terminal gets it at the cap too', () => {
    const { submit } = setup();
    vi.advanceTimersByTime(PROMPT_WAIT_MS);
    expect(submit).toHaveBeenCalledTimes(1);
  });

  it('nothing is typed into a terminal that ended first', () => {
    const { term, submit } = setup();
    term.print();
    term.exit();
    vi.advanceTimersByTime(PROMPT_WAIT_MS * 2);
    expect(submit).not.toHaveBeenCalled();
    expect(term.listening()).toBe(0);
  });

  it('nothing is typed when the session says it has exited by the time it settles', () => {
    let exited = false;
    const { term, submit } = setup(() => exited);
    term.print();
    exited = true;
    vi.advanceTimersByTime(PROMPT_SETTLE_MS);
    expect(submit).not.toHaveBeenCalled();
  });

  it('a submit that fails is only logged, never thrown', async () => {
    const term = fakeTerminal();
    const submit = vi.fn(async () => {
      throw new Error('gone');
    });
    typeWhenSettled(term.target, 'x', { exited: () => false, submit });
    vi.advanceTimersByTime(PROMPT_WAIT_MS);
    await vi.runAllTimersAsync();
    expect(submit).toHaveBeenCalledTimes(1);
  });

  it("a multi-line prompt goes through the agent's own submit whole: the text as one paste, then Enter", async () => {
    const term = fakeTerminal();
    const written: string[] = [];
    const prompt = 'line one "quoted" & more\nline two %PATH%\nline three';
    typeWhenSettled(term.target, prompt, {
      exited: () => false,
      submit: (text) =>
        agentById('claude').input.submit((d) => {
          written.push(d);
          return Promise.resolve(true);
        }, text),
    });
    term.print('ready');
    vi.advanceTimersByTime(PROMPT_SETTLE_MS);
    await vi.advanceTimersByTimeAsync(SUBMIT_DELAY_MS);
    expect(written).toEqual([prompt, '\r']);
  });
});
