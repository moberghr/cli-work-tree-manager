import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { WorktreeSession } from '../../src/core/history.js';
import { archiveSession } from '../../src/core/session-archive.js';
import { searchArchives, snippet } from '../../src/core/archive-search.js';

let tmp: string;
let root: string;
const line = (o: object) => JSON.stringify(o) + '\n';

async function archived(branch: string, lines: object[]) {
  const t = path.join(tmp, `${branch.replace('/', '-')}.jsonl`);
  fs.writeFileSync(t, lines.map(line).join(''));
  const s = { target: 'api', branch, isGroup: false, paths: [path.join(tmp, 'wt', branch)], createdAt: '', lastAccessedAt: '' } as WorktreeSession;
  await archiveSession(s, {
    stopClaude: async () => {},
    removable: async () => ({ ok: false, reason: 'test' }),
    removeWorktree: async () => false,
    setArchived: async () => true,
    transcripts: () => [t],
    archiveRoot: root,
  });
}

beforeEach(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-search-'));
  root = path.join(tmp, 'archive');
  await archived('fix/keys', [
    { type: 'user', timestamp: '2026-09-01T10:00:00Z', message: { content: 'Rotate the terminal encryption keys for stage' } },
    { type: 'assistant', timestamp: '2026-09-01T10:01:00Z', message: { content: [{ type: 'text', text: 'The new encryption key identifier is stored per terminal.' }, { type: 'tool_use', name: 'Bash', input: { command: 'encryption keys' } }] } },
    { type: 'user', isMeta: true, message: { content: 'encryption keys (meta, never shown)' } },
  ]);
  await archived('feat/csv', [{ type: 'user', timestamp: '2026-09-02T10:00:00Z', message: { content: 'Add a CSV export' } }]);
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe('searchArchives', () => {
  it('finds archived conversations where every word appears in one message, yours or Claude’s', async () => {
    const hits = await searchArchives('encryption KEY', root);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ target: 'api', branch: 'fix/keys' });
    expect(hits[0].snippets.map((s) => s.role)).toEqual(['you', 'claude']); // not the tool call, not the meta line
    expect(hits[0].snippets[1].text).toContain('encryption key identifier');
  });

  it('finds nothing for words that never meet in one message, or an empty query', async () => {
    expect(await searchArchives('csv encryption', root)).toEqual([]);
    expect(await searchArchives('  ', root)).toEqual([]);
    expect(await searchArchives('anything', path.join(tmp, 'no-archive'))).toEqual([]);
  });

  it('matches words with a backslash or a quote (escaped in the raw JSON)', async () => {
    await archived('fix/paths', [{ type: 'user', timestamp: '2026-09-03T10:00:00Z', message: { content: 'Open src\\core\\db.ts and set "strict" on' } }]);
    expect((await searchArchives('src\\core\\db.ts', root)).map((h) => h.branch)).toEqual(['fix/paths']);
    expect((await searchArchives('"strict"', root)).map((h) => h.branch)).toEqual(['fix/paths']);
  });

  it('newest archives first, and not a session that was restored since', async () => {
    for (const [i, b] of ['a/one', 'a/two', 'a/three'].entries()) {
      await archived(b, [{ type: 'user', message: { content: 'shared needle' } }]);
      // set each archive's time explicitly: one → oldest, three → newest
      const dir = fs.readdirSync(root).find((d) => JSON.parse(fs.readFileSync(path.join(root, d, 'archive.json'), 'utf8')).branch === b)!;
      const f = path.join(root, dir, 'archive.json');
      fs.writeFileSync(f, JSON.stringify({ ...JSON.parse(fs.readFileSync(f, 'utf8')), archivedAt: `2026-09-1${i}T10:00:00Z` }));
    }
    expect((await searchArchives('needle', root)).map((h) => h.branch)).toEqual(['a/three', 'a/two', 'a/one']);
    const restored = fs.readdirSync(root).find((d) => JSON.parse(fs.readFileSync(path.join(root, d, 'archive.json'), 'utf8')).branch === 'a/two')!;
    expect((await searchArchives('needle', root, (id) => id !== restored)).map((h) => h.branch)).toEqual(['a/three', 'a/one']);
  });

  it('cuts a snippet around the match', () => {
    const long = 'x '.repeat(200) + 'the needle is here ' + 'y '.repeat(200);
    const s = snippet(long, ['needle']);
    expect(s.startsWith('…')).toBe(true);
    expect(s).toContain('the needle is here');
    expect(s.length).toBeLessThan(260);
  });
});
