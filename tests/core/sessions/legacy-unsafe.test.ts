import { describe, expect, it, vi } from 'vitest';
import { howToLift, legacyUnsafeCase, startedUnsafeBefore, stillUnsafeMessage } from '../../../src/core/sessions/legacy-unsafe.js';

/** One release of guards for an agent still running as started `--unsafe` before the retirement (legacy-unsafe.ts). */

describe('legacyUnsafeCase', () => {
  it("an older host's restore entry (`unsafe: true`) guards; a current host's entry doesn't by itself", () => {
    const outside = vi.fn(() => false);
    expect(legacyUnsafeCase({}, { cwd: '/x', unsafe: true }, outside)).toBe('old-host');
    expect(legacyUnsafeCase({ launchedUnsafe: true }, { cwd: '/x' }, outside)).toBeNull();
    expect(legacyUnsafeCase({ launchedUnsafe: true }, { cwd: '/x', unsafe: 'yes' }, outside)).toBeNull();
    // Nothing on the row: the outside agents aren't looked for.
    expect(legacyUnsafeCase({}, { cwd: '/x' }, outside)).toBeNull();
    expect(outside).toHaveBeenCalledTimes(2);
  });

  it("the row's launchedUnsafe while an agent of it runs outside the host — even when a current host also has an entry (N1)", () => {
    expect(legacyUnsafeCase({ launchedUnsafe: true }, undefined, () => true)).toBe('outside');
    // A new host entry without `unsafe` beside the old direct launch: still guarded.
    expect(legacyUnsafeCase({ launchedUnsafe: true }, { cwd: '/x' }, () => true)).toBe('outside');
    expect(legacyUnsafeCase({ launchedUnsafe: true }, { cwd: '/x', unsafe: true }, () => true)).toBe('both');
    // Not running: its next start is a normal one.
    expect(legacyUnsafeCase({ launchedUnsafe: true }, undefined, () => false)).toBeNull();
    expect(legacyUnsafeCase({}, undefined, () => true)).toBeNull();
    expect(legacyUnsafeCase(null, undefined, () => true)).toBeNull();
    expect(startedUnsafeBefore({ launchedUnsafe: true }, { cwd: '/x' }, () => true)).toBe(true);
    expect(startedUnsafeBefore({ launchedUnsafe: true }, { cwd: '/x' }, () => false)).toBe(false);
  });

  it('says what lifts it, per case (N2)', () => {
    expect(stillUnsafeMessage('old-host')).toBe(
      'this agent still runs without permission prompts from before --unsafe was retired: run `work pty-host --restart` (the host is from before --unsafe was retired)',
    );
    expect(stillUnsafeMessage('outside')).toBe(
      'this agent still runs without permission prompts from before --unsafe was retired: quit it in its terminal and start it again with `work tree`',
    );
    expect(howToLift('both')).toBe(`${howToLift('old-host')}, and ${howToLift('outside')}`);
  });
});
