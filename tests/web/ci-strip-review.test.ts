// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { SessionCi, ShipPr } from '../../src/web/src/api/client.js';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const h = vi.hoisted(() => ({ ci: null as unknown as SessionCi }));
vi.mock('../../src/web/src/api/events.js', () => ({ useSse: () => {} }));
vi.mock('../../src/web/src/api/client.js', async (importActual) => ({
  ...(await importActual<object>()),
  fetchSessionCi: async () => h.ci,
  askClaudeToFixCi: async () => {},
}));
import { CiStrip } from '../../src/web/src/components/Dashboard/CiStrip.js';

const pr = (over: Partial<ShipPr> = {}): ShipPr => ({
  number: 12, url: 'https://gh/pr/12', state: 'OPEN', isDraft: false, mergeStateStatus: 'CLEAN', checks: 'pass', headSha: 'a', ...over,
});
let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});
const render = async (repos: SessionCi['repos']) => {
  h.ci = { checkedAt: '', repos };
  await act(async () => root.render(createElement(CiStrip, { sessionId: 's1', isGroup: false })));
  await act(async () => {});
};

describe('CiStrip review threads', () => {
  it('shows open review threads on a green PR, linked to its files', async () => {
    await render([{ name: 'api', done: false, pr: pr(), openThreads: 2 }]);
    expect(container.textContent).toContain('2 open review threads on #12');
    expect(container.querySelector<HTMLAnchorElement>('a[href="https://gh/pr/12/files"]')).not.toBeNull();
    expect(container.querySelector('.wd-ci-fix')).toBeNull();
  });

  it('says nothing about zero threads', async () => {
    await render([{ name: 'api', done: false, pr: pr(), openThreads: 0 }]);
    expect(container.textContent).toBe('');
  });
});
