import { describe, expect, it } from 'vitest';
import { withOwnStatusLine, type SettingsSource } from '../../../src/core/settings/settings-source.js';

describe('withOwnStatusLine (what work web serves as GET /api/settings)', () => {
  it('adds whether the user has a status line of their own to each read, asked each time; the rest as it was', async () => {
    let own = false;
    const base: SettingsSource = {
      read: () => ({ values: { aiCommand: 'claude' }, configPath: '/c.json' }),
      write: async () => ({ values: {}, configPath: '/c.json' }),
      readRepo: () => {
        throw new Error('unused');
      },
      writeRepo: async () => {
        throw new Error('unused');
      },
    };
    const src = withOwnStatusLine(base, () => own);
    expect(src.read()).toEqual({ values: { aiCommand: 'claude' }, configPath: '/c.json', ownStatusLine: false });
    own = true;
    expect(src.read().ownStatusLine).toBe(true);
    expect(src.write).toBe(base.write);
  });
});
