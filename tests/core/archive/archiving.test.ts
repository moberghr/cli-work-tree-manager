import { describe, expect, it } from 'vitest';
import {
  isArchiving,
  isRestoring,
  noClaudeBecause,
  onArchivingChange,
  whileArchiving,
  whileRestoring,
} from '../../../src/core/archive/archiving.js';

describe('sessions being archived', () => {
  it('listeners hear the start and the end, a failed archive included; isArchiving holds in between', async () => {
    const heard: Array<[string, string, boolean, boolean]> = [];
    const off = onArchivingChange((id, what, on) => heard.push([id, what, on, what === 'archiving' ? isArchiving(id) : isRestoring(id)]));
    try {
      await whileArchiving('s1', async () => {
        expect(noClaudeBecause(null, 's1')).toBe('This session is being archived.');
      });
      await expect(
        whileArchiving('s2', async () => {
          throw new Error('nope');
        }),
      ).rejects.toThrow('nope');
      await whileRestoring('s5', async () => {
        expect(isRestoring('s5')).toBe(true);
        expect(isArchiving('s5')).toBe(false);
      });
    } finally {
      off();
    }
    expect(heard).toEqual([
      ['s1', 'archiving', true, true],
      ['s1', 'archiving', false, false],
      ['s2', 'archiving', true, true],
      ['s2', 'archiving', false, false],
      ['s5', 'restoring', true, true],
      ['s5', 'restoring', false, false],
    ]);
    await whileArchiving('s3', async () => {});
    expect(heard).toHaveLength(6); // unsubscribed
  });

  it("a listener that throws doesn't stop the archive", async () => {
    const off = onArchivingChange(() => {
      throw new Error('listener');
    });
    try {
      await expect(whileArchiving('s4', async () => 'done')).resolves.toBe('done');
    } finally {
      off();
    }
  });
});
