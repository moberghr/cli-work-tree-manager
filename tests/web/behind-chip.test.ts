// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { SessionSummary } from '../../src/web/src/api/client.js';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const api = vi.hoisted(() => ({ updateFromMain: vi.fn(), sendPromptToSession: vi.fn() }));
vi.mock('../../src/web/src/api/client.js', async (orig) => ({
  ...(await orig<typeof import('../../src/web/src/api/client.js')>()),
  updateFromMain: (id: string) => api.updateFromMain(id),
  sendPromptToSession: (id: string, t: string) => api.sendPromptToSession(id, t),
}));
const { BehindChip, behindText, describeUpdate, resolvePrompt } = await import('../../src/web/src/components/Dashboard/BehindChip.js');

const session = (behind?: SessionSummary['behind']): SessionSummary =>
  ({ id: 's1', target: 'api', branch: 'feat/x', isGroup: false, paths: [], createdAt: '', lastAccessedAt: '', activityState: 'stale', ...(behind ? { behind } : {}) }) as SessionSummary;

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  api.updateFromMain.mockReset();
  api.sendPromptToSession.mockReset().mockResolvedValue(undefined);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});
const button = (label: string) => [...container.querySelectorAll('button')].find((b) => b.textContent === label)!;

describe('behind main', () => {
  it('only worth a word from 10 commits, or with a conflict', () => {
    expect(behindText(session({ base: 'origin/main', commits: 3, conflicts: false }))).toBeNull();
    expect(behindText(session({ base: 'origin/main', commits: 34, conflicts: false }))).toBe('↓ 34 behind origin/main');
    expect(behindText(session({ base: 'origin/main', commits: 2, conflicts: true }))).toBe('↓ 2 behind origin/main · conflicts');
    expect(behindText(session())).toBeNull();
  });

  it('Update from main: says what happened', async () => {
    api.updateFromMain.mockResolvedValue([{ ok: true, repo: 'api', how: 'rebase', base: 'origin/main', commits: 34 }]);
    act(() => root.render(createElement(BehindChip, { session: session({ base: 'origin/main', commits: 34, conflicts: false }) })));
    await act(async () => button('Update from main').click());
    expect(container.textContent).toContain('api: rebased on origin/main (34 commits).');
  });

  it('a conflict: nothing changed, and Claude can be asked to resolve it', async () => {
    api.updateFromMain.mockResolvedValue([{ ok: false, repo: 'api', reason: 'merging origin/main conflicts', conflicts: true, base: 'origin/main' }]);
    act(() => root.render(createElement(BehindChip, { session: session({ base: 'origin/main', commits: 4, conflicts: true }) })));
    expect(container.textContent).toContain('⚠ ↓ 4 behind origin/main · conflicts');
    await act(async () => button('Update from main').click());
    expect(container.textContent).toContain('left as it was');
    await act(async () => button('Ask Claude to resolve').click());
    expect(api.sendPromptToSession).toHaveBeenCalledWith('s1', resolvePrompt('origin/main'));
    expect(resolvePrompt('origin/main')).toContain('DECISION NEEDED:');
  });
});

describe('describeUpdate', () => {
  it('a group that half-updated says what did change before what did not', () => {
    const out = describeUpdate([
      { ok: true, repo: 'backend', how: 'rebase', base: 'origin/main', commits: 3 },
      { ok: false, repo: 'frontend', reason: 'merging origin/main conflicts', conflicts: true, base: 'origin/main' },
    ]);
    expect(out.text).toBe('backend: rebased on origin/main (3 commits). But frontend: merging origin/main conflicts — left as it was.');
    expect(out).toMatchObject({ error: true, conflictBase: 'origin/main' });
    expect(describeUpdate([{ ok: false, repo: 'api', reason: 'merging origin/main failed: hook said no', base: 'origin/main' }])).toEqual({ text: 'api: merging origin/main failed: hook said no', error: true });
    expect(describeUpdate([{ ok: true, repo: 'api', how: 'nothing', base: 'origin/main', commits: 0 }]).text).toBe('Already up to date.');
  });
});
