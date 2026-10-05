import fs from 'node:fs';
import path from 'node:path';
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
  await page
    .getByRole('tab', { name: 'Terminal' })
    .or(page.locator('button', { hasText: /^Terminal$/ }))
    .first()
    .click();
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
  const held = new Promise<void>((r) => {
    release = r;
  });
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
  // Their Claudes run (outside work, as in your own terminals): a session with no
  // Claude can't stay working or waiting once work web has listed the processes.
  work.fakeClaude('feat/a', 'busy');
  work.fakeClaude('feat/b', 'waiting');

  await page.goto(`${work.url}#/inbox`);
  const sections = page.locator('.wd-inbox-section h2');
  await expect(sections).toHaveText([/Needs your input · 1/, /Done · 1/]);
  await expect(page.locator('.wd-inbox-rank-0 .wd-inbox-row')).toContainText('Claude needs your permission to use Bash');
  // Working is the rail's: the Inbox says how many, in its last line.
  await expect(page.locator('.wd-inbox-rest')).toContainText('1 working');
  // Badge + browser tab title count the two that want you.
  await expect(page.locator('.wd-dash-tab-badge')).toHaveText('2');
  await expect(page).toHaveTitle('(2) work');
  // The rail keeps a STABLE order (urgency ordering is the Inbox's and
  // `n`'s job) but marks the blocked session.
  await expect(page.locator('.wd-dash-rail-item', { hasText: 'feat/b' }).locator('.wd-rail-dot-needs_input')).toHaveCount(1);

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

test('ship: create a PR, merge it after confirming, and the session archives itself', async ({ page, work }) => {
  work.setup(['feat/ship']);
  work.commitIn('feat/ship', 'feature.ts', 'export const shipped = true;\n');
  await work.startWeb();
  const id = work.sessionId('app', 'feat/ship');

  await page.goto(`${work.url}#/s/${id}/diff`);
  await page.getByRole('button', { name: 'More actions' }).click();
  await page.getByRole('menuitem', { name: /^Ship/ }).click();
  const panel = page.getByRole('dialog', { name: 'Ship session' });
  await expect(panel).toBeVisible();
  // Unpublished branch with a commit, no PR yet: Create PR is offered, Merge isn't.
  await expect(panel.getByRole('button', { name: 'Create PR' })).toBeEnabled();
  await expect(panel.getByRole('button', { name: 'Merge…' })).toBeDisabled();

  await panel.getByRole('button', { name: 'Create PR' }).click();
  await expect(panel).toContainText('PR opened');
  expect(work.ghCalls().some((a) => a[1] === 'create')).toBe(true);

  // Preflight refreshed: an open, green PR → Merge needs an explicit confirm.
  await expect(panel.getByRole('button', { name: 'Merge…' })).toBeEnabled();
  await panel.getByRole('button', { name: 'Merge…' }).click();
  await panel.getByRole('alertdialog', { name: 'Confirm merge' }).getByRole('button', { name: 'Confirm merge' }).click();

  // Merged with the SHA guard, archived, and gone from the rail.
  await expect(page).not.toHaveURL(new RegExp(`#/s/${id}`));
  const merge = work.ghCalls().find((a) => a[1] === 'merge')!;
  expect(merge.slice(0, 5)).toEqual(['pr', 'merge', '42', '--squash', '--match-head-commit']);
  await expect(page.locator('.wd-dash-rail-item', { hasText: 'feat/ship' })).toHaveCount(0);
  expect((await work.sessions()).find((s) => s.branch === 'feat/ship')?.archivedAt).toBeTruthy();
});

test('ship a group in parts: merge backend now, frontend later; archived only when both are done', async ({ page, work }) => {
  work.setupGroup('feat/g');
  const be = work.groupWorktreePath('feat/g', 'backend');
  const fe = work.groupWorktreePath('feat/g', 'frontend');
  work.commitAt(be, 'api.ts', 'export const api = 1;\n');
  work.commitAt(fe, 'ui.tsx', 'export const ui = 1;\n');
  await work.startWeb();
  const id = work.sessionId('shop', 'feat/g');
  const prState = (cwd: string) => JSON.parse(fs.readFileSync(path.join(work.home, 'gh-state.json'), 'utf-8'))[cwd.toLowerCase()]?.state;

  await page.goto(`${work.url}#/s/${id}/diff`);
  await page.getByRole('button', { name: 'More actions' }).click();
  await page.getByRole('menuitem', { name: /^Ship/ }).click();
  const panel = page.getByRole('dialog', { name: 'Ship session' });
  await panel.getByRole('button', { name: 'Create PR' }).click();
  await expect(panel.locator('.wd-ship-results')).toContainText('frontend');
  await expect(panel.getByLabel('Merge backend')).toBeChecked();
  await expect(panel.getByLabel('Merge frontend')).toBeChecked();

  // Step 1: frontend isn't ready — untick it, merge backend only.
  await panel.getByLabel('Merge frontend').uncheck();
  await panel.getByRole('button', { name: 'Merge 1…' }).click();
  const confirm = panel.getByRole('alertdialog', { name: 'Confirm merge' });
  await expect(confirm).toContainText('1 other repository stays open');
  await confirm.getByRole('button', { name: 'Confirm merge' }).click();

  // Backend merged; the session stays (not archived); backend now shows done.
  await expect(panel).toContainText('✓ merged');
  expect(prState(be)).toBe('MERGED');
  expect(prState(fe)).toBe('OPEN');
  await expect(page).toHaveURL(new RegExp(`#/s/${id}`));
  expect((await work.sessions()).find((s) => s.target === 'shop')?.archivedAt).toBeNull();
  await expect(panel.getByLabel('Merge backend')).toHaveCount(0); // done: not selectable

  // Step 2: finish the group — frontend only; now it archives.
  await expect(panel.getByLabel('Merge frontend')).toBeChecked();
  await panel.getByRole('button', { name: 'Merge 1…' }).click();
  await expect(confirm).toContainText('the session is archived');
  await confirm.getByRole('button', { name: 'Confirm merge' }).click();
  await expect(page).not.toHaveURL(new RegExp(`#/s/${id}`));
  expect(prState(fe)).toBe('MERGED');
  expect((await work.sessions()).find((s) => s.target === 'shop')?.archivedAt).toBeTruthy();
  // Each merge carried the SHA the panel showed.
  expect(
    work
      .ghCalls()
      .filter((a) => a[1] === 'merge')
      .every((a) => a.includes('--match-head-commit')),
  ).toBe(true);
});
