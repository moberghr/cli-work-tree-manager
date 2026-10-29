// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { AccountsWire, AccountSwitchWire, UsageWire } from '../../src/core/api-types.js';
import type { SessionSummary } from '../../src/web/src/api/client.js';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const api = vi.hoisted(() => ({ createWorktree: vi.fn() }));
vi.mock('../../src/web/src/api/events.js', () => ({ useSse: () => undefined }));
vi.mock('../../src/web/src/api/panes.js', () => ({
  fetchProjects: async () => ({ groups: [], singles: [{ name: 'jobly', kind: 'single', path: 'C:/repos/jobly' }] }),
  createWorktree: (req: unknown) => api.createWorktree(req),
  fetchBranchCheck: async (_t: string, b: string) => ({ branch: b, valid: true, exists: false, session: null, free: b }),
  lookupPr: () => Promise.reject(new Error('unused')),
}));

const {
  accountAction,
  accountLabel,
  accountName,
  accountRow,
  canSwitchAccount,
  cancelledText,
  currentAccount,
  hasMultipleAccounts,
  noSwitchText,
  switchText,
} = await import('../../src/web/src/state/accounts.js');
const { dashboardDialogOpen } = await import('../../src/web/src/state/modal-open.js');
const { useAccounts } = await import('../../src/web/src/hooks/use-accounts.js');
const { sessionHeaderItems } = await import('../../src/web/src/state/session-header-menu.js');
const { sessionMenuItems } = await import('../../src/web/src/state/session-menu.js');
const { AccountDialog } = await import('../../src/web/src/components/Dashboard/AccountDialog.js');
const { AccountChip } = await import('../../src/web/src/components/Dashboard/SessionBits.js');
const { railDetails } = await import('../../src/web/src/components/Dashboard/SessionRail.js');
const { NewWorktreeModal, moreLabel } = await import('../../src/web/src/components/Sidebar/NewWorktreeModal.js');
const { UsageMeter } = await import('../../src/web/src/components/Dashboard/UsageMeter.js');

const ACCOUNTS: AccountsWire = {
  accounts: [
    { name: 'default', dir: '~/.claude', isDefault: true, loggedIn: true },
    { name: 'work', dir: '~/.claude-work', isDefault: false, loggedIn: true },
    { name: 'spare', dir: '~/.claude-spare', isDefault: false, loggedIn: false },
    { name: 'mac', dir: '~/.claude-mac', isDefault: false, loggedIn: null },
  ],
  default: 'default',
};

const session = (over: Partial<SessionSummary> = {}): SessionSummary =>
  ({
    id: 's1',
    target: 'api',
    branch: 'feat/x',
    isGroup: false,
    paths: ['C:\\wt\\api\\feat-x'],
    createdAt: '',
    lastAccessedAt: '',
    archivedAt: null,
    ...over,
  }) as SessionSummary;
const codex = { id: 'codex', name: 'Codex', can: { read: true, hooks: true, live: true, answer: true } };

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  api.createWorktree.mockReset().mockResolvedValue({ sessionId: 's1', launchDir: 'x', paths: ['x'] });
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

describe('account helpers', () => {
  it('a live session whose agent can have accounts may switch once there is more than one account', () => {
    expect(canSwitchAccount(session(), true)).toBe(true);
    expect(canSwitchAccount(session(), false)).toBe(false);
    expect(canSwitchAccount(session({ archivedAt: '2026-10-01' }), true)).toBe(false);
    expect(canSwitchAccount(session({ agent: codex }), true)).toBe(false);
    // The capability decides (agentWire's can.accounts), not the agent's name (A1).
    expect(canSwitchAccount(session({ agent: { ...codex, id: 'claude' } }), true)).toBe(false);
    expect(canSwitchAccount(session({ agent: { ...codex, can: { ...codex.can, accounts: true } } }), true)).toBe(true);
  });

  it('Claude account…: offered with more than one account; opens, or says why not (T4)', () => {
    expect(hasMultipleAccounts(ACCOUNTS)).toBe(true);
    expect(hasMultipleAccounts({ accounts: [ACCOUNTS.accounts[0]!] })).toBe(false);
    expect(hasMultipleAccounts(null)).toBe(false);
    expect(accountAction(session(), { multiple: true, loadError: null })).toEqual({ kind: 'open' });
    expect(accountAction(session({ archivedAt: '2026-10-01' }), { multiple: true, loadError: null })).toEqual({
      kind: 'toast',
      text: 'Only a live session of an agent with accounts can change its account',
    });
    expect(accountAction(session({ agent: codex }), { multiple: true, loadError: null }).kind).toBe('toast');
    // ⇧C with one account, or when they couldn't be read: why, rather than nothing.
    expect(accountAction(session(), { multiple: false, loadError: null })).toEqual({
      kind: 'toast',
      text: 'Only one Claude account is set up: add another with `work account add <name>`',
    });
    expect(accountAction(session(), { multiple: false, loadError: 'HTTP 500' })).toEqual({
      kind: 'toast',
      text: "Couldn't load the Claude accounts: HTTP 500",
    });
  });

  it('the toasts after a switch and after a cancel (T4)', () => {
    expect(switchText('recorded', 'work')).toBe('Its next start uses work');
    expect(cancelledText('work')).toBe('It stays on its account: the switch to work is cancelled');
  });

  it('the account dialog counts as an open dialog: the shortcuts stop meanwhile (T4)', () => {
    const none = {
      newOpen: false,
      deleting: null,
      forking: null,
      addingRepo: null,
      switchingAccount: null,
      snoozingUntil: null,
      blocking: null,
    };
    expect(dashboardDialogOpen(none)).toBe(false);
    expect(dashboardDialogOpen({ ...none, switchingAccount: session() })).toBe(true);
    expect(dashboardDialogOpen({ ...none, newOpen: true })).toBe(true);
  });

  it('a session with no account runs on the default one', () => {
    expect(currentAccount(session())).toBe('default');
    expect(currentAccount(session({ account: 'work' }))).toBe('work');
  });

  it('rows: the current and the not-logged-in are not pickable, an unknown login is', () => {
    expect(accountRow(ACCOUNTS.accounts[0], 'default')).toEqual({ disabled: true, hint: 'current' });
    expect(accountRow(ACCOUNTS.accounts[1], 'default')).toEqual({ disabled: false, hint: '' });
    const bad = accountRow(ACCOUNTS.accounts[2], 'default');
    expect(bad.disabled).toBe(true);
    expect(bad.hint).toContain('work account add spare');
    expect(accountRow(ACCOUNTS.accounts[3], 'default').disabled).toBe(false);
  });

  it('what each outcome says', () => {
    expect(switchText('switched', 'work')).toBe('Moved to work');
    expect(switchText('queued', 'work')).toBe('Switches after its current turn');
    expect(switchText('recorded', 'work')).toBe('Its next start uses work');
  });

  it('only a non-default account is named', () => {
    expect(accountLabel(undefined)).toBe('');
    expect(accountLabel('default')).toBe('');
    expect(accountLabel('work')).toBe('account work');
  });
});

describe('the menus offer Claude account…', () => {
  const header = (account?: () => void) => ({
    openTerminal: vi.fn(),
    reconnectTerminal: vi.fn(),
    ship: vi.fn(),
    catchUp: vi.fn(),
    copyReply: vi.fn(),
    timeline: vi.fn(),
    sendPrompt: vi.fn(),
    notes: vi.fn(),
    devStart: vi.fn(),
    devStop: vi.fn(),
    rename: vi.fn(),
    remove: vi.fn(),
    ...(account ? { account } : {}),
  });
  const rail = (account?: (s: SessionSummary) => void) => ({
    setArchived: vi.fn(),
    openTerminal: vi.fn(),
    openEditor: vi.fn(),
    copyBranch: vi.fn(),
    remove: vi.fn(),
    snooze: vi.fn(),
    unsnooze: vi.fn(),
    ...(account ? { account } : {}),
  });
  const labels = (items: Array<{ label: string }>) => items.map((i) => i.label);

  it('in the header menu, with its key, when the dashboard gives the action', () => {
    const run = vi.fn();
    const items = sessionHeaderItems(session(), null, header(run));
    const item = items.find((i) => i.label === 'Claude account…')!;
    expect(item.hint).toBe('⇧C');
    item.run();
    expect(run).toHaveBeenCalled();
  });

  it('in the rail menu, with its key', () => {
    const run = vi.fn();
    const s = session();
    const item = sessionMenuItems(s, rail(run)).find((i) => i.label === 'Claude account…')!;
    expect(item.hint).toBe('⇧C');
    item.run();
    expect(run).toHaveBeenCalledWith(s);
  });

  it('not with one account (the dashboard gives no action)', () => {
    expect(labels(sessionHeaderItems(session(), null, header()))).not.toContain('Claude account…');
    expect(labels(sessionMenuItems(session(), rail()))).not.toContain('Claude account…');
  });

  it('not for another agent’s session, nor an archived one', () => {
    const run = vi.fn();
    for (const s of [session({ agent: codex }), session({ archivedAt: '2026-10-01' })]) {
      expect(labels(sessionHeaderItems(s, null, header(run)))).not.toContain('Claude account…');
      expect(labels(sessionMenuItems(s, rail(run)))).not.toContain('Claude account…');
    }
  });
});

describe('AccountDialog', () => {
  const mount = async (over: Record<string, unknown> = {}, s: SessionSummary = session()) => {
    const props = {
      session: s,
      onSwitched: vi.fn(),
      onClose: vi.fn(),
      load: () => Promise.resolve(ACCOUNTS),
      switchTo: vi.fn().mockResolvedValue({ ok: true, outcome: 'switched' } satisfies AccountSwitchWire),
      ...over,
    };
    act(() => root.render(createElement(AccountDialog, props)));
    await flush();
    return props;
  };
  const radio = (name: string) => container.querySelector<HTMLInputElement>(`input[value="${name}"]`)!;
  const submit = () => container.querySelector<HTMLButtonElement>('button[type="submit"]')!;

  it('lists the accounts with folder and login state; the current and the not-logged-in are disabled', async () => {
    await mount({}, session({ account: 'work' }));
    const text = container.textContent!;
    expect(text).toContain('~/.claude-work');
    expect(text).toContain('logged in');
    expect(text).toContain('not logged in');
    expect(text).toContain('unknown');
    // The default account's name says it already: not "default (default)".
    expect(text).not.toContain('(default)');
    expect(text).toContain('current');
    expect(radio('work').disabled).toBe(true); // the session's own
    expect(radio('spare').disabled).toBe(true);
    expect(text).toContain('work account add spare');
    expect(radio('default').disabled).toBe(false);
    expect(radio('mac').disabled).toBe(false);
    expect(container.textContent).toContain('conversation moves with it and the terminal stays');
    expect(submit().disabled).toBe(true); // nothing picked
  });

  it('switching shows progress at once, then reports the outcome', async () => {
    let finish!: (w: AccountSwitchWire) => void;
    const switchTo = vi.fn().mockReturnValue(new Promise<AccountSwitchWire>((r) => (finish = r)));
    const props = await mount({ switchTo });
    await click(radio('work'));
    await click(submit());
    expect(switchTo).toHaveBeenCalledWith('s1', 'work');
    expect(container.querySelector('.wd-spinner')).not.toBeNull();
    expect(submit().disabled).toBe(true);
    await act(async () => finish({ ok: true, outcome: 'queued' }));
    expect(props.onSwitched).toHaveBeenCalledWith('work', { ok: true, outcome: 'queued' });
  });

  it('a refusal stays in the dialog and lets you try again', async () => {
    const switchTo = vi.fn().mockRejectedValue(new Error('it is archived: restore it first'));
    const props = await mount({ switchTo });
    await click(radio('work'));
    await click(submit());
    await flush();
    expect(container.querySelector('[role="alert"]')!.textContent).toContain('it is archived: restore it first');
    expect(props.onSwitched).not.toHaveBeenCalled();
    expect(container.querySelector('.wd-spinner')).toBeNull();
    expect(submit().disabled).toBe(false);
  });

  it('says so when the accounts can’t be listed', async () => {
    await mount({ load: () => Promise.reject(new Error('503 down')) });
    expect(container.querySelector('[role="alert"]')!.textContent).toContain('503 down');
  });
});

describe('the account chip and the rail tooltip', () => {
  it('a non-default account shows in the header strip, styled as the other status-line chips; a click opens the dialog', () => {
    const onOpen = vi.fn();
    act(() => root.render(createElement(AccountChip, { session: session({ account: 'work' }), onOpen })));
    const chip = container.querySelector<HTMLElement>('.wd-account-chip')!;
    expect(chip.classList.contains('wd-stack')).toBe(true); // the stack chip's pill style
    expect(chip.textContent).toBe('account: work');
    container.querySelector<HTMLButtonElement>('.wd-account-chip button.wd-overlap-link')!.click();
    expect(onOpen).toHaveBeenCalled();
  });

  it('is plain text without the action, and absent for the default account', () => {
    act(() => root.render(createElement(AccountChip, { session: session({ account: 'work' }) })));
    expect(container.querySelector('.wd-account-chip')!.textContent).toBe('account: work');
    expect(container.querySelector('.wd-account-chip button')).toBeNull();
    act(() => root.render(createElement(AccountChip, { session: session() })));
    expect(container.querySelector('.wd-account-chip')).toBeNull();
  });

  it('a switch waiting for its turn shows where it goes, on the default account too', () => {
    act(() => root.render(createElement(AccountChip, { session: session({ accountPending: 'work' }) })));
    expect(container.querySelector('.wd-account-chip')!.textContent).toBe('account: default → work after this turn');
    act(() => root.render(createElement(AccountChip, { session: session({ account: 'work', accountPending: 'default' }) })));
    expect(container.querySelector('.wd-account-chip')!.textContent).toBe('account: work → default after this turn');
  });

  it('the rail tooltip mentions only a non-default account, and a switch waiting for its turn', () => {
    expect(railDetails(session({ account: 'work' }))).toBe('\naccount work');
    expect(railDetails(session())).toBe('');
    expect(railDetails(session({ accountPending: 'work' }))).toBe('\nmoves to account work after this turn');
  });
});

describe('New worktree: the Claude account pick', () => {
  const open = async (accounts: AccountsWire | null) => {
    act(() =>
      root.render(
        createElement(NewWorktreeModal, {
          onCreated: vi.fn(),
          onClose: vi.fn(),
          loadAccounts: () => (accounts ? Promise.resolve(accounts) : Promise.reject(new Error('none'))),
        }),
      ),
    );
    await flush();
  };
  const select = () => container.querySelector<HTMLSelectElement>('select')!;
  const setValue = (el: HTMLSelectElement, v: string) => {
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!.call(el, v);
    el.dispatchEvent(new Event('change', { bubbles: true }));
  };
  const create = () =>
    act(async () => void container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
  const moreOpen = () => click([...container.querySelectorAll('button')].find((b) => b.textContent!.includes('More options'))!);

  it('moreLabel mentions a non-default pick', () => {
    expect(moreLabel('', '', 'work')).toBe('More options: account work');
    expect(moreLabel('Speed', 'dev', 'work')).toBe('More options: name “Speed” · base dev · account work');
    expect(moreLabel('', '')).toBe('More options: name, base branch');
  });

  it('with one account there is no select, and none is sent', async () => {
    await open({ accounts: [ACCOUNTS.accounts[0]], default: 'default' });
    await moreOpen();
    expect(container.querySelector('select')).toBeNull();
    await create();
    expect(api.createWorktree.mock.calls[0][0].account).toBeUndefined();
  });

  it('with several, the default is preselected; another pick is sent and named in the folded label', async () => {
    await open(ACCOUNTS);
    await moreOpen();
    expect(select().value).toBe('default');
    expect(select().textContent).not.toContain('(default)');
    expect([...select().options].map((o) => o.textContent)).toContain('default');
    expect([...select().options].find((o) => o.value === 'spare')!.disabled).toBe(true); // not logged in
    await act(async () => setValue(select(), 'work'));
    await moreOpen(); // folds
    expect(container.textContent).toContain('More options: account work');
    await create();
    expect(api.createWorktree.mock.calls[0][0].account).toBe('work');
  });

  it('leaving the default sends none (the server uses the configured default)', async () => {
    await open(ACCOUNTS);
    await create();
    expect(api.createWorktree.mock.calls[0][0].account).toBeUndefined();
  });
});

describe('UsageMeter names accounts', () => {
  const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
  const win = [{ id: 'five_hour', label: '5-hour limit', usedPercent: 42, resetsAt: new Date(Date.now() + 3_600_000).toISOString() }];
  const zero = { input: 0, cached: 0, output: 0 };
  const wire = (accounts: UsageWire['agents'][number]['accounts']): UsageWire => ({
    agents: [{ agent: 'claude', name: 'Claude Code', accounts }],
    tokens: { today: zero, week: zero, byModel: [], topSessions: [] },
    at: ago(0),
  });
  const panelText = async (w: UsageWire) => {
    act(() => root.render(createElement(UsageMeter, { onOpenSession: vi.fn(), load: () => Promise.resolve(w) })));
    await flush();
    await click(container.querySelector('button.wd-usage-meter')!);
    return container.querySelector('.wd-usage-panel')!.textContent!;
  };

  it('with several: each by name, the default marked, one with no reading says so', async () => {
    const text = await panelText(
      wire([
        { account: 'default', isDefault: true, at: ago(60_000), windows: win },
        { account: 'work', at: ago(60_000), windows: win },
        { account: 'spare', at: ago(0), windows: [] },
      ]),
    );
    expect(text).toContain('account default');
    expect(text).not.toContain('(default)');
    expect(text).toContain('account work');
    expect(text).toContain('account spare');
    expect(text).toContain('no reading yet');
  });

  it('with one account, today’s look: no account line', async () => {
    const text = await panelText(wire([{ account: 'default', isDefault: true, at: ago(60_000), windows: win }]));
    expect(text).not.toContain('account default');
    expect(text).toContain('5-hour limit');
  });
});

describe('review fixes: names, a pending switch, a failed load', () => {
  it('accountName marks the default only when its name does not say so already', () => {
    expect(accountName({ name: 'default', isDefault: true })).toBe('default');
    expect(accountName({ name: 'work', isDefault: true })).toBe('work (default)');
    expect(accountName({ name: 'work', isDefault: false })).toBe('work');
  });

  it('the usage panel marks a configured default account', async () => {
    act(() =>
      root.render(
        createElement(UsageMeter, {
          onOpenSession: vi.fn(),
          load: () =>
            Promise.resolve({
              agents: [
                {
                  agent: 'claude',
                  name: 'Claude Code',
                  accounts: [
                    { account: 'default', at: new Date().toISOString(), windows: [] },
                    { account: 'work', isDefault: true, at: new Date().toISOString(), windows: [] },
                  ],
                },
              ],
              tokens: { today: { input: 0, cached: 0, output: 0 }, week: { input: 0, cached: 0, output: 0 }, byModel: [], topSessions: [] },
              at: new Date().toISOString(),
            } as UsageWire),
        }),
      ),
    );
    await flush();
    await click(container.querySelector('button.wd-usage-meter')!);
    expect(container.querySelector('.wd-usage-panel')!.textContent).toContain('account work (default)');
  });

  it('the dialog shows a switch waiting for its turn and cancels it', async () => {
    const cancelSwitch = vi.fn().mockResolvedValue(undefined);
    const onCancelled = vi.fn();
    act(() =>
      root.render(
        createElement(AccountDialog, {
          session: session({ accountPending: 'work' }),
          onSwitched: vi.fn(),
          onClose: vi.fn(),
          onCancelled,
          load: () => Promise.resolve(ACCOUNTS),
          cancelSwitch,
        }),
      ),
    );
    await flush();
    expect(container.textContent).toContain('→ work after this turn');
    // No second switch while one waits.
    expect(container.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled).toBe(true);
    await click([...container.querySelectorAll('button')].find((b) => b.textContent === 'Cancel the switch')!);
    await flush();
    expect(cancelSwitch).toHaveBeenCalledWith('s1');
    expect(onCancelled).toHaveBeenCalledWith('work');
  });

  it('a cancel the server refuses (it is being done now) stays in the dialog', async () => {
    const cancelSwitch = vi.fn().mockRejectedValue(new Error('the switch is being done right now'));
    act(() =>
      root.render(
        createElement(AccountDialog, {
          session: session({ accountPending: 'work' }),
          onSwitched: vi.fn(),
          onClose: vi.fn(),
          load: () => Promise.resolve(ACCOUNTS),
          cancelSwitch,
        }),
      ),
    );
    await flush();
    await click([...container.querySelectorAll('button')].find((b) => b.textContent === 'Cancel the switch')!);
    await flush();
    expect(container.querySelector('[role="alert"]')!.textContent).toContain('being done right now');
  });

  it('useAccounts says why a read failed (kept until one succeeds); ⇧C says so instead of "only one account"', async () => {
    let fail = true;
    const load = () => (fail ? Promise.reject(new Error('502 Bad Gateway')) : Promise.resolve(ACCOUNTS));
    let seen: ReturnType<typeof useAccounts> | null = null;
    const Probe = () => {
      seen = useAccounts(load);
      return null;
    };
    act(() => root.render(createElement(Probe)));
    await flush();
    expect(seen).toEqual({ data: null, error: '502 Bad Gateway' });
    expect(noSwitchText(seen!.error)).toBe("Couldn't load the Claude accounts: 502 Bad Gateway");
    expect(noSwitchText(null)).toContain('Only one Claude account');
    fail = false;
    await act(async () => void window.dispatchEvent(new Event('focus')));
    await flush();
    expect(seen).toEqual({ data: ACCOUNTS, error: null });
  });
});
