import { describe, it, expect } from 'vitest';
import { DEFAULT_PROMPTS, promptsForSession, validatePrompts } from '../../../src/core/sessions/saved-prompts.js';

describe('saved prompts', () => {
  it('validates the config list: keeps well-formed entries, trims, drops the rest', () => {
    expect(validatePrompts(undefined)).toBeUndefined();
    expect(validatePrompts('nope')).toBeUndefined();
    expect(
      validatePrompts([
        { label: ' Add tests ', prompt: ' Write tests. ', repos: ['api', 3] },
        { label: 'no prompt' },
        { prompt: 'no label' },
        null,
        { label: 'Lint', prompt: 'npm run lint', repos: [] },
      ]),
    ).toEqual([
      { label: 'Add tests', prompt: 'Write tests.', repos: ['api'] },
      { label: 'Lint', prompt: 'npm run lint' },
    ]);
    expect(validatePrompts([])).toEqual([]); // configured, deliberately empty
  });

  it('a session gets unscoped prompts and those naming its target or one of its repos', () => {
    const list = [
      { label: 'all', prompt: 'x' },
      { label: 'api only', prompt: 'x', repos: ['api'] },
      { label: 'shop group', prompt: 'x', repos: ['shop'] },
      { label: 'frontend repo', prompt: 'x', repos: ['frontend'] },
    ];
    expect(promptsForSession(list, 'api').map((p) => p.label)).toEqual(['all', 'api only']);
    expect(promptsForSession(list, 'shop', ['backend', 'frontend']).map((p) => p.label)).toEqual(['all', 'shop group', 'frontend repo']);
  });

  it('ships sensible defaults', () => {
    expect(DEFAULT_PROMPTS.map((p) => p.label)).toContain('Add tests');
    for (const p of DEFAULT_PROMPTS) expect(p.prompt.length).toBeGreaterThan(20);
  });
});
