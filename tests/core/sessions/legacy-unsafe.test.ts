import { describe, expect, it, vi } from 'vitest';
import { startedUnsafeBefore, STILL_UNSAFE } from '../../../src/core/sessions/legacy-unsafe.js';

/** One release of guards for an agent still running as started `--unsafe` before the retirement (legacy-unsafe.ts). */

describe('startedUnsafeBefore', () => {
  it("the host's restore entry decides while it has one: an older host's `unsafe: true` guards, a current host's entry doesn't", () => {
    const outside = vi.fn(() => true);
    expect(startedUnsafeBefore({}, { cwd: '/x', unsafe: true }, outside)).toBe(true);
    // Restarted by a current host: its entry no longer says unsafe, whatever the old row says.
    expect(startedUnsafeBefore({ launchedUnsafe: true }, { cwd: '/x' }, outside)).toBe(false);
    expect(startedUnsafeBefore({ launchedUnsafe: true }, { cwd: '/x', unsafe: 'yes' }, outside)).toBe(false);
    expect(outside).not.toHaveBeenCalled();
  });

  it("with no entry: the row's launchedUnsafe, only while an agent of it runs outside the host", () => {
    expect(startedUnsafeBefore({ launchedUnsafe: true }, undefined, () => true)).toBe(true);
    // Not running: its next start is a normal one.
    expect(startedUnsafeBefore({ launchedUnsafe: true }, undefined, () => false)).toBe(false);
    expect(startedUnsafeBefore({}, undefined, () => true)).toBe(false);
    expect(startedUnsafeBefore(null, undefined, () => true)).toBe(false);
  });

  it('says what to do', () => {
    expect(STILL_UNSAFE).toBe(
      'this agent still runs without permission prompts from before --unsafe was retired: restart it (work restart) first',
    );
  });
});
