import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applyArchiveRetention } from '../../src/core/archive-retention.js';
import { readArchive, readArchivedTranscript, type ArchiveRecord } from '../../src/core/session-archive.js';
import { clipToSentence, summaryPrompt, summarizeArchive } from '../../src/core/archive-summary.js';

let root: string;
const DAY = 24 * 3600_000;
const NOW = Date.parse('2026-10-01T12:00:00Z');

function archive(id: string, ageDays: number, text = 'rotate the encryption keys') {
  const dir = path.join(root, id);
  fs.mkdirSync(path.join(dir, 'transcripts'), { recursive: true });
  const line = JSON.stringify({ type: 'user', timestamp: '2026-09-01T10:00:00Z', message: { role: 'user', content: text } }) + '\n';
  fs.writeFileSync(path.join(dir, 'transcripts', 'c.jsonl'), line.repeat(200));
  const rec: ArchiveRecord = {
    sessionId: id, target: 'api', branch: `fix/${id}`, isGroup: false, paths: [], archivedAt: new Date(NOW - ageDays * DAY).toISOString(),
    worktreeRemoved: true, keptBecause: null, transcripts: [{ file: 'c.jsonl', projectDir: 'p' }],
    summary: { prompts: [{ ts: 't', text }], promptCount: 1, lastSummary: 'Done.', prs: [{ repo: 'api', number: 7, url: 'u', state: 'MERGED' }], jiraKey: 'PAY-1' },
  };
  fs.writeFileSync(path.join(dir, 'archive.json'), JSON.stringify(rec));
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'retention-'));
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe('applyArchiveRetention', () => {
  it('compresses archives older than 30 days, losslessly (still readable)', async () => {
    archive('old', 45);
    archive('new', 3);
    const before = readArchivedTranscript('old', 'c.jsonl', root);
    const r = applyArchiveRetention({ now: NOW, root });
    expect(r.compressed).toEqual(['old']);
    expect(r.bytesSaved).toBeGreaterThan(0);
    expect(fs.existsSync(path.join(root, 'old', 'transcripts', 'c.jsonl'))).toBe(false);
    expect(fs.existsSync(path.join(root, 'old', 'transcripts', 'c.jsonl.gz'))).toBe(true);
    expect(readArchivedTranscript('old', 'c.jsonl', root)).toBe(before);
    expect(readArchive('old', root)?.compressedAt).toBeTruthy();
    expect(fs.existsSync(path.join(root, 'new', 'transcripts', 'c.jsonl'))).toBe(true);
    expect(applyArchiveRetention({ now: NOW, root }).compressed).toEqual([]); // once
  });

  it('deletes conversations only when configured, keeping the summary', () => {
    archive('ancient', 400);
    expect(applyArchiveRetention({ now: NOW, root, dropAfterDays: 0 }).dropped).toEqual([]);
    const r = applyArchiveRetention({ now: NOW, root, dropAfterDays: 365 });
    expect(r.dropped).toEqual(['ancient']);
    expect(fs.existsSync(path.join(root, 'ancient', 'transcripts'))).toBe(false);
    expect(readArchive('ancient', root)).toMatchObject({ transcriptsDroppedAt: expect.any(String), summary: { lastSummary: 'Done.' } });
  });

  it('compressAfterDays: 0 turns compression off', () => {
    archive('old', 90);
    expect(applyArchiveRetention({ now: NOW, root, compressAfterDays: 0 }).compressed).toEqual([]);
  });
});

describe('archive summary', () => {
  it('asks for a few sentences from the prompts, the PRs and how it ended; one paragraph back', async () => {
    archive('x', 1, 'Rotate the terminal encryption keys');
    const rec = readArchive('x', root)!;
    const p = summaryPrompt(rec);
    expect(p).toContain('Branch: fix/x (api)');
    expect(p).toContain('Jira: PAY-1');
    expect(p).toContain('#7 (api, merged)');
    expect(p).toContain('- Rotate the terminal encryption keys');
    expect(p).toContain('How the last turn ended: Done.');
    expect(await summarizeArchive(rec, async () => '  Rotated the keys.\n\nPR merged.  ')).toBe('Rotated the keys. PR merged.');
    expect(await summarizeArchive(rec, async () => null)).toBeNull();
  });
});

describe('clipToSentence', () => {
  it('ends a long summary at a sentence, else at a word', () => {
    // A sentence ending before half the limit isn't worth the loss: cut at a word.
    expect(clipToSentence('First sentence here. ' + 'word '.repeat(30), 60)).toBe('First sentence here. word word word word word word word…');
    expect(clipToSentence('A. ' + 'b'.repeat(10) + ' ' + 'c'.repeat(80), 40)).toBe('A. bbbbbbbbbb…');
    expect(clipToSentence('short.', 40)).toBe('short.');
    const two = 'One full sentence that is long enough. Second one cut off here mid';
    expect(clipToSentence(two, 50)).toBe('One full sentence that is long enough.');
  });
});
