import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Hono } from 'hono';
import { mountPanesRoutes } from '../../../src/server/routes/panes-routes.js';
import { DEFAULT_PROMPTS } from '../../../src/core/sessions/saved-prompts.js';
import type { PromptsResponse } from '../../../src/core/api-types.js';

let home: string;
let app: Hono;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'panes-routes-'));
  vi.spyOn(os, 'homedir').mockReturnValue(home);
  fs.mkdirSync(path.join(home, '.work'));
  app = new Hono();
  mountPanesRoutes(app, { broadcast: () => {} });
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(home, { recursive: true, force: true });
});
const writeConfig = (extra: Record<string, unknown>) =>
  fs.writeFileSync(path.join(home, '.work', 'config.json'), JSON.stringify({ worktreesRoot: home, repos: {}, groups: {}, copyFiles: [], ...extra }));
const prompts = async () => (await (await app.request('/api/prompts')).json()) as PromptsResponse;

describe('GET /api/prompts', () => {
  it('the built-in prompts until config.json has its own', async () => {
    writeConfig({});
    expect(await prompts()).toEqual({ prompts: DEFAULT_PROMPTS, configured: false });
    writeConfig({ prompts: [{ label: 'Lint', prompt: 'npm run lint', repos: ['api'] }, { label: '' }] });
    expect(await prompts()).toEqual({ prompts: [{ label: 'Lint', prompt: 'npm run lint', repos: ['api'] }], configured: true });
  });

  it('works with no config at all', async () => {
    expect((await prompts()).prompts).toEqual(DEFAULT_PROMPTS);
  });
});
