// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { engineChoice, readEngineSetting, resetEngineSetting } from '../../src/web/src/components/Terminal/engine/terminal-engine.js';

beforeEach(() => {
  localStorage.clear();
  resetEngineSetting();
});
afterEach(() => {
  localStorage.clear();
  resetEngineSetting();
});

const settings = (terminalEngine: unknown) => () => Promise.resolve({ values: { terminalEngine } });

describe('which engine a terminal uses', () => {
  it('xterm.js when nothing says otherwise', () => {
    expect(engineChoice('')).toBe('xterm');
  });

  it('the terminalEngine setting once read, and remembered for the next page load', async () => {
    await readEngineSetting(settings('ghostty'));
    expect(engineChoice('')).toBe('ghostty');
    resetEngineSetting();
    expect(engineChoice('')).toBe('ghostty');
  });

  it('a setting that is not an engine is xterm.js; a failed read keeps the one last known', async () => {
    await readEngineSetting(settings('nonsense'));
    expect(engineChoice('')).toBe('xterm');
    localStorage.setItem('work.terminalEngine.setting', 'ghostty');
    resetEngineSetting();
    await readEngineSetting(() => Promise.reject(new Error('offline')));
    expect(engineChoice('')).toBe('ghostty');
  });

  it('?terminalEngine= wins over the setting and is kept in this browser; empty forgets it', async () => {
    await readEngineSetting(settings('xterm'));
    expect(engineChoice('?terminalEngine=ghostty')).toBe('ghostty');
    expect(engineChoice('')).toBe('ghostty');
    expect(engineChoice('?terminalEngine=')).toBe('xterm');
    expect(engineChoice('')).toBe('xterm');
  });

  it('the setting is read once per page', async () => {
    let reads = 0;
    const load = () => {
      reads++;
      return Promise.resolve({ values: { terminalEngine: 'ghostty' } });
    };
    await Promise.all([readEngineSetting(load), readEngineSetting(load)]);
    await readEngineSetting(load);
    expect(reads).toBe(1);
  });
});
