import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorktreeSession } from '../../src/core/history.js';
import { encodeProjectDir } from '../../src/core/claude-activity.js';
import { archiveSession, readArchive, readArchivedTranscript, restoreArchivedTranscripts, writeArchiveSummary, type ArchiveDeps } from '../../src/core/session-archive.js';
import zlib from 'node:zlib';
import { sessionIdFor } from '../../src/core/session-id.js';

let tmp: string;
let root: string;
let projects: string;
let wt: string;
let session: WorktreeSession;
let transcript: string;

const line = (o: object) => JSON.stringify(o) + '\n';

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-'));
  root = path.join(tmp, 'archive');
  projects = path.join(tmp, 'projects');
  wt = path.join(tmp, 'wt', 'fix-keys');
  fs.mkdirSync(wt, { recursive: true });
  session = { target: 'api', branch: 'fix/keys', isGroup: false, paths: [wt], createdAt: '2026-09-01T00:00:00Z', lastAccessedAt: '2026-09-01T00:00:00Z', jiraKey: 'PAY-12' } as WorktreeSession;
  const pdir = path.join(projects, encodeProjectDir(wt));
  fs.mkdirSync(pdir, { recursive: true });
  transcript = path.join(pdir, 'conv-1.jsonl');
  fs.writeFileSync(transcript,
    line({ type: 'user', uuid: 'u1', timestamp: '2026-09-01T10:00:00Z', message: { role: 'user', content: 'Rotate the encryption keys' } }) +
    line({ type: 'assistant', timestamp: '2026-09-01T10:00:05Z', message: { role: 'assistant', content: [{ type: 'text', text: 'On it.' }] } }) +
    line({ type: 'user', uuid: 'u2', timestamp: '2026-09-01T11:00:00Z', message: { role: 'user', content: 'Now add a test' } }));
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

const deps = (over: Partial<ArchiveDeps> = {}): ArchiveDeps & { calls: string[] } => {
  const calls: string[] = [];
  return {
    calls,
    stopClaude: async (id) => { calls.push(`stop ${id}`); },
    removable: async () => ({ ok: true, reason: 'merged' }),
    removeWorktree: async () => { calls.push('remove'); fs.rmSync(wt, { recursive: true, force: true }); return true; },
    setArchived: async () => { calls.push('archived'); return true; },
    transcripts: () => [transcript],
    prs: () => [{ repo: 'api', number: 7, url: 'https://x/7', state: 'MERGED' }],
    lastSummary: () => 'Keys rotated; tests pass.',
    archiveRoot: root,
    now: () => Date.parse('2026-09-30T12:00:00Z'),
    ...over,
  };
};

describe('archiveSession', () => {
  it('keeps the conversation and a summary, removes a worktree that would lose nothing, marks it archived', async () => {
    const d = deps();
    const out = await archiveSession(session, d);
    expect(out).toMatchObject({ ok: true, worktreeRemoved: true, transcripts: 1 });
    expect(d.calls).toEqual([`stop ${sessionIdFor(session)}`, 'remove', 'archived']);
    expect(fs.existsSync(wt)).toBe(false);

    const rec = readArchive(sessionIdFor(session), root)!;
    expect(rec.summary.prompts.map((p) => p.text)).toEqual(['Rotate the encryption keys', 'Now add a test']);
    expect(rec.summary).toMatchObject({ promptCount: 2, lastSummary: 'Keys rotated; tests pass.', jiraKey: 'PAY-12', prs: [{ number: 7, state: 'MERGED' }] });
    expect(fs.readFileSync(path.join(root, sessionIdFor(session), 'transcripts', 'conv-1.jsonl'), 'utf8')).toBe(fs.readFileSync(transcript, 'utf8'));
  });

  it('keeps a worktree that has work in it, and says why', async () => {
    const d = deps({ removable: async () => ({ ok: false, reason: '3 uncommitted files' }) });
    const out = await archiveSession(session, d);
    expect(out).toMatchObject({ ok: true, worktreeRemoved: false, keptBecause: '3 uncommitted files' });
    expect(d.calls).not.toContain('remove');
    expect(fs.existsSync(wt)).toBe(true);
    expect(readArchive(sessionIdFor(session), root)?.keptBecause).toBe('3 uncommitted files');
  });

  it('archives nothing when the conversation cannot be copied', async () => {
    const d = deps({ transcripts: () => [path.join(tmp, 'missing.jsonl')] });
    const out = await archiveSession(session, d);
    expect(out.ok).toBe(false);
    expect(d.calls).not.toContain('remove');
    expect(d.calls).not.toContain('archived');
    expect(fs.existsSync(wt)).toBe(true);
  });
});

describe('restoreArchivedTranscripts', () => {
  it('puts the conversation back where Claude looks for it, leaving files that are there', async () => {
    await archiveSession(session, deps());
    fs.rmSync(path.join(projects, encodeProjectDir(wt)), { recursive: true, force: true }); // Claude Code cleaned it up
    expect(restoreArchivedTranscripts(session, root, projects)).toBe(1);
    expect(fs.existsSync(transcript)).toBe(true);
    expect(restoreArchivedTranscripts(session, root, projects)).toBe(0); // already there
  });

  it('does nothing for a session that was never archived with a copy', () => {
    expect(restoreArchivedTranscripts({ ...session, branch: 'other' }, root, projects)).toBe(0);
    expect(vi.isMockFunction(restoreArchivedTranscripts)).toBe(false);
  });
});

describe('archiveSession: what it does around the copy', () => {
  it('refuses while something waits in the session, unless forced', async () => {
    const d = deps({ waiting: () => ['2 replies to post on review threads'] });
    const out = await archiveSession(session, d);
    expect(out).toMatchObject({ ok: false, blocked: ['2 replies to post on review threads'], message: 'Not archived: 2 replies to post on review threads.' });
    expect(d.calls).toEqual([]); // nothing stopped, nothing removed
    expect((await archiveSession(session, d, { force: true })).ok).toBe(true);
  });

  it('stops the dev server, records the branch tips, and tidies a removed worktree', async () => {
    const stopDev = vi.fn();
    const tidy = vi.fn(async () => ['api']);
    const clearBuildFolders = vi.fn(async () => ({ folders: 1, bytes: 10 }));
    await archiveSession(session, deps({ stopDev, tips: async () => ({ api: 'abc123' }), tidy, clearBuildFolders }));
    expect(stopDev).toHaveBeenCalledWith(sessionIdFor(session));
    expect(tidy).toHaveBeenCalled();
    expect(clearBuildFolders).not.toHaveBeenCalled(); // the folder is gone anyway
    expect(readArchive(sessionIdFor(session), root)).toMatchObject({ tips: { api: 'abc123' }, branchesDeleted: ['api'] });
  });

  it('a kept worktree gets its build output cleared, not a repo’s own checkout', async () => {
    const clear = vi.fn(async () => ({ folders: 2, bytes: 3_000_000 }));
    const tidy = vi.fn(async () => []);
    await archiveSession(session, deps({ removable: async () => ({ ok: false, reason: '2 uncommitted files' }), clearBuildFolders: clear, tidy }));
    expect(clear).toHaveBeenCalledTimes(1);
    expect(tidy).not.toHaveBeenCalled();
    expect(readArchive(sessionIdFor(session), root)?.buildFolders).toEqual({ folders: 2, bytes: 3_000_000 });
    const clear2 = vi.fn(async () => ({ folders: 1, bytes: 1 }));
    await archiveSession(session, deps({ removable: async () => ({ ok: false, reason: "it is the repo's own checkout" }), clearBuildFolders: clear2 }));
    expect(clear2).not.toHaveBeenCalled();
  });

  it('writes the summary of what was done, once', async () => {
    const summarize = vi.fn(async () => 'Rotated the terminal encryption keys and added a test; PR #7 merged.');
    await archiveSession(session, deps());
    const id = sessionIdFor(session);
    expect(await writeArchiveSummary(id, summarize, root)).toBe('Rotated the terminal encryption keys and added a test; PR #7 merged.');
    expect(readArchive(id, root)?.summary.written).toContain('Rotated the terminal');
    await writeArchiveSummary(id, summarize, root);
    expect(summarize).toHaveBeenCalledTimes(1);
  });

  it('a compressed transcript still reads, and restores', async () => {
    await archiveSession(session, deps());
    const id = sessionIdFor(session);
    const plain = path.join(root, id, 'transcripts', 'conv-1.jsonl');
    const text = fs.readFileSync(plain, 'utf8');
    fs.writeFileSync(`${plain}.gz`, zlib.gzipSync(text));
    fs.rmSync(plain);
    expect(readArchivedTranscript(id, 'conv-1.jsonl', root)).toBe(text);
    fs.rmSync(transcript);
    expect(restoreArchivedTranscripts(session, root, projects)).toBe(1);
    expect(fs.readFileSync(transcript, 'utf8')).toBe(text);
  });
});
