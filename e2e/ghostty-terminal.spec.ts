import { test, expect } from './fixtures.js';
import type { Page } from '@playwright/test';

/** The rows the libghostty engine shows, through its test accessor: a canvas has no text to read. */
const screenText = (page: Page) =>
  page.locator('.wd-pty-host .wd-ghostty').evaluate((el) => (el as HTMLElement & { wdScreenText(): string }).wdScreenText());

test('the libghostty engine draws what is typed, scrolls back, selects and copies a line', async ({ page, work, context }) => {
  work.setup(['feat/a']);
  await work.startWeb();
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: new URL(work.url).origin });
  const id = work.sessionId('app', 'feat/a');
  await page.goto(`${work.url}?terminalEngine=ghostty#/s/${id}/term`);
  const surface = page.locator('.wd-pty-host .wd-ghostty canvas');
  await expect(surface).toBeVisible();
  await work.waitForScreen(id, 'FAKE-AI READY');
  await expect.poll(() => screenText(page)).toContain('FAKE-AI READY');

  await surface.click();
  await page.keyboard.type('hello ghostty');
  await page.keyboard.press('Enter');
  await expect.poll(() => screenText(page)).toContain('echo:hello ghostty');

  // More lines than the screen holds: the first goes into the scrollback.
  for (let i = 1; i <= 40; i++) {
    await page.keyboard.type(`line ${i}`);
    await page.keyboard.press('Enter');
  }
  await expect.poll(() => screenText(page)).toContain('echo:line 40');
  expect(await screenText(page)).not.toContain('echo:hello ghostty');
  const box = (await surface.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, -4000);
  await expect.poll(() => screenText(page)).toContain('echo:hello ghostty');

  // A triple click selects the line; Ctrl+C copies it (and is not sent: the agent still answers).
  const rows = (await screenText(page)).split('\n');
  const y = rows.findIndex((l) => l === 'echo:hello ghostty');
  expect(y).toBeGreaterThanOrEqual(0);
  const rowHeight = box.height / rows.length;
  await page.mouse.click(box.x + 20, box.y + (y + 0.5) * rowHeight, { clickCount: 3 });
  await page.keyboard.press('Control+c');
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe('echo:hello ghostty');

  await page.keyboard.type('after');
  await page.keyboard.press('Enter');
  // Typing went back to the bottom, where the answer is.
  await expect.poll(() => screenText(page)).toContain('echo:after');
});
