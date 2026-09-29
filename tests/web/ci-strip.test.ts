// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { SessionCi, ShipPr } from '../../src/web/src/api/client.js';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const h = vi.hoisted(() => ({ ci: null as unknown as SessionCi, asked: 0, fail: null as string | null }));
vi.mock('../../src/web/src/api/events.js', () => ({ useSse: () => {} }));
vi.mock('../../src/web/src/api/client.js', async (importActual) => ({
  ...(await importActual<object>()),
  fetchSessionCi: async () => h.ci,
  askClaudeToFixCi: async () => {
    h.asked++;
    if (h.fail) throw new Error(h.fail);
  },
}));
import { CiStrip } from '../../src/web/src/components/Dashboard/CiStrip.js';

const pr = (over: Partial<ShipPr>): ShipPr => ({
  number: 12, url: 'https://gh/pr/12', state: 'OPEN', isDraft: false, mergeStateStatus: 'CLEAN', checks: 'pass', headSha: 'a', ...over,
});
let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  h.asked = 0;
  h.fail = null;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});
const render = async (repos: SessionCi['repos'], isGroup = false) => {
  h.ci = { checkedAt: '', repos };
  await act(async () => root.render(createElement(CiStrip, { sessionId: 's1', isGroup })));
  await act(async () => {});
};
const button = () => container.querySelector<HTMLButtonElement>('.wd-ci-fix');

describe('CiStrip', () => {
  it('names failing checks with links and asks Claude to fix them', async () => {
    await render([{ name: 'api', done: false, pr: pr({ checks: 'fail', failing: [{ name: 'test', url: 'https://ci/1' }, { name: 'lint' }] }) }]);
    expect(container.textContent).toContain('CI failing on #12: test, lint');
    expect(container.querySelector<HTMLAnchorElement>('a[href="https://ci/1"]')?.textContent).toBe('test');
    await act(async () => button()!.click());
    expect(h.asked).toBe(1);
    expect(container.textContent).toContain('Sent to Claude ✓');
  });

  it('names the repo in a group, and shows running checks', async () => {
    await render(
      [
        { name: 'backend', done: false, pr: pr({ checks: 'fail', failing: [{ name: 'test' }] }) },
        { name: 'frontend', done: false, pr: pr({ number: 13, checks: 'pending' }) },
      ],
      true,
    );
    expect(container.textContent).toContain('#12 backend');
    expect(container.textContent).toContain('checks running on #13 frontend');
  });

  it('is hidden when green, merged or without a PR', async () => {
    await render([
      { name: 'a', done: false, pr: pr({ checks: 'pass' }) },
      { name: 'b', done: true, pr: pr({ state: 'MERGED', checks: 'fail' }) },
      { name: 'c', done: false, pr: null },
    ]);
    expect(container.textContent).toBe('');
  });

  it('shows why asking failed', async () => {
    h.fail = 'no failing checks right now';
    await render([{ name: 'api', done: false, pr: pr({ checks: 'fail' }) }]);
    await act(async () => button()!.click());
    expect(container.querySelector('[role="alert"]')?.textContent).toBe('no failing checks right now');
  });
});
