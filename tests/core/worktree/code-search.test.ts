import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Hono } from 'hono';
import { git } from '../../../src/core/git/git.js';
import { clearSymbolIndexes, MAX_TEXT_HITS, searchSymbols, searchText, symbolIndex } from '../../../src/core/worktree/code-search.js';
import { saveHistory, type WorktreeSession } from '../../../src/core/sessions/history.js';
import { sessionIdFor } from '../../../src/core/sessions/web-state.js';
import { mountCodeRoutes } from '../../../src/server/routes/code-routes.js';
import type { CodeSearchWire, CodeSymbol } from '../../../src/core/api-types.js';

let tmp: string;
let repo: string;
const session = () => ({ paths: [repo] });

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'code-search-'));
  repo = path.join(tmp, 'api');
  fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
  git(['init', '-b', 'main'], repo);
  fs.writeFileSync(
    path.join(repo, 'src', 'Keys.cs'),
    ['namespace Api;', 'public class AccountingKeys', '{', '    public string GetAccount(int id) => "";', '}', ''].join('\n'),
  );
  fs.writeFileSync(path.join(repo, 'src', 'use.ts'), "export function useKeys() { return 'accountingkeys'; }\n");
  fs.writeFileSync(path.join(repo, 'src', 'many.txt'), Array.from({ length: MAX_TEXT_HITS + 20 }, (_, i) => `needle ${i}`).join('\n'));
  fs.writeFileSync(path.join(repo, '.gitignore'), 'secret.txt\n');
  fs.writeFileSync(path.join(repo, 'secret.txt'), 'AccountingKeys in an ignored file\n');
});
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));
beforeEach(() => clearSymbolIndexes());

describe('searchText', () => {
  it('smart case: all lower case matches any case; a capital means that case', async () => {
    const any = await searchText(session(), 'accountingkeys');
    expect(any.hits.map((h) => `${h.path}:${h.line}`).sort()).toEqual(['src/Keys.cs:2', 'src/use.ts:1']);
    const exact = await searchText(session(), 'AccountingKeys');
    expect(exact.hits.map((h) => h.path)).toEqual(['src/Keys.cs']);
    expect(exact.hits[0]).toMatchObject({ repo: 'api', line: 2, text: 'public class AccountingKeys' });
  });

  it('never what git ignores; at most MAX_TEXT_HITS lines, said so', async () => {
    expect((await searchText(session(), 'ignored file')).hits).toEqual([]);
    const many = await searchText(session(), 'needle');
    expect(many.hits).toHaveLength(MAX_TEXT_HITS);
    expect(many.truncated).toBe(true);
  });

  it('a search given up on (a newer keystroke) stops', async () => {
    const ac = new AbortController();
    ac.abort();
    const r = await searchText(session(), 'needle', ac.signal);
    expect(r.hits.length).toBeLessThan(MAX_TEXT_HITS);
  });
});

describe('searchSymbols', () => {
  it('types and members by name, the shorthand too', async () => {
    expect((await searchSymbols(session(), 'AccKeys')).map((s) => `${s.kind} ${s.name}`)).toEqual(['class AccountingKeys']);
    expect((await searchSymbols(session(), 'GetAccount')).map((s) => [s.kind, s.path, s.line])).toEqual([['method', 'src/Keys.cs', 4]]);
    expect((await searchSymbols(session(), 'useKeys'))[0]).toMatchObject({ kind: 'function', path: 'src/use.ts' });
  });

  it('the index is built once, and again in the background once stale — the old one answers meanwhile', async () => {
    const one: CodeSymbol = { name: 'Old', kind: 'class', repo: 'api', path: 'a.cs', line: 1, text: '' };
    const build = vi.fn(async () => [one]);
    const t0 = 1_000_000;
    expect((await symbolIndex('api', '/r', t0, build)).map((p) => p.s.name)).toEqual(['Old']);
    await symbolIndex('api', '/r', t0 + 1000, build);
    expect(build).toHaveBeenCalledTimes(1); // fresh: the cached one
    build.mockResolvedValueOnce([{ ...one, name: 'New' }]);
    expect((await symbolIndex('api', '/r', t0 + 120_000, build)).map((p) => p.s.name)).toEqual(['Old']); // stale: old answers
    await new Promise((r) => setTimeout(r, 0));
    expect(build).toHaveBeenCalledTimes(2);
    expect((await symbolIndex('api', '/r', Date.now(), build)).map((p) => p.s.name)).toEqual(['New']);
  });
});

describe('GET /api/sessions/:id/code-search', () => {
  it('both kinds at once; fewer than two letters searches nothing', async () => {
    const s: WorktreeSession = { target: 'api', isGroup: false, branch: 'feat/x', paths: [repo], createdAt: '', lastAccessedAt: '' };
    saveHistory([s]);
    const app = new Hono();
    mountCodeRoutes(app);
    const id = sessionIdFor(s);
    const w = (await (await app.request(`/api/sessions/${id}/code-search?q=AccKeys`)).json()) as CodeSearchWire;
    expect(w.symbols.map((x) => x.name)).toEqual(['AccountingKeys']);
    const t = (await (await app.request(`/api/sessions/${id}/code-search?q=accountingkeys`)).json()) as CodeSearchWire;
    expect(t.text).toHaveLength(2);
    const short = (await (await app.request(`/api/sessions/${id}/code-search?q=a`)).json()) as CodeSearchWire;
    expect(short).toEqual({ query: 'a', symbols: [], text: [], truncated: false });
    expect((await app.request('/api/sessions/nope/code-search?q=ab')).status).toBe(404);
  });
});
