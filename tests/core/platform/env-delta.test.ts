import { describe, expect, it } from 'vitest';
import { applyEnvDelta, hasEnvDelta, isEnvDelta } from '../../../src/core/platform/env-delta.js';

describe('env delta', () => {
  it('sets a name, takes one out (null), leaves the rest, and never touches its input', () => {
    const env = { PATH: '/bin', CLAUDE_CONFIG_DIR: '/other', KEEP: '1' };
    expect(applyEnvDelta(env, { CLAUDE_CONFIG_DIR: null, NEW: 'x' }, 'linux')).toEqual({ PATH: '/bin', KEEP: '1', NEW: 'x' });
    expect(applyEnvDelta(env, { CLAUDE_CONFIG_DIR: '/acc' }, 'linux')).toEqual({ PATH: '/bin', CLAUDE_CONFIG_DIR: '/acc', KEEP: '1' });
    expect(env.CLAUDE_CONFIG_DIR).toBe('/other');
    expect(applyEnvDelta(env, undefined, 'linux')).toEqual(env);
  });

  it('matches names case-blind on Windows only', () => {
    const env = { Claude_Config_Dir: '/other' };
    expect(applyEnvDelta(env, { CLAUDE_CONFIG_DIR: null }, 'win32')).toEqual({});
    expect(applyEnvDelta(env, { CLAUDE_CONFIG_DIR: '/acc' }, 'win32')).toEqual({ CLAUDE_CONFIG_DIR: '/acc' });
    expect(applyEnvDelta(env, { CLAUDE_CONFIG_DIR: null }, 'linux')).toEqual(env);
  });

  it('knows an empty delta and a malformed one', () => {
    expect(hasEnvDelta(undefined)).toBe(false);
    expect(hasEnvDelta({})).toBe(false);
    expect(hasEnvDelta({ A: null })).toBe(true);
    expect(isEnvDelta({ A: null, B: 'x' })).toBe(true);
    expect(isEnvDelta({ A: 1 })).toBe(false);
    expect(isEnvDelta(['a'])).toBe(false);
    expect(isEnvDelta(null)).toBe(false);
  });
});
