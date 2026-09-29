import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test, expect } from '@playwright/test';

/**
 * `work web --demo` end to end: the built binary, the real SPA, the
 * simulated API. Run under an EMPTY home and assert afterwards that it
 * created no state there — the demo touches no repos, agents or ~/.work.
 */

const BIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'bin.js');
let home: string;
let child: ChildProcess;
let url: string;

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
  await page.getByRole('button', { name: /^Ship/ }).click();
  const panel = page.getByRole('dialog', { name: 'Ship session' });
  await panel.getByRole('button', { name: 'Create PR' }).click();
  await expect(panel.locator('.wd-ship-results')).toContainText('PR opened');
  await expect(panel).toContainText('checks still running');
  // Simulated checks go green after a few seconds; reopen to re-check.
  await page.waitForTimeout(7_000);
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: /^Ship/ }).click();
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
  await expect(page.getByText('Notifications on')).toBeVisible();

  // Answer the blocked agent, then look elsewhere while it works.
  await page.locator('.wd-inbox-rank-0 .wd-inbox-row', { hasText: 'feat/invoice-export' }).click();
  await page.locator('.wd-pty-host .xterm').click();
  await page.keyboard.type('1');
  await page.keyboard.press('Enter');
  await page.locator('.wd-dash-rail-item', { hasText: 'fix/login-redirect' }).click();

  await expect
    .poll(() => page.evaluate(() => (window as unknown as { __notes: Array<{ title: string }> }).__notes.map((n) => n.title)), { timeout: 20_000 })
    .toContain('Finished — api · feat/invoice-export');
  await page.evaluate(() => (window as unknown as { __notes: Array<{ title: string; click: () => void }> }).__notes.find((n) => n.title.startsWith('Finished'))!.click());
  await expect(page.locator('.wd-dash-rail-item[aria-current], .wd-dash-rail-item-active').first()).toContainText('feat/invoice-export');
});

test('start a worktree dev server and get a preview link on its port', async ({ page }) => {
  await page.goto(url);
  await page.locator('.wd-dash-rail-item', { hasText: 'fix/login-redirect' }).click();
  const chip = page.locator('.wd-dev-chip');
  await expect(chip).toContainText(/:\d+/);
  await chip.getByRole('button', { name: /Start dev/ }).click();
  await expect(chip.getByRole('link', { name: 'Preview ↗' })).toHaveAttribute('href', /^http:\/\/localhost:\d+\/$/, { timeout: 10_000 });
  await chip.getByRole('button', { name: /Stop/ }).click();
  await expect(chip.getByRole('link', { name: 'Preview ↗' })).toHaveCount(0);
});

test('failing CI shows under the header, and Claude fixes it on request', async ({ page }) => {
  await page.goto(url);
  await page.locator('.wd-dash-rail-item', { hasText: 'chore/deps-update' }).click();
  const strip = page.locator('.wd-ci-strip');
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
  await page.getByRole('button', { name: /^Ship/ }).click();
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
  // It leaves "Needs your input" and shows up as working, with what was allowed.
  await expect(page.locator('.wd-inbox-rank-0', { hasText: 'feat/invoice-export' })).toHaveCount(0);
  await expect(page.locator('.wd-inbox-rank-2 .wd-inbox-item', { hasText: 'feat/invoice-export' })).toContainText('Allowed Bash: npm test -- invoices');
});

test('"Review all" walks the finished sessions, each on its last turn, and n moves on', async ({ page }) => {
  await page.goto(`${url}#/inbox`);
  const done = page.locator('.wd-inbox-rank-1 .wd-inbox-item');
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

test('a Jira issue starts a session with a first prompt, opened on its terminal', async ({ page }) => {
  await page.goto(`${url}#/jira`);
  await page.locator('.wd-jira-card').first().click();
  const dialog = page.getByRole('dialog');
  const prompt = dialog.locator('textarea');
  await expect(prompt).toHaveValue(/^Work on [A-Z]+-\d+: /);
  await prompt.fill('Work on it: add the export button');
  await dialog.getByRole('button', { name: 'Create & start' }).click();
  await expect(page).toHaveURL(/\/term$/);
  await expect(page.locator('.wd-session-strip')).toContainText('Work on it: add the export button');
});

test('a saved prompt is sent to a session from its header, and shows in its comments', async ({ page }) => {
  await page.goto(`${url}#/sessions`);
  await page.locator('.wd-dash-rail-item', { hasText: 'fix/login-redirect' }).click();
  await page.getByRole('button', { name: 'Prompts ▾' }).click();
  await page.getByRole('menuitem', { name: 'Add tests' }).click();
  await expect(page.locator('.wd-prompts-state')).toContainText('"Add tests"');
  await page.getByRole('tab', { name: /Comments/ }).click();
  await expect(page.locator('.wd-session-detail')).toContainText('Add tests for what changed on this branch');
});

test('Today lists what each session did, and g d gets there', async ({ page }) => {
  await page.goto(`${url}#/inbox`);
  await page.locator('body').press('g');
  await page.locator('body').press('d');
  await expect(page).toHaveURL(/#\/today$/);
  const card = page.locator('.wd-today-card', { hasText: 'feat/invoice-export' });
  await expect(card).toContainText('Add CSV export to the invoices endpoint');
  await expect(card).toContainText('needs your input');
  await card.locator('.wd-today-title').click();
  await expect(page).toHaveURL(/#\/s\/demo-api-feat-invoice-export\/diff$/);
});
