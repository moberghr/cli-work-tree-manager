import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { WorktreeSession } from '../../src/core/history.js';
import { archiveSession } from '../../src/core/session-archive.js';
import { sessionIdFor } from '../../src/core/session-id.js';
import { claudeProjectsRoot, encodeProjectDir } from '../../src/core/claude-activity.js';
import { conversationDirFor, searchConversations, syncConversation, syncConversations } from '../../src/core/conversation-store.js';
import type { TranscriptFile } from '../../src/core/context-usage.js';

let tmp: string;
let root: string;
let archive: string;
const line = (o: object) => JSON.stringify(o) + '\n';
const prompt = (text: string, at = '2026-09-01T10:00:00Z') => line({ type: 'user', timestamp: at, message: { content: text } });
const reply = (text: string) => line({ type: 'assistant', timestamp: '2026-09-01T10:01:00Z', message: { content: [{ type: 'text', text }] } });

const session = (branch: string, extra: Partial<WorktreeSession> = {}): WorktreeSession =>
  ({ target: 'api', branch, isGroup: false, paths: [path.join(tmp, 'wt', branch.replace('/', '-'))], createdAt: '', lastAccessedAt: '', ...extra }) as WorktreeSession;

const source = (file: string): TranscriptFile => {
  const st = fs.statSync(file);
  return { file, size: st.size, mtimeMs: st.mtimeMs };
};

/** A session with one conversation, copied into the store. */
async function kept(s: WorktreeSession, text: string, name = `${sessionIdFor(s)}-c.jsonl`) {
  const src = path.join(tmp, name);
  fs.writeFileSync(src, text);
  await syncConversation(s, root, [source(src)]);
  return src;
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'conv-store-'));
  root = path.join(tmp, 'conversations');
  archive = path.join(tmp, 'archive');
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe('syncConversation', () => {
  it('copies a transcript, then only the bytes added since', async () => {
    const s = session('fix/keys');
    const src = path.join(tmp, 'c.jsonl');
    fs.writeFileSync(src, prompt('one'));
    expect(await syncConversation(s, root, [source(src)])).toEqual({ files: 1, bytes: fs.statSync(src).size });
    const added = prompt('two');
    fs.appendFileSync(src, added);
    expect(await syncConversation(s, root, [source(src)])).toEqual({ files: 1, bytes: Buffer.byteLength(added) });
    expect(await syncConversation(s, root, [source(src)])).toEqual({ files: 0, bytes: 0 }); // nothing new
    expect(fs.readFileSync(path.join(conversationDirFor(sessionIdFor(s), root), 'c.jsonl'), 'utf8')).toBe(fs.readFileSync(src, 'utf8'));
  });

  it('two syncs at once write the same bytes once, not twice', async () => {
    const s = session('fix/race');
    const src = path.join(tmp, 'c.jsonl');
    fs.writeFileSync(src, prompt('one').repeat(50));
    await Promise.all([syncConversation(s, root, [source(src)]), syncConversation(s, root, [source(src)])]);
    expect(fs.readFileSync(path.join(conversationDirFor(sessionIdFor(s), root), 'c.jsonl'), 'utf8')).toBe(fs.readFileSync(src, 'utf8'));
  });

  it('a source smaller than the copy was replaced: copied whole', async () => {
    const s = session('fix/replaced');
    const src = path.join(tmp, 'c.jsonl');
    fs.writeFileSync(src, prompt('a long first version'));
    await syncConversation(s, root, [source(src)]);
    fs.writeFileSync(src, prompt('short'));
    await syncConversation(s, root, [source(src)]);
    expect(fs.readFileSync(path.join(conversationDirFor(sessionIdFor(s), root), 'c.jsonl'), 'utf8')).toBe(prompt('short'));
  });

  it('keeps the copy after Claude Code deletes its transcript', async () => {
    const s = session('fix/old');
    const src = await kept(s, prompt('rotate the encryption keys'));
    fs.rmSync(src);
    await syncConversation(s, root, []);
    expect((await searchConversations('encryption', { sessions: [s], root, archive })).map((h) => h.branch)).toEqual(['fix/old']);
  });
});

describe('syncConversations', () => {
  it("copies each session's transcripts from Claude Code's project folder", async () => {
    const s = session('feat/csv');
    const projectDir = path.join(claudeProjectsRoot(), encodeProjectDir(s.paths[0]));
    fs.mkdirSync(projectDir, { recursive: true });
    fs.writeFileSync(path.join(projectDir, 'abc.jsonl'), prompt('add a csv export'));
    const r = await syncConversations([s, session('feat/none')], root);
    expect(r).toMatchObject({ files: 1, sessions: 1 });
    expect(fs.existsSync(path.join(conversationDirFor(sessionIdFor(s), root), 'abc.jsonl'))).toBe(true);
  });
});

describe('searchConversations', () => {
  it('finds messages where every word appears, yours or Claude’s — not tool calls or meta lines', async () => {
    const s = session('fix/keys');
    await kept(
      s,
      prompt('Rotate the terminal encryption keys for stage') +
        line({ type: 'assistant', message: { content: [{ type: 'text', text: 'The new encryption key identifier is stored per terminal.' }, { type: 'tool_use', name: 'Bash', input: { command: 'encryption keys' } }] } }) +
        line({ type: 'user', isMeta: true, message: { content: 'encryption keys (meta, never shown)' } }),
    );
    await kept(session('feat/csv'), prompt('Add a CSV export'));
    const hits = await searchConversations('encryption KEY', { sessions: [s, session('feat/csv')], root, archive });
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ sessionId: sessionIdFor(s), branch: 'fix/keys', archived: false });
    expect(hits[0].snippets.map((x) => x.role)).toEqual(['you', 'claude']);
    expect(hits[0].lastAt).toEqual(expect.any(String));
  });

  it('nothing for words that never meet in one message, or an empty query', async () => {
    const s = session('fix/keys');
    await kept(s, prompt('encryption') + reply('csv'));
    expect(await searchConversations('csv encryption', { sessions: [s], root, archive })).toEqual([]);
    expect(await searchConversations('  ', { sessions: [s], root, archive })).toEqual([]);
  });

  it('matches words with a backslash or a quote (escaped in the raw JSON)', async () => {
    const s = session('fix/paths');
    await kept(s, prompt('Open src\\core\\db.ts and set "strict" on'));
    expect((await searchConversations('src\\core\\db.ts', { sessions: [s], root, archive })).map((h) => h.branch)).toEqual(['fix/paths']);
    expect((await searchConversations('"strict"', { sessions: [s], root, archive })).map((h) => h.branch)).toEqual(['fix/paths']);
  });

  it('most recently active first', async () => {
    const sessions = ['a/one', 'a/two', 'a/three'].map((b) => session(b));
    for (const [i, s] of sessions.entries()) {
      await kept(s, prompt('shared needle'));
      const f = path.join(conversationDirFor(sessionIdFor(s), root), `${sessionIdFor(s)}-c.jsonl`);
      fs.utimesSync(f, new Date(Date.UTC(2026, 8, 10 + i)), new Date(Date.UTC(2026, 8, 10 + i)));
    }
    expect((await searchConversations('needle', { sessions, root, archive })).map((h) => h.branch)).toEqual(['a/three', 'a/two', 'a/one']);
  });

  it('an archived session: its archive (also from before the store), its written summary, and Restore info', async () => {
    const s = session('fix/archived');
    const t = path.join(tmp, 'archived.jsonl');
    fs.writeFileSync(t, prompt('rotate the encryption keys'));
    await archiveSession(s, {
      stopClaude: async () => {},
      removable: async () => ({ ok: true, reason: '' }),
      removeWorktree: async () => true,
      setArchived: async () => true,
      transcripts: () => [t],
      archiveRoot: archive,
    });
    const rec = path.join(archive, sessionIdFor(s), 'archive.json');
    const json = JSON.parse(fs.readFileSync(rec, 'utf8'));
    fs.writeFileSync(rec, JSON.stringify({ ...json, summary: { ...json.summary, written: 'Rotated the encryption keys for every terminal.' } }));
    const archived = { ...s, archivedAt: json.archivedAt };
    const [hit] = await searchConversations('encryption keys', { sessions: [archived], root, archive });
    expect(hit).toMatchObject({ archived: true, archivedAt: json.archivedAt, worktreeRemoved: true });
    expect(hit.snippets.map((x) => x.role)).toEqual(['summary', 'you']);
    // Restored since: live again, read from its own copy, no Restore.
    await kept(s, prompt('rotate the encryption keys once more'));
    const [live] = await searchConversations('once more', { sessions: [s], root, archive });
    expect(live).toMatchObject({ archived: false, worktreeRemoved: false });
  });
});
