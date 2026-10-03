import { describe, expect, it } from 'vitest';
import { matchingLines, queryWords, snippet } from '../../src/core/archive-search.js';
import { claudeEntries } from '../../src/core/agents/claude/entries.js';

const line = (o: object) => JSON.stringify(o);

describe('matchingLines', () => {
  it('messages where every word appears, up to max; tool calls, meta and tagged echoes skipped', () => {
    const raw = [
      line({ type: 'user', timestamp: 't1', message: { content: 'Rotate the encryption keys' } }),
      line({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'encryption keys' } }] } }),
      line({ type: 'user', isMeta: true, message: { content: 'encryption keys' } }),
      line({ type: 'user', message: { content: '<command-name>encryption keys</command-name>' } }),
      line({ type: 'assistant', message: { content: [{ type: 'text', text: 'Encryption KEYS rotated.' }] } }),
      'not json encryption keys',
    ].join('\n');
    const { words, jsonWords } = queryWords('encryption keys');
    expect(matchingLines(raw, words, jsonWords, 5, claudeEntries)).toEqual([
      { role: 'you', text: 'Rotate the encryption keys', at: 't1' },
      { role: 'claude', text: 'Encryption KEYS rotated.', at: null },
    ]);
    expect(matchingLines(raw, words, jsonWords, 1, claudeEntries)).toHaveLength(1);
    expect(matchingLines(raw, words, jsonWords, 0, claudeEntries)).toEqual([]);
  });

  it('query words as JSON writes them, for the raw-line pre-filter', () => {
    expect(queryWords(' Src\\Core  "x" ')).toEqual({ words: ['src\\core', '"x"'], jsonWords: ['src\\\\core', '\\"x\\"'] });
  });
});

describe('snippet', () => {
  it('cuts a snippet around the match', () => {
    const long = 'x '.repeat(200) + 'the needle is here ' + 'y '.repeat(200);
    const s = snippet(long, ['needle']);
    expect(s.startsWith('…')).toBe(true);
    expect(s).toContain('the needle is here');
    expect(s.length).toBeLessThan(260);
  });
});
