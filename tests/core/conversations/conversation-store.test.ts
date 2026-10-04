import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { WorktreeSession } from '../../../src/core/sessions/history.js';
import { archiveSession } from '../../../src/core/archive/session-archive.js';
import { sessionIdFor } from '../../../src/core/sessions/session-id.js';
import { claudeProjectsRoot, encodeProjectDir } from '../../../src/core/agents/claude/activity.js';
import {
  compressQuietCopies,
  conversationDirFor,
  PACK_QUIET_MS,
  searchConversations,
  syncConversation,
  syncConversations,
} from '../../../src/core/conversations/conversation-store.js';
import type { TranscriptFile } from '../../../src/core/conversations/context-usage.js';

let tmp: string;
let root: string;
let archive: string;
const line = (o: object) => JSON.stringify(o) + '\n';
const prompt = (text: string, at = '2026-09-01T10:00:00Z') => line({ type: 'user', timestamp: at, message: { content: text } });
const reply = (text: string) =>
  line({ type: 'assistant', timestamp: '2026-09-01T10:01:00Z', message: { content: [{ type: 'text', text }] } });

const session = (branch: string, extra: Partial<WorktreeSession> = {}): WorktreeSession =>
  ({
    target: 'api',
    branch,
    isGroup: false,
    paths: [path.join(tmp, 'wt', branch.replace('/', '-'))],
    createdAt: '',
    lastAccessedAt: '',
    ...extra,
  }) as WorktreeSession;

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

  it("the copy carries the conversation's last write time, not the copy's", async () => {
    const s = session('fix/time');
    const src = path.join(tmp, 'c.jsonl');
    fs.writeFileSync(src, prompt('one'));
    const then = new Date(Date.UTC(2026, 5, 1));
    fs.utimesSync(src, then, then);
    await syncConversation(s, root, [source(src)]);
    const copy = path.join(conversationDirFor(sessionIdFor(s), root), 'c.jsonl');
    expect(fs.statSync(copy).mtimeMs).toBe(then.getTime());
    // A complete copy whose time is off gets its time fixed, nothing recopied.
    fs.utimesSync(copy, new Date(), new Date());
    expect(await syncConversation(s, root, [source(src)])).toEqual({ files: 0, bytes: 0 });
    expect(fs.statSync(copy).mtimeMs).toBe(then.getTime());
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
        line({
          type: 'assistant',
          message: {
            content: [
              { type: 'text', text: 'The new encryption key identifier is stored per terminal.' },
              { type: 'tool_use', name: 'Bash', input: { command: 'encryption keys' } },
            ],
          },
        }) +
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
    fs.writeFileSync(
      rec,
      JSON.stringify({ ...json, summary: { ...json.summary, written: 'Rotated the encryption keys for every terminal.' } }),
    );
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

describe('compressQuietCopies', () => {
  const DAY = 24 * 3600_000;

  it('gzips a copy quiet for two days, keeping its time; search still finds it; a recent one stays plain', async () => {
    const old = session('fix/old');
    const src = await kept(old, prompt('the quokka migration') + reply('Done.'));
    const quietSince = Date.now() - 3 * DAY;
    fs.utimesSync(src, new Date(), new Date(quietSince));
    const plain = path.join(conversationDirFor(sessionIdFor(old), root), path.basename(src));
    fs.utimesSync(plain, new Date(), new Date(quietSince));
    const fresh = session('fix/fresh');
    await kept(fresh, prompt('something new'));

    const r = await compressQuietCopies(root);
    expect(r.files).toBe(1);
    expect(fs.existsSync(plain)).toBe(false);
    expect(Math.abs(fs.statSync(`${plain}.gz`).mtimeMs - quietSince)).toBeLessThan(1000);
    expect(fs.readdirSync(conversationDirFor(sessionIdFor(fresh), root))).toEqual([expect.stringMatching(/\.jsonl$/)]);
    const hits = await searchConversations('quokka', { sessions: [old, fresh], root, archive });
    expect(hits.map((h) => h.branch)).toEqual(['fix/old']);
    expect(await compressQuietCopies(root)).toEqual({ files: 0, bytesSaved: 0 });
  });

  it('a packed copy stays packed while its conversation is quiet, and is unpacked and caught up when it goes on', async () => {
    const s = session('fix/resumed');
    const src = await kept(s, prompt('one'));
    const dir = conversationDirFor(sessionIdFor(s), root);
    const plain = path.join(dir, path.basename(src));
    const then = new Date(Date.now() - PACK_QUIET_MS - 60_000);
    fs.utimesSync(src, new Date(), then);
    fs.utimesSync(plain, new Date(), then);
    await compressQuietCopies(root);
    expect(await syncConversation(s, root, [source(src)])).toEqual({ files: 0, bytes: 0 });
    expect(fs.existsSync(`${plain}.gz`)).toBe(true);

    const added = prompt('two');
    fs.appendFileSync(src, added);
    expect(await syncConversation(s, root, [source(src)])).toEqual({ files: 1, bytes: Buffer.byteLength(added) });
    expect(fs.existsSync(`${plain}.gz`)).toBe(false);
    expect(fs.readFileSync(plain, 'utf8')).toBe(fs.readFileSync(src, 'utf8'));
  });
});
