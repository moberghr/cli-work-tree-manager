import { test, expect, type WorkEnv } from './fixtures.js';
import type { Page } from '@playwright/test';

/** Open a session's Terminal tab and type a line into the browser xterm. */
async function openTerminal(page: Page, work: WorkEnv, branch: string): Promise<string> {
  const id = work.sessionId('app', branch);
  await page.goto(`${work.url}#/s/${id}/term`);
  await expect(page.locator('.wd-pty-host .xterm')).toBeVisible();
  return id;
}

async function typeLine(page: Page, text: string): Promise<void> {
  await page.locator('.wd-pty-host .xterm').click();
  await page.keyboard.type(text);
  await page.keyboard.press('Enter');
}

test('dashboard lists the session and the browser terminal drives the PTY', async ({ page, work }) => {
  work.setup(['feat/a']);
  await work.startWeb();

  await page.goto(work.url);
  const item = page.locator('.wd-dash-rail-item', { hasText: 'feat/a' });
  await expect(item).toBeVisible();
  await item.click();
  await page.getByRole('tab', { name: 'Terminal' }).or(page.locator('button', { hasText: /^Terminal$/ })).first().click();
  await expect(page.locator('.wd-pty-host .xterm')).toBeVisible();

  const id = work.sessionId('app', 'feat/a');
  await work.waitForPty(id);
  await work.waitForScreen(id, 'FAKE-AI READY');

  await typeLine(page, 'hello');
  await work.waitForScreen(id, 'echo:hello');
});

test('agents survive a work web restart (same PTY, screen replayed)', async ({ page, work }) => {
  work.setup(['feat/a']);
  await work.startWeb();
  const id = await openTerminal(page, work, 'feat/a');
  const before = await work.waitForPty(id);
  await work.waitForScreen(id, 'FAKE-AI READY');
  await typeLine(page, 'hello');
  await work.waitForScreen(id, 'echo:hello');

  await work.stopWeb();
  await work.startWeb();

  const after = await work.waitForPty(id);
  expect(after.pid).toBe(before.pid);
  expect(after.restored).toBe(false);

  // The reconnected browser terminal still drives the same process, and
  // the earlier output survived in the host's screen.
  await openTerminal(page, work, 'feat/a');
  await typeLine(page, 'again');
  const screen = await work.waitForScreen(id, 'echo:again');
  expect(screen).toContain('echo:hello');
});

test('after the PTY host dies (reboot), work web restores the session', async ({ page, work }) => {
  work.setup(['feat/a']);
  await work.startWeb();
  const id = await openTerminal(page, work, 'feat/a');
  const before = await work.waitForPty(id);
  await work.waitForScreen(id, 'FAKE-AI READY');

  await work.stopWeb();
  const hostPid = work.hostInfo()!.pid;
  work.stopHost();
  await work.waitForDead(hostPid);

  await work.startWeb();
  const restored = await work.waitForPty(id, (p) => !p.exited && p.restored);
  expect(restored.pid).not.toBe(before.pid);
  await work.waitForScreen(id, 'FAKE-AI READY');

  // And it's usable from the browser again.
  await openTerminal(page, work, 'feat/a');
  await typeLine(page, 'back');
  await work.waitForScreen(id, 'echo:back');
});

test('a bare dashboard URL returns to the last session and tab', async ({ page, work }) => {
  work.setup(['feat/a']);
  await work.startWeb();
  const id = await openTerminal(page, work, 'feat/a');

  await page.goto(work.url);
  await expect(page).toHaveURL(new RegExp(`#/s/${id}/term$`));
  await expect(page.locator('.wd-pty-host .xterm')).toBeVisible();
});

test('switching sessions marks the previous diff stale until the new one loads', async ({ page, work }) => {
  work.setup(['feat/a', 'feat/b']);
  await work.startWeb();
  const a = work.sessionId('app', 'feat/a');
  const b = work.sessionId('app', 'feat/b');

  await page.goto(`${work.url}#/s/${a}/diff`);
  const main = page.locator('.wd-web-review-main');
  await expect(main).toBeVisible();
  await expect(main).not.toHaveClass(/wd-diff-stale/);

  // Hold feat/b's diff so the stale window is observable.
  let release!: () => void;
  const held = new Promise<void>((r) => { release = r; });
  await page.route(`**/api/sessions/${b}/diff*`, async (route) => {
    await held;
    await route.continue();
  });

  await page.locator('.wd-dash-rail-item', { hasText: 'feat/b' }).click();
  await expect(main).toHaveClass(/wd-diff-stale/);
  await expect(main).toHaveAttribute('aria-busy', 'true');
  // Header already names the new session, so the count must not claim
  // the old session's numbers.
  await expect(page.locator('.wd-web-review-sidebar-header')).toContainText('loading…');

  release();
  await expect(main).not.toHaveClass(/wd-diff-stale/);
  await expect(page.locator('.wd-web-review-sidebar-header')).toContainText('feat/b');
});

test('attention inbox: blocked and finished sessions surface in order and clear when handled', async ({ page, work }) => {
  work.setup(['feat/a', 'feat/b', 'feat/c']);
  await work.startWeb();
  const cwd = (b: string) => work.worktreePath(b);

  // feat/a: working. feat/b: blocked on a permission. feat/c: finished a turn.
  work.hook('status-prompt', { cwd: cwd('feat/a'), prompt: 'Refactor the ledger' });
  work.hook('status-prompt', { cwd: cwd('feat/b'), prompt: 'Run the migration' });
  work.hook('status-notify', { cwd: cwd('feat/b'), message: 'Claude needs your permission to use Bash' });
  work.hook('status-prompt', { cwd: cwd('feat/c'), prompt: 'Write tests' });
  work.hook('status-stop', { cwd: cwd('feat/c') });

  await page.goto(`${work.url}#/inbox`);
  const sections = page.locator('.wd-inbox-section h2');
  await expect(sections).toHaveText([/Needs your input \(1\)/, /Done — not looked at yet \(1\)/, /Working \(1\)/]);
  await expect(page.locator('.wd-inbox-rank-0 .wd-inbox-row')).toContainText('Claude needs your permission to use Bash');
  await expect(page.locator('.wd-inbox-rank-2 .wd-inbox-row')).toContainText('Refactor the ledger');
  // Badge + browser tab title count the two that want you.
  await expect(page.locator('.wd-dash-tab-badge')).toHaveText('2');
  await expect(page).toHaveTitle('(2) work');
  // The rail puts them first.
  await expect(page.locator('.wd-dash-rail-name').first()).toHaveText('feat/b');

  // `n` jumps to the most urgent one, on its terminal.
  await page.keyboard.press('n');
  await expect(page).toHaveURL(new RegExp(`#/s/${work.sessionId('app', 'feat/b')}/term$`));

  // Opening the finished one (from the inbox) marks it seen.
  await page.goto(`${work.url}#/inbox`);
  await page.locator('.wd-inbox-rank-1 .wd-inbox-row').click();
  await expect(page).toHaveURL(new RegExp(`#/s/${work.sessionId('app', 'feat/c')}/diff$`));
  await expect(page).toHaveTitle('(1) work');

  // Answering the blocked one (a new prompt) clears it; a new hook event
  // reaches the open page live via SSE — no reload.
  work.hook('status-prompt', { cwd: cwd('feat/b'), prompt: 'yes, go ahead' });
  await expect(page).toHaveTitle('work');
  await expect(page.locator('.wd-dash-tab-badge')).toHaveCount(0);
});
