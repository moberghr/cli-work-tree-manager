import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../../../src/core/platform/config.js';
import { hostForOrigin, registerHost } from '../../../src/core/hosts/index.js';
import { github } from '../../../src/core/hosts/github/adapter.js';
import type { GitHost } from '../../../src/core/hosts/types.js';

// Each test file has its own HOME (tests/setup): this config.json is a throwaway.
const file = path.join(os.homedir(), '.work', 'config.json');
const write = (extra: object) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ worktreesRoot: os.homedir(), repos: {}, groups: {}, copyFiles: [], ...extra }));
};

// A host that claims nothing by its URL: only config can send a repo to it.
const corp: GitHost = { ...github, id: 'corp', name: 'Corp', matches: () => false };
const unregister = registerHost(corp);
afterAll(() => unregister());

describe('config gitHosts: the host of an origin its URL cannot tell', () => {
  it('is read as hostname → host id (strings only)', () => {
    write({ gitHosts: { 'git.corp.example': 'corp', bad: 3 } });
    expect(loadConfig()?.gitHosts).toEqual({ 'git.corp.example': 'corp' });
  });

  it("decides a repo's host from config.json, by its origin's hostname (any case), and changes when the file does", () => {
    write({ gitHosts: { 'GIT.corp.example': 'corp' } });
    expect(hostForOrigin('git@git.corp.example:team/api.git').id).toBe('corp');
    expect(hostForOrigin('https://git.corp.example/team/api').id).toBe('corp');
    expect(hostForOrigin('https://git.other.example/team/api').id).toBe('github'); // not named: the default
    write({ gitHosts: {} });
    expect(hostForOrigin('git@git.corp.example:team/api.git').id).toBe('github');
    write({ gitHosts: { 'git.corp.example': 'nobody' } }); // an unknown host id: as if unnamed
    expect(hostForOrigin('git@git.corp.example:team/api.git').id).toBe('github');
  });
});
