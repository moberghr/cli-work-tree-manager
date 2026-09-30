import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorktreeSession } from '../../src/core/history.js';
import { encodeProjectDir } from '../../src/core/claude-activity.js';
import { archiveSession, readArchive, restoreArchivedTranscripts, type ArchiveDeps } from '../../src/core/session-archive.js';
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
