import { describe, expect, it } from 'vitest';
import { relativeTime, timeAgo } from '../../src/web/src/utils/time.js';

describe('timeAgo', () => {
  const now = Date.parse('2026-11-10T10:00:00Z');
  it('"just now" alone, never "just now ago" (it read so on a review submitted a moment ago); else the age with ago', () => {
    expect(timeAgo('2026-11-10T09:59:50Z', now)).toBe('just now');
    expect(timeAgo('2026-11-10T09:56:00Z', now)).toBe(`${relativeTime('2026-11-10T09:56:00Z', now)} ago`);
    expect(timeAgo('2026-11-10T09:56:00Z', now)).toBe('4m ago');
    expect(timeAgo('not a date', now)).toBe('');
  });
});
