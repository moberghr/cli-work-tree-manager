import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test, expect, type Page } from '@playwright/test';

/**
 * `work web --demo` end to end: the built binary, the real SPA, the
 * simulated API. Run under an EMPTY home and assert afterwards that it
 * created no state there — the demo touches no repos, agents or ~/.work.
 */

const BIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'bin.js');
let home: string;
let child: ChildProcess;
let url: string;

/** Ship lives in the session header's ⋯ menu. */
async function shipFromMenu(page: Page) {
  await page.getByRole('button', { name: 'More actions' }).click();
  await page.getByRole('menuitem', { name: /^Ship/ }).click();
}

test.beforeEach(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'work-demo-'));
  child = spawn(process.execPath, [BIN, 'web', '--demo', '--no-open'], {
    env: { ...process.env, HOME: home, USERPROFILE: home, NO_COLOR: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  url = await new Promise<string>((resolve, reject) => {
    let out = '';
    const timer = setTimeout(() => reject(new Error(`demo did not start: ${out}`)), 20_000);
    const onData = (d: Buffer) => {
      out += d.toString();
      const m = out.match(/DEMO at (http:\/\/127\.0\.0\.1:\d+\/)/);
      if (m) {
        clearTimeout(timer);
        resolve(m[1]);
      }
    };
    child.stderr!.on('data', onData);
    child.stdout!.on('data', onData);
  });
});
test.afterEach(async () => {
  child.kill();
  await new Promise((r) => setTimeout(r, 300));
  fs.rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

test('the real dashboard runs on simulated data, and nothing real is touched', async ({ page }) => {
  await page.goto(`${url}#/inbox`);
  await expect(page.locator('.wd-inbox-rank-0 .wd-inbox-row')).toContainText('feat/invoice-export');
  await expect(page).toHaveTitle(/\(\d+\) work/);

  // Answer the blocked agent in its (simulated) terminal.
  await page.locator('.wd-inbox-rank-0 .wd-inbox-row', { hasText: 'feat/invoice-export' }).click();
  await expect(page).toHaveURL(/\/term$/);
  await page.locator('.wd-pty-host .xterm').click();
  await page.keyboard.type('1');
  await page.keyboard.press('Enter');
  await expect(page.locator('.wd-session-status, .wd-session-detail')).toContainText(/Working/);

  // Ship half of the group.
  const shopRow = page.locator('.wd-dash-rail-item', { hasText: 'feat/checkout-v2' });
  await shopRow.click();
  await shipFromMenu(page);
  const panel = page.getByRole('dialog', { name: 'Ship session' });
  await panel.getByRole('button', { name: 'Create PR' }).click();
  await expect(panel.locator('.wd-ship-results')).toContainText('PR opened');
  await expect(panel).toContainText('checks still running');
  // Simulated checks go green after a few seconds; reopen to re-check.
  await page.waitForTimeout(7_000);
  await page.keyboard.press('Escape');
  await shipFromMenu(page);
  await panel.getByLabel('Merge frontend').uncheck();
  await panel.getByRole('button', { name: 'Merge 1…' }).click();
  await panel.getByRole('alertdialog', { name: 'Confirm merge' }).getByRole('button', { name: 'Confirm merge' }).click();
  await expect(panel).toContainText('✓ merged');

  // Nothing but the startup debug log was written into this HOME.
  const created = fs.existsSync(path.join(home, '.work')) ? fs.readdirSync(path.join(home, '.work')) : [];
  expect(created.filter((f) => !f.startsWith('debug.log'))).toEqual([]);
  expect(fs.existsSync(path.join(home, '.claude'))).toBe(false);
});

test('"Last turn" narrows the diff to what the last instruction changed', async ({ page }) => {
  await page.goto(url);
  await page.locator('.wd-dash-rail-item', { hasText: 'fix/login-redirect' }).click();
  await page.getByRole('tab', { name: /^Diff/ }).click();
  const files = page.locator('.wd-web-review-main article');
  await expect(files).toHaveCount(2);

  await page.getByRole('tab', { name: 'Last turn' }).click();
  await expect(files).toHaveCount(1);
  await expect(files).toContainText('src/auth.test.ts');

  await page.getByLabel('Which turn').selectOption({ label: '1 · Implemented the change' });
  await expect(files).toHaveCount(1);
  await expect(files).not.toContainText('auth.test.ts');
  await expect(files).toContainText('src/auth.ts');

  await page.getByRole('tab', { name: 'Uncommitted' }).click();
  await expect(files).toHaveCount(2);
});

test('revert a file from the diff, and Claude is told', async ({ page }) => {
  await page.goto(url);
  await page.locator('.wd-dash-rail-item', { hasText: 'fix/login-redirect' }).click();
  await page.getByRole('tab', { name: /^Diff/ }).click();
  const files = page.locator('.wd-web-review-main article');
  await expect(files).toHaveCount(2);

  page.once('dialog', (d) => d.accept());
  await page.getByRole('button', { name: 'Revert file: src/auth.test.ts' }).click();
  await expect(files).toHaveCount(1);
  await expect(files).not.toContainText('auth.test.ts');
  await expect(page.locator('.wd-web-review-sidebar, .wd-comments-panel').first()).toContainText('I reverted your uncommitted change');

  // Not offered where it would mean rewriting history.
  await page.getByRole('tab', { name: 'Since branch' }).click();
  await expect(page.getByRole('button', { name: /^Revert/ })).toHaveCount(0);
});

test('a finished session notifies only when you are not looking, and the click jumps to it', async ({ page }) => {
  // Record notifications instead of showing real ones.
  await page.addInitScript(() => {
    const w = window as unknown as { __notes: Array<{ title: string; click: () => void }> };
    w.__notes = [];
    class N {
      static permission = 'granted';
      static requestPermission = async () => 'granted';
      onclick: (() => void) | null = null;
      constructor(public title: string) {
        w.__notes.push({ title, click: () => this.onclick?.() });
      }
      close() {}
    }
    (window as unknown as { Notification: unknown }).Notification = N;
  });
  await page.goto(`${url}#/inbox`);
  // Granted: nothing left to offer (the Inbox says nothing about it then).
  await expect(page.locator('.wd-tab-inbox h1')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Enable notifications' })).toHaveCount(0);

  // Answer the blocked agent, then look elsewhere while it works.
  await page.locator('.wd-inbox-rank-0 .wd-inbox-row', { hasText: 'feat/invoice-export' }).click();
  await page.locator('.wd-pty-host .xterm').click();
  await page.keyboard.type('1');
  await page.keyboard.press('Enter');
  await page.locator('.wd-dash-rail-item', { hasText: 'fix/login-redirect' }).click();

  await expect
    .poll(() => page.evaluate(() => (window as unknown as { __notes: Array<{ title: string }> }).__notes.map((n) => n.title)), {
      timeout: 20_000,
    })
    .toContain('Finished — api · feat/invoice-export');
  await page.evaluate(() =>
    (window as unknown as { __notes: Array<{ title: string; click: () => void }> }).__notes
      .find((n) => n.title.startsWith('Finished'))!
      .click(),
  );
  await expect(page.locator('.wd-dash-rail-item[aria-current], .wd-dash-rail-item-active').first()).toContainText('feat/invoice-export');
});

test('start a worktree dev server and get a preview link on its port', async ({ page }) => {
  await page.goto(url);
  await page.locator('.wd-dash-rail-item', { hasText: 'fix/login-redirect' }).click();
  // Nothing runs yet: no chip; ⋯ starts it on the worktree's port.
  const chip = page.locator('.wd-dev-chip');
  await expect(chip).toHaveCount(0);
  await page.getByRole('button', { name: 'More actions' }).click();
  await page.getByRole('menuitem', { name: /Start dev server/ }).click();
  await expect(chip).toContainText(/:\d+/);
  await expect(chip.getByRole('link', { name: 'Preview ↗' })).toHaveAttribute('href', /^http:\/\/localhost:\d+\/$/, { timeout: 10_000 });
  await chip.getByRole('button', { name: /Stop/ }).click();
  await expect(chip.getByRole('link', { name: 'Preview ↗' })).toHaveCount(0);
});

test('failing CI is one line under the header, and Claude fixes it on request', async ({ page }) => {
  await page.goto(url);
  await page.locator('.wd-dash-rail-item', { hasText: 'chore/deps-update' }).click();
  const bar = page.locator('.wd-needs-you');
  await expect(bar).toContainText('CI failing on #212');
  const strip = page.locator('.wd-ci-strip');
  await expect(strip).toBeHidden();
  await bar.getByRole('button', { name: 'Review' }).click();
  await expect(strip).toContainText('CI failing on #212: test (node 22), typecheck');
  await strip.getByRole('button', { name: 'Ask Claude to fix' }).click();
  await expect(strip).toContainText('Sent to Claude ✓');
  await expect(strip).toContainText('checks running', { timeout: 10_000 });
  await expect(strip).not.toContainText(/CI failing|checks running/, { timeout: 15_000 });
  // Open review threads stay visible until they're resolved on GitHub.
  await expect(strip).toContainText('2 open review threads on #212');
});

test('j/k never navigate while the Ship dialog is open, and a session switch closes it', async ({ page }) => {
  await page.goto(url);
  await page.locator('.wd-dash-rail-item', { hasText: 'feat/checkout-v2' }).click();
  await expect(page).toHaveURL(/#\/s\//);
  const before = page.url();
  await shipFromMenu(page);
  const panel = page.getByRole('dialog', { name: 'Ship session' });
  await expect(panel).toBeVisible();

  // Out of habit, j while the confirm is up: nothing moves.
  await page.keyboard.press('j');
  await page.keyboard.press('k');
  await expect(page).toHaveURL(before);
  await expect(page.locator('.wd-session-detail-branch')).toHaveText('feat/checkout-v2');
  await expect(panel).toBeVisible();

  // The backdrop blocks the rail; what CAN switch session under an open
  // dialog is a notification click or the browser (back, a pasted link).
  // That must close the dialog, not carry it over to the other session.
  const sessions = (await (await page.request.get(`${url}api/sessions`)).json()).sessions as Array<{ id: string; branch: string }>;
  const other = sessions.find((s) => s.branch === 'fix/login-redirect')!;
  await page.evaluate((id) => (location.hash = `#/s/${id}`), other.id);
  await expect(page.locator('.wd-session-detail-branch')).toHaveText('fix/login-redirect');
  await expect(page.getByRole('dialog', { name: 'Ship session' })).toHaveCount(0);
});

test('j/k walk the rail in the order it shows', async ({ page }) => {
  await page.goto(url);
  const rail = page.locator('.wd-dash-rail-item .wd-dash-rail-name');
  await expect(rail.first()).toBeVisible();
  const order = await rail.allTextContents();
  await page.locator('.wd-dash-rail-item').first().click();
  await expect(page.locator('.wd-session-detail-branch')).toHaveText(order[0]);
  // On the terminal, j/k are Claude's; walk from the diff (which j/k keep).
  await page.getByRole('tab', { name: /^Diff/ }).click();
  await page.locator('body').click({ position: { x: 5, y: 5 } }); // keys go to the page, not a field
  for (const expected of order.slice(1, 4)) {
    await page.keyboard.press('j');
    await expect(page.locator('.wd-session-detail-branch')).toHaveText(expected);
  }
  await page.keyboard.press('k');
  await expect(page.locator('.wd-session-detail-branch')).toHaveText(order[2]);
});

test('a permission prompt is answered from the inbox, showing the command it allows', async ({ page }) => {
  await page.goto(`${url}#/inbox`);
  const item = page.locator('.wd-inbox-rank-0 .wd-inbox-item', { hasText: 'feat/invoice-export' });
  await expect(item.locator('.wd-inbox-request')).toHaveText('Bash npm test -- invoices');
  await item.getByRole('button', { name: 'Allow' }).click();
  // It leaves the Inbox (working is the rail's), which says what was allowed.
  await expect(page.locator('.wd-inbox-rank-0', { hasText: 'feat/invoice-export' })).toHaveCount(0);
  await expect(page.locator('.wd-inbox-rest')).toContainText(/\d+ working/);
  await expect(page.locator('.wd-dash-rail-item', { hasText: 'feat/invoice-export' })).toHaveAttribute(
    'title',
    /Allowed Bash: npm test -- invoices/,
  );
});

test('"Review all" walks the finished sessions, each on its last turn, and n moves on', async ({ page }) => {
  await page.goto(`${url}#/inbox`);
  const done = page.locator('.wd-inbox-rank-1 .wd-inbox-item');
  await expect(done.first()).toBeVisible();
  const total = await done.count();
  expect(total).toBeGreaterThan(0);
  await page.getByRole('button', { name: 'Review all' }).click();

  const bar = page.locator('.wd-review-queue-bar');
  for (let i = 1; i <= total; i++) {
    await expect(bar).toContainText(`${i} of ${total}`);
    await expect(page.getByRole('tab', { name: 'Last turn' })).toHaveAttribute('aria-selected', 'true');
    await page.locator('body').press('n');
  }
  // Past the last one: back to the inbox, nothing left unseen.
  await expect(page).toHaveURL(/#\/inbox$/);
  await expect(page.locator('.wd-inbox-rank-1')).toHaveCount(0);
});

test('two sessions changing the same file are flagged, and the warning links to the other one', async ({ page }) => {
  await page.goto(`${url}#/sessions`);
  await page.locator('.wd-dash-rail-item', { hasText: 'feat/invoice-export' }).click();
  const chip = page.locator('.wd-session-strip .wd-overlap');
  await expect(chip).toContainText('Same files as chore/deps-update (1 file)');
  await expect(chip).toHaveAttribute('title', /api\/package\.json/);
  await chip.getByRole('button', { name: 'chore/deps-update' }).click();
  await expect(page.locator('.wd-session-strip .wd-overlap')).toContainText('Same files as feat/invoice-export');
});

test('a Jira issue on Start starts a session with a first prompt, opened on its terminal', async ({ page }) => {
  // The old Jira page's link lands on Start.
  await page.goto(`${url}#/jira`);
  await expect(page).toHaveURL(/#\/jira$/);
  const jira = page.getByRole('region', { name: 'Jira issues assigned to you' });
  await jira.getByRole('button', { name: 'Start', exact: true }).first().click();
  const dialog = page.getByRole('dialog');
  const prompt = dialog.locator('textarea');
  await expect(prompt).toHaveValue(/^Work on [A-Z]+-\d+: /);
  await expect(dialog.locator('.wd-modal-branch code')).toHaveText(/^feat\/[A-Z]+-\d+$/);
  await prompt.fill('Work on it: add the export button');
  await dialog.getByRole('button', { name: 'Create and start' }).click();
  await expect(page).toHaveURL(/\/term$/);
  await expect(page.locator('.wd-session-strip')).toContainText('Work on it: add the export button');
});

test('a saved prompt is sent to a session from its ⋯ menu, and shows in its comments on the Diff', async ({ page }) => {
  await page.goto(`${url}#/sessions`);
  await page.locator('.wd-dash-rail-item', { hasText: 'fix/login-redirect' }).click();
  await page.getByRole('button', { name: 'More actions' }).click();
  await page.getByRole('menuitem', { name: 'Send a prompt…' }).click();
  await page.getByRole('menuitem', { name: 'Add tests' }).click();
  await expect(page.locator('.wd-prompts-state')).toContainText('"Add tests"');
  await page.getByRole('tab', { name: /Diff/ }).click();
  await expect(page.locator('.wd-comments-panel')).toContainText('Add tests for what changed on this branch');
});

test('Today lists what each session did, and g d gets there', async ({ page }) => {
  await page.goto(`${url}#/inbox`);
  // The keys are the dashboard's: once it's on screen (pressed while it loads, nothing hears them).
  await expect(page.getByRole('heading', { name: /^Inbox/ })).toBeVisible();
  await page.locator('body').press('g');
  await page.locator('body').press('d');
  await expect(page).toHaveURL(/#\/today$/);
  const card = page.locator('.wd-today-card', { hasText: 'feat/invoice-export' });
  await expect(card).toContainText('Add CSV export to the invoices endpoint');
  await expect(card).toContainText('needs your input');
  await card.locator('.wd-today-title').click();
  await expect(page).toHaveURL(/#\/s\/demo-api-feat-invoice-export\/diff$/);
});

test('Today is a view of Sessions, and Tasks is a panel in the top bar', async ({ page }) => {
  await page.goto(`${url}#/sessions`);
  await page.getByRole('button', { name: 'Today', exact: true }).click();
  await expect(page).toHaveURL(/#\/today$/);
  await expect(page.getByRole('tab', { name: 'Sessions' })).toHaveAttribute('aria-selected', 'true');
  await page.getByRole('button', { name: 'Now', exact: true }).click();
  await expect(page).toHaveURL(/#\/sessions$/);

  await page.getByRole('button', { name: 'Tasks', exact: true }).click();
  const panel = page.getByRole('dialog', { name: 'Tasks' });
  await expect(panel).toContainText('Rate-limit the public invoices API');
  await page.keyboard.press('Escape');
  await expect(panel).toHaveCount(0);
  // g t opens it, and g t closes it again (a popover leaves the shortcuts working).
  await page.locator('body').press('g');
  await page.locator('body').press('t');
  await expect(panel).toBeVisible();
  await page.locator('body').press('g');
  await page.locator('body').press('t');
  await expect(panel).toHaveCount(0);
});

test('a split-view diff lays its columns out at full width', async ({ page }) => {
  // A stray `.wd-context { display: inline-flex }` (the diff's own row class)
  // once shrank every cell to 50 px; the demo's data was fine, so only a
  // layout measurement catches it.
  await page.goto(`${url}#/s/demo-api-feat-invoice-export/diff`);
  const cell = page.locator('table.wd-diff-table.wd-side td.wd-content').first();
  await expect(cell).toBeVisible();
  const table = page.locator('table.wd-diff-table.wd-side').first();
  const [cellBox, tableBox] = await Promise.all([cell.boundingBox(), table.boundingBox()]);
  expect(cellBox!.width).toBeGreaterThan(tableBox!.width * 0.35); // ~half the table, minus line numbers
  await expect(cell).toHaveCSS('display', 'table-cell');
});

test('Today and Inbox scroll when their content is taller than the window', async ({ page }) => {
  await page.setViewportSize({ width: 1200, height: 360 });
  for (const tab of ['today', 'inbox']) {
    await page.goto(`${url}#/${tab}`);
    const pane = page.locator(`.wd-tab-${tab}`);
    await expect(pane.locator(tab === 'today' ? '.wd-today-card' : '.wd-inbox-item').first()).toBeVisible();
    expect(await pane.evaluate((el) => el.scrollHeight > el.clientHeight), `${tab} is taller than the window`).toBe(true);
    // A real wheel, not scrollTop: script can scroll an overflow:hidden box.
    const box = (await pane.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height - 40);
    await page.mouse.wheel(0, 600);
    await expect.poll(() => pane.evaluate((el) => el.scrollTop), { message: `${tab} scrolls` }).toBeGreaterThan(0);
    await expect(pane.locator('.wd-tab-header')).toBeInViewport(); // header stays
  }
});

test('an approved, green PR comes back to the Inbox as ready to merge, and leaves once you have looked; one in review stays out', async ({
  page,
}) => {
  await page.goto(`${url}#/inbox`);
  const ready = page.locator('.wd-inbox-rank-2 .wd-inbox-item', { hasText: 'feat/order-history' });
  await expect(ready).toContainText('PR #209 · approved, ready to merge');
  await expect(page.locator('.wd-inbox-item', { hasText: 'feat/tax-report' })).toHaveCount(0);
  await expect(page.locator('.wd-inbox-rest')).toContainText('in review');
  await ready.getByRole('button', { name: 'Open' }).click();
  await expect(page.locator('.wd-session-strip .wd-pr-stage')).toHaveText('#209 · ready to merge');
  // Its row on the left carries the PR as a pill.
  await expect(page.locator('.wd-dash-rail-item', { hasText: 'feat/order-history' }).locator('.wd-pr-chip')).toHaveText('#209');
  await page.goto(`${url}#/inbox`);
  await expect(page.locator('.wd-inbox-item', { hasText: 'feat/order-history' })).toHaveCount(0);
  await expect(page.locator('.wd-dash-rail-item', { hasText: 'feat/tax-report' }).locator('.wd-rail-dot-in_review')).toHaveCount(1);
});

test('Welcome walks the first run: folders, repos inline, the tools, then New worktree', async ({ page }) => {
  await page.goto(`${url}#/welcome`);
  await expect(page.getByRole('heading', { name: 'Welcome to work' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Your repos' }).locator('.wd-repos-row').first()).toBeVisible();
  await expect(page.getByRole('region', { name: 'Tools' })).toContainText('Claude Code');
  await page.getByRole('region', { name: 'Start' }).getByRole('button', { name: 'New worktree' }).click();
  await expect(page.locator('.wd-modal')).toBeVisible();
});

test('keyboard: ? lists the shortcuts, c opens New worktree, and an open session takes 2, . and e', async ({ page }) => {
  await page.goto(`${url}#/sessions`);
  await page.locator('body').press('?');
  await expect(page.getByRole('dialog', { name: 'Keyboard shortcuts' })).toContainText('Ship (push, PR, merge)…');
  await page.keyboard.press('Escape');
  await page.keyboard.press('c');
  await expect(page.locator('.wd-modal')).toBeVisible();
  // Esc closes the project field's list first, then the dialog.
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await expect(page.locator('.wd-modal')).toHaveCount(0);

  await page.locator('.wd-dash-rail-item', { hasText: 'feat/tax-report' }).click();
  await page.locator('.wd-session-detail-header h1').click(); // out of the terminal
  await page.keyboard.press('2');
  await expect(page).toHaveURL(/\/diff$/);
  await page.keyboard.press('.');
  await expect(page.getByRole('menuitem', { name: /Catch me up/ })).toBeVisible();
  await page.keyboard.press('Escape');
  await page.keyboard.press('e');
  await expect(page.locator('.wd-archived-pill')).toBeVisible();
});

test('Jira has its own tab; Repos goes back to Start; the pages scroll when they are taller than the window', async ({ page }) => {
  await page.setViewportSize({ width: 1200, height: 420 });
  await page.goto(`${url}#/start`);
  await page.getByRole('tab', { name: 'Jira' }).click();
  await expect(page).toHaveURL(/#\/jira$/);
  await expect(page.getByRole('region', { name: 'Jira issues assigned to you' })).toBeVisible();
  await page.getByRole('tab', { name: 'Start' }).click();
  await page.getByRole('button', { name: 'Repos & groups' }).click();
  const repos = page.locator('.wd-tab-repos');
  await expect(repos.locator('.wd-repos-row').first()).toBeVisible();
  // Taller than the window: it scrolls, its header stays.
  await expect.poll(() => repos.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);
  await repos.evaluate((el) => el.scrollTo(0, el.scrollHeight));
  await expect.poll(() => repos.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
  await page.getByRole('button', { name: '← Start' }).click();
  await expect(page).toHaveURL(/#\/start$/);
});

test("Help in the top bar says which work runs, checks for updates, and opens What's new", async ({ page }) => {
  await page.goto(`${url}#/sessions`);
  await page.getByRole('button', { name: /^Help: work v2\.1\.0/ }).click();
  const panel = page.getByRole('dialog', { name: 'Help' });
  await expect(panel).toContainText('work v2.1.0');
  await panel.getByRole('button', { name: 'Check for updates' }).click();
  await expect(panel).toContainText('You have the newest work (2.1.0).');
  await panel.getByRole('button', { name: "What's new" }).click();
  const notes = page.getByRole('dialog', { name: "What's new" });
  await expect(notes.getByRole('heading', { name: /work 2\.1\.0/ })).toBeVisible();
  await expect(notes).toContainText('Jira has its own tab again');
  await notes.getByRole('button', { name: 'Close' }).click();
  await expect(notes).toHaveCount(0);
});

test('archived sessions come only when shown: Show archived lists them, and a link to one opens it', async ({ page }) => {
  const all = (await (await fetch(`${url}api/sessions?archived=1`)).json()) as {
    sessions: Array<{ id: string; branch: string; archivedAt: string | null }>;
  };
  const gone = all.sessions.find((s) => s.archivedAt)!;
  await page.goto(`${url}#/sessions`);
  const row = page.locator('tr', { hasText: gone.branch });
  await page.getByRole('button', { name: /^View/ }).click();
  const box = page.getByRole('checkbox', { name: /Show archived/ });
  if (await box.isChecked()) await box.uncheck();
  await expect(row).toHaveCount(0);
  await box.check();
  await expect(row.first()).toBeVisible();
  await box.uncheck();
  // A link straight to an archived session: it is fetched, never "not found".
  await page.goto(`${url}#/s/${gone.id}/timeline`);
  await expect(page.locator('.wd-archived-pill')).toBeVisible();
  await expect(page.getByText('Session not found')).toHaveCount(0);
});

test('Repos: add a found repo from Start, make a group with it, and New worktree offers both', async ({ page }) => {
  await page.goto(`${url}#/start`);
  await page.getByRole('button', { name: 'Repos & groups' }).click();
  await expect(page).toHaveURL(/#\/repos$/);
  const billing = page.locator('.wd-repos-row').filter({ has: page.locator('.wd-repos-folder', { hasText: /^billing$/ }) });
  await expect(billing.getByRole('textbox', { name: 'Alias for billing' })).toHaveValue('billing');
  await billing.getByRole('button', { name: 'Add' }).click();
  await expect(billing).toHaveCount(0);

  const groups = page.getByRole('region', { name: 'Groups' });
  await groups.getByRole('textbox', { name: 'New group name' }).fill('money');
  await groups.getByRole('checkbox', { name: 'api' }).check();
  await groups.getByRole('checkbox', { name: 'billing' }).check();
  await groups.getByRole('button', { name: 'Create group' }).click();
  await expect(groups.locator('.wd-repos-group', { hasText: 'money' })).toContainText('billing');

  await page.getByRole('button', { name: 'New worktree' }).first().click();
  const project = page.locator('.wd-modal').getByRole('combobox');
  await project.fill('mon');
  await expect(page.getByRole('option', { name: /money/ })).toBeVisible();
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: /Repos & groups…/ }).click();
  await expect(page).toHaveURL(/#\/repos$/);
});

test('Clean up finds the old merged worktree and removes it after a confirm', async ({ page }) => {
  await page.goto(`${url}#/sessions`);
  await page.getByRole('button', { name: 'Clean up', exact: true }).click();
  await expect(page).toHaveURL(/#\/cleanup$/);
  const item = page.locator('.wd-cleanup-safe .wd-cleanup-item', { hasText: 'spike/dark-mode' });
  await expect(item).toContainText("Nothing here that isn't in origin/HEAD");
  await expect(item.getByRole('checkbox')).toBeChecked();
  await page.getByRole('button', { name: 'Apply' }).click();
  await page.getByRole('button', { name: /^Confirm: remove 1/ }).click();
  await expect(page.locator('.wd-cleanup-results')).toContainText('1 done.');
  await expect(page.locator('.wd-dash-rail-item', { hasText: 'spike/dark-mode' })).toHaveCount(0);
});

test('Ctrl+K opens the assistant, which knows the tab you are on', async ({ page }) => {
  await page.goto(`${url}#/sessions`);
  const panel = page.locator('.wd-assistant');
  await expect(panel).toBeHidden();
  await page.keyboard.press('Control+k');
  await expect(panel).toBeVisible();
  await expect(panel.locator('.wd-assistant-seeing')).toHaveText('sees: the Sessions tab');
  // It tells the server what is on screen (the prompt hook reads that), and
  // again when the view changes. (The terminal draws on a canvas, so its
  // text isn't in the DOM to assert on.)
  const told = page.waitForRequest((r) => r.url().endsWith('/api/assistant/context') && r.postDataJSON()?.tab === 'inbox');
  await page.evaluate(() => {
    location.hash = '#/inbox';
  });
  await told;
  await expect(panel.locator('.wd-assistant-seeing')).toHaveText('sees: the Inbox tab');
  await panel.locator('.xterm').click();
  // Ctrl+K again closes it — even with focus inside its terminal.
  await page.keyboard.press('Control+k');
  await expect(panel).toBeHidden();
});

test('a session opens on its terminal, and going back to one is instant (same connection)', async ({ page }) => {
  const sockets: string[] = [];
  page.on('websocket', (ws) => sockets.push(ws.url()));
  await page.goto(url);
  await page.locator('.wd-dash-rail-item', { hasText: 'fix/login-redirect' }).click();
  await expect(page).toHaveURL(/\/term$/);
  await expect(page.getByRole('tab', { name: 'Terminal' })).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('.wd-term-deck .xterm').first()).toBeVisible();

  await page.locator('.wd-dash-rail-item', { hasText: 'feat/invoice-export' }).click();
  await expect(page.locator('.wd-session-detail-branch')).toHaveText('feat/invoice-export');
  await page.locator('.wd-dash-rail-item', { hasText: 'fix/login-redirect' }).click();
  await expect(page.locator('.wd-session-detail-branch')).toHaveText('fix/login-redirect');

  const terminals = sockets.filter((u) => u.includes('/terminal'));
  expect(terminals).toHaveLength(2); // one per session, none reopened
});

test('the terminal follows the window both ways: it grows, and shrinks back', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 700 });
  await page.goto(url);
  await page.locator('.wd-dash-rail-item', { hasText: 'fix/login-redirect' }).click();
  // What xterm drew (its canvas) against the box it sits in.
  const term = page.locator('.wd-term-deck .wd-term-deck-item[aria-hidden="false"] .xterm');
  await expect(term).toBeVisible();
  const widths = async () =>
    term.evaluate((el) => {
      const host = el.closest('.wd-pty-host') as HTMLElement;
      const drawn = Math.max(0, ...[...el.querySelectorAll('canvas')].map((c) => c.getBoundingClientRect().width));
      return { screen: drawn, host: host.getBoundingClientRect().width };
    });
  const small = await widths();

  await page.setViewportSize({ width: 1900, height: 700 });
  await expect.poll(async () => (await widths()).screen).toBeGreaterThan(small.screen + 300);

  await page.setViewportSize({ width: 1280, height: 700 });
  await expect.poll(async () => (await widths()).screen).toBeLessThan(small.screen + 30);
  const after = await widths();
  expect(after.screen).toBeLessThanOrEqual(after.host); // nothing drawn past the edge
});
