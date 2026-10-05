import { describe, expect, it } from 'vitest';
import { WEBGL_LOSS_WINDOW_MS, WEBGL_RETRY_MS, WebglRecovery } from '../../src/web/src/state/webgl-recovery.js';

describe('WebglRecovery', () => {
  it('tries again after a pause, longer each time, and gives up when it keeps losing the context', () => {
    const r = new WebglRecovery();
    expect(r.lost(0)).toBe(WEBGL_RETRY_MS[0]);
    expect(r.lost(5_000)).toBe(WEBGL_RETRY_MS[1]);
    expect(r.lost(20_000)).toBe(WEBGL_RETRY_MS[2]);
    expect(r.lost(90_000)).toBeNull();
  });

  it('forgets old losses: a GPU reset now and then always recovers', () => {
    const r = new WebglRecovery();
    r.lost(0);
    r.lost(1_000);
    r.lost(2_000);
    expect(r.lost(2_000 + WEBGL_LOSS_WINDOW_MS)).toBe(WEBGL_RETRY_MS[0]);
  });
});
