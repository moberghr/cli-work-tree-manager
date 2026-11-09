// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { AccountsWire } from '../../src/core/api-types.js';
import type { SessionSummary } from '../../src/web/src/api/client.js';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('../../src/web/src/api/events.js', () => ({ useSse: () => undefined }));

const { accountPageRows, addAccountProblem, defaultAccountFolder, removeRefusal, sessionsText } =
  await import('../../src/web/src/state/accounts.js');
const { AccountChangeError } = await import('../../src/web/src/api/client.js');
const { AccountsTab } = await import('../../src/web/src/components/Dashboard/tabs/AccountsTab.js');
const { AccountDialog } = await import('../../src/web/src/components/Dashboard/AccountDialog.js');
const { AccountLoginPanel } = await import('../../src/web/src/components/Dashboard/AccountLoginPanel.js');
const { parseHash, toHash } = await import('../../src/web/src/state/dashboard-route.js');
const { shortcutGroups } = await import('../../src/web/src/state/shortcuts.js');

/** The dashboard's Accounts page (#/accounts): its rows, the Add form's rule, a refused removal, the login terminal. */

const NOW = Date.parse('2026-11-04T12:00:00Z');
const WIRE: AccountsWire = {
  accounts: [
    {
      name: 'default',
      dir: '~/.claude',
      isDefault: true,
      loggedIn: true,
      liveSessions: ['api · feat/x'],
      archivedSessions: [],
      usage: {
        account: 'default',
        at: new Date(NOW - 3 * 60_000).toISOString(),
        windows: [{ id: 'five_hour', label: '5-hour limit', usedPercent: 42, resetsAt: null }],
      },
    },
    {
      name: 'work',
      dir: '~/.claude-work',
      isDefault: false,
      loggedIn: true,
      liveSessions: [],
      archivedSessions: ['web · old'],
      usage: null,
    },
    { name: 'spare', dir: '~/.claude-spare', isDefault: false, loggedIn: false, liveSessions: ['api · feat/y'], archivedSessions: [] },
  ],
  default: 'default',
  canManage: true,
};

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
const flush = () =>
  act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
const click = (el: Element) =>
  act(async () => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
const button = (text: string) => [...container.querySelectorAll('button')].find((b) => b.textContent === text);
const type = (input: HTMLInputElement, value: string) =>
  act(async () => {
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    set.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });

describe('the page rows (pure)', () => {
  it('login, usage, who is on it, and what each may do: the default is never removed, nor one live sessions run on', () => {
    const rows = accountPageRows(WIRE, NOW);
    expect(rows.map((r) => [r.name, r.login, r.canMakeDefault, r.canRemove])).toEqual([
      ['default', 'logged in', false, false],
      ['work', 'logged in', true, true],
      ['spare', 'not logged in', true, false],
    ]);
    expect(rows[0].usage).toBe('5-hour limit 42% · read 3 min ago');
    expect(rows[1].usage).toBe('no usage reading yet');
    expect(rows[2].usage).toBe(''); // an older server says nothing of it
    expect(rows[2].needsLogin).toBe(true);
    expect(rows[2].removeWhy).toBe('1 live session run on it');
    expect(rows[1].sessions).toBe('1 archived session');
    expect(rows[1].sessionNames).toEqual(['web · old (archived)']);
    expect(sessionsText({ liveSessions: [], archivedSessions: [] })).toBe('no sessions');
    expect(sessionsText({})).toBe('');
  });

  it("the Add form's name by the server's rule; the folder it gets when none is given", () => {
    expect(addAccountProblem('', WIRE)).toBeNull();
    expect(addAccountProblem('work', WIRE)).toBe('there is already an account “work”');
    expect(addAccountProblem('Team', WIRE)).toContain('not a valid account name');
    expect(addAccountProblem('default', WIRE)).toContain("can't be reused");
    expect(addAccountProblem('team', WIRE)).toBeNull();
    expect(defaultAccountFolder('team')).toBe('~/.claude-team');
    expect(defaultAccountFolder(' ')).toBe('~/.claude-<name>');
  });

  it('a refused removal: archived sessions can be forced past, live ones never', () => {
    expect(removeRefusal(new AccountChangeError('1 archived session on work', ['web · old'], 'archived'))).toEqual({
      text: '1 archived session on work: web · old. Remove it anyway? Their Restore then starts on the default account.',
      canForce: true,
    });
    expect(removeRefusal(new AccountChangeError('1 live session on spare', ['api · feat/y'], 'live'))).toEqual({
      text: '1 live session on spare: api · feat/y.',
      canForce: false,
    });
  });

  it('#/accounts is a page, and `g a` opens it', () => {
    expect(parseHash('#/accounts')).toMatchObject({ tab: 'accounts', sessionId: null });
    expect(toHash({ tab: 'accounts', sessionId: null, sessionSubTab: 'term' })).toBe('#/accounts');
    expect(
      shortcutGroups()
        .flatMap((g) => g.rows)
        .some((k) => k.keys === 'g a'),
    ).toBe(true);
  });
});

describe('AccountsTab', () => {
  const LoginStandIn = vi.fn(({ name, onClose }: { name: string; onClose: () => void }) =>
    createElement('div', { role: 'dialog', 'data-login': name }, createElement('button', { onClick: onClose }, 'Done')),
  );
  function mount(o: { wire?: AccountsWire; startAdding?: boolean; remove?: (name: string, force?: boolean) => Promise<unknown> } = {}) {
    const api = {
      load: vi.fn(async () => o.wire ?? WIRE),
      add: vi.fn(async (name: string) => ({ dir: `~/.claude-${name}` })),
      makeDefault: vi.fn(async () => ({ ok: true })),
      remove: o.remove ?? vi.fn(async () => ({ ok: true })),
    };
    act(() =>
      root.render(createElement(AccountsTab, { api, startAdding: o.startAdding, LoginPanel: LoginStandIn as never, now: () => NOW })),
    );
    return api;
  }

  it('lists every account with its folder, login, usage and sessions; Remove is off for the default and a busy one', async () => {
    mount();
    await flush();
    const text = container.textContent ?? '';
    expect(text).toContain('~/.claude-work');
    expect(text).toContain('not logged in');
    expect(text).toContain('5-hour limit 42%');
    expect(text).toContain('1 archived session');
    const removes = [...container.querySelectorAll('button')].filter((b) => b.textContent === 'Remove');
    expect(removes).toHaveLength(2); // none for the default account
    expect(removes.map((b) => b.disabled)).toEqual([false, true]);
    expect(button('Log in')).toBeDefined(); // the one not logged in
  });

  it('Add: checks the name as you type, records it, then opens its login terminal; closing it reads the accounts again', async () => {
    const api = mount({ startAdding: true });
    await flush();
    const name = container.querySelector<HTMLInputElement>('input[aria-label="Account name"]')!;
    const submit = () => button('Add and log in')!;
    await type(name, 'work');
    expect(container.textContent).toContain('already an account');
    expect(submit().disabled).toBe(true);
    await type(name, 'team');
    expect(container.querySelector<HTMLInputElement>('input[aria-label="Account folder (optional)"]')!.placeholder).toBe('~/.claude-team');
    await click(submit());
    await flush();
    expect(api.add).toHaveBeenCalledWith('team', undefined);
    expect(container.querySelector('[data-login="team"]')).not.toBeNull();
    const loads = api.load.mock.calls.length;
    await click(button('Done')!);
    await flush();
    expect(container.querySelector('[data-login]')).toBeNull();
    expect(api.load.mock.calls.length).toBeGreaterThan(loads);
  });

  it('Remove refused for archived sessions asks first, then forces it; Make default goes through', async () => {
    const remove = vi
      .fn<(name: string, force?: boolean) => Promise<unknown>>()
      .mockRejectedValueOnce(new AccountChangeError('1 archived session on work', ['web · old'], 'archived'))
      .mockResolvedValueOnce({ ok: true });
    const api = mount({ remove });
    await flush();
    await click([...container.querySelectorAll('button')].find((b) => b.textContent === 'Remove' && !b.disabled)!);
    await flush();
    expect(container.querySelector('[role="alertdialog"]')!.textContent).toContain('Remove it anyway?');
    await click(button('Remove anyway')!);
    await flush();
    expect(remove).toHaveBeenLastCalledWith('work', true);
    await click(button('Make default')!);
    await flush();
    expect(api.makeDefault).toHaveBeenCalledWith('work');
  });

  it('a server that only looks (the dev server) shows them with no buttons, and says why', async () => {
    mount({ wire: { ...WIRE, canManage: false, manageNote: 'the dev server changes no account' } });
    await flush();
    expect(button('Add account…')).toBeUndefined();
    expect(button('Remove')).toBeUndefined();
    expect(container.textContent).toContain('the dev server changes no account');
  });
});

describe('AccountLoginPanel', () => {
  it('starts the login terminal, shows why it could not, and stops it on Done (not on Esc)', async () => {
    const start = vi.fn().mockRejectedValue(new Error('the PTY host is from before Claude accounts'));
    const stop = vi.fn().mockResolvedValue(undefined);
    const onClose = vi.fn();
    act(() => root.render(createElement(AccountLoginPanel, { name: 'work', onClose, start, stop })));
    await flush();
    expect(start).toHaveBeenCalledWith('work');
    expect(container.querySelector('[role="alert"]')!.textContent).toContain('from before Claude accounts');
    await act(
      async () =>
        void container.querySelector('[role="dialog"]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })),
    );
    expect(onClose).not.toHaveBeenCalled();
    await click(button('Done')!);
    expect(stop).toHaveBeenCalledWith('work');
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe('Claude account… with one account', () => {
  it('says so and offers to add another, which goes to the Accounts page', async () => {
    const onAddAccount = vi.fn();
    const session = { id: 's1', target: 'api', branch: 'feat/x', archivedAt: null } as unknown as SessionSummary;
    act(() =>
      root.render(
        createElement(AccountDialog, {
          session,
          onSwitched: vi.fn(),
          onClose: vi.fn(),
          onAddAccount,
          load: () => Promise.resolve({ accounts: [WIRE.accounts[0]!], default: 'default' }),
        }),
      ),
    );
    await flush();
    expect(container.textContent).toContain('Only one Claude account is set up');
    expect(container.querySelector('[role="radiogroup"]')).toBeNull();
    await click(button('Add another account…')!);
    expect(onAddAccount).toHaveBeenCalled();
  });
});
