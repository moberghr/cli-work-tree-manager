import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorktreeSession } from '../../../src/core/sessions/history.js';
import { sessionIdFor } from '../../../src/core/sessions/session-id.js';
import type { TranscriptFile } from '../../../src/core/conversations/context-usage.js';

/** The session's PR list can't be written once (state.db busy): the links copied meanwhile aren't lost. */

const fail = vi.hoisted(() => ({ next: 0 }));
vi.mock('../../../src/core/pr/session-prs.js', async (orig) => {
  const real = await orig<typeof import('../../../src/core/pr/session-prs.js')>();
  return {
    ...real,
    noteSessionPrs: (...a: Parameters<typeof real.noteSessionPrs>) => {
      if (fail.next > 0) {
        fail.next--;
        throw new Error('database is locked');
      }
      return real.noteSessionPrs(...a);
    },
  };
});

const { syncConversation } = await import('../../../src/core/conversations/conversation-store.js');
const { readSessionPrs } = await import('../../../src/core/pr/session-prs.js');

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'conv-prs-fail-'));
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

const line = (o: object) => JSON.stringify(o) + '\n';
const prLink = (n: number) =>
  line({
    type: 'pr-link',
    prNumber: n,
    prUrl: `https://github.com/kvika/api/pull/${n}`,
    prRepository: 'kvika/api',
    timestamp: '2026-11-03T10:00:00Z',
  });
const source = (file: string): TranscriptFile => {
  const st = fs.statSync(file);
  return { file, size: st.size, mtimeMs: st.mtimeMs };
};

describe('a PR list write that fails', () => {
  it('the next sync reads the whole copy again, so the link copied meanwhile still lands', async () => {
    const s = {
      target: 'api',
      branch: 'feat/prs-fail',
      isGroup: false,
      paths: [path.join(tmp, 'wt')],
      createdAt: '',
      lastAccessedAt: '',
    } as WorktreeSession;
    const root = path.join(tmp, 'conversations');
    const src = path.join(tmp, 'c.jsonl');
    fs.writeFileSync(src, line({ type: 'user', message: { content: 'x' } }));
    await syncConversation(s, root, [source(src)]); // scanned
    fs.appendFileSync(src, prLink(3653));
    fail.next = 1;
    expect((await syncConversation(s, root, [source(src)])).prs).toBeUndefined(); // copied, but not kept
    expect(readSessionPrs(sessionIdFor(s))?.prs ?? []).toEqual([]);
    fs.appendFileSync(src, line({ type: 'user', message: { content: 'y' } }));
    await syncConversation(s, root, [source(src)]);
    expect(readSessionPrs(sessionIdFor(s))?.prs.map((p) => p.number)).toEqual([3653]);
  });
});
