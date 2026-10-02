import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { getConfigDir, loadConfig } from './config.js';
import { agentFor } from './agents/index.js';
import { sessionIdFor } from './session-id.js';
import { archiveRoot, readArchive, readArchivedTranscript } from './session-archive.js';
import { matchingLines, queryWords, snippet } from './archive-search.js';
import type { WorktreeSession } from './session-types.js';
import type { ConversationHit } from './api-types.js';

/**
 * work's own copy of every session's Claude conversations, at
 * ~/.work/conversations/<session id>/<transcript>.jsonl. Claude Code
 * deletes its transcripts after a while (`cleanupPeriodDays`, 30 days by
 * default); this copy stays as long as the session, so a session's whole
 * history can be searched (`searchConversations`, GET
 * /api/conversations/search, `work search`). Disk is cheap here; nothing of
 * it is held in memory.
 *
 * Synced incrementally: a transcript only ever grows, so only its new bytes
 * are appended (a source that got smaller was replaced: copied whole). Run
 * after each Claude turn (the status hook) and by a sweep at start and every
 * 30 minutes. Removing the session removes it (sessionStatePaths).
 */

export const conversationRoot = (): string => path.join(getConfigDir(), 'conversations');
export const conversationDirFor = (id: string, root = conversationRoot()): string => path.join(root, id);

export interface SyncResult {
  files: number;
  bytes: number;
}

/** Bring a session's copy up to date with its transcripts. */
export async function syncConversation(s: WorktreeSession, root = conversationRoot(), sources = agentFor(loadConfig(), s).conversation?.files(s) ?? []): Promise<SyncResult> {
  const dir = conversationDirFor(sessionIdFor(s), root);
  const out: SyncResult = { files: 0, bytes: 0 };
  for (const src of sources) {
    const dest = path.join(dir, path.basename(src.file));
    let have = 0;
    let haveMtime = 0;
    try {
      const st = await fs.promises.stat(dest);
      [have, haveMtime] = [st.size, st.mtimeMs];
    } catch {
      /* not copied yet */
    }
    if (have === src.size) {
      // Complete; only its time may be off (a copy from before times were kept).
      if (Math.abs(haveMtime - src.mtimeMs) > 1000) await fs.promises.utimes(dest, new Date(), new Date(src.mtimeMs)).catch(() => undefined);
      continue;
    }
    await fs.promises.mkdir(dir, { recursive: true });
    if (have > src.size) {
      // Smaller than our copy: the file was replaced. Copy it whole.
      await fs.promises.copyFile(src.file, dest);
      out.bytes += src.size;
    } else {
      out.bytes += await appendRange(src.file, dest, have, src.size);
    }
    // The copy's time is the conversation's last write, not when we copied
    // it: search orders by it, and shows it.
    await fs.promises.utimes(dest, new Date(), new Date(src.mtimeMs)).catch(() => undefined);
    out.files++;
  }
  return out;
}

/**
 * Copy bytes [from, to) of `src` to the same offsets of `dest`; returns how
 * many. Written at the source's offsets, not appended: two syncs of one
 * session at once (a turn's and the sweep's, or `work search` beside work
 * web) write the same bytes to the same place instead of doubling lines.
 */
async function appendRange(src: string, dest: string, from: number, to: number): Promise<number> {
  await (await fs.promises.open(dest, 'a')).close(); // create it if new
  const [inp, out] = [await fs.promises.open(src, 'r'), await fs.promises.open(dest, 'r+')];
  try {
    const chunk = 4 * 1024 * 1024;
    let done = 0;
    for (let pos = from; pos < to; pos += chunk) {
      const buf = Buffer.alloc(Math.min(chunk, to - pos));
      const { bytesRead } = await inp.read(buf, 0, buf.length, pos);
      if (bytesRead === 0) break;
      await out.write(buf, 0, bytesRead, pos);
      done += bytesRead;
    }
    return done;
  } finally {
    await inp.close();
    await out.close();
  }
}

/** Sync many sessions, a few at a time. */
export async function syncConversations(sessions: WorktreeSession[], root = conversationRoot(), concurrency = 3): Promise<SyncResult & { sessions: number }> {
  const total = { files: 0, bytes: 0, sessions: 0 };
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, sessions.length) }, async () => {
      for (let i = next++; i < sessions.length; i = next++) {
        const r = await syncConversation(sessions[i], root).catch(() => ({ files: 0, bytes: 0 }));
        total.files += r.files;
        total.bytes += r.bytes;
        if (r.files) total.sessions++;
      }
    }),
  );
  return total;
}

const MAX_SESSIONS = 20;
const SNIPPETS_PER_SESSION = 3;

/** A session's transcript texts from its copy (plain or gzipped), newest first. */
function storedTranscripts(dir: string): Array<{ mtimeMs: number; read: () => string | null }> {
  let names: string[];
  try {
    names = fs.readdirSync(dir).filter((n) => n.endsWith('.jsonl') || n.endsWith('.jsonl.gz'));
  } catch {
    return [];
  }
  return names
    .map((n) => {
      const file = path.join(dir, n);
      let mtimeMs = 0;
      try {
        mtimeMs = fs.statSync(file).mtimeMs;
      } catch {
        /* vanished */
      }
      const read = () => {
        try {
          const buf = fs.readFileSync(file);
          return (n.endsWith('.gz') ? zlib.gunzipSync(buf) : buf).toString('utf8');
        } catch {
          return null;
        }
      };
      return { mtimeMs, read };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
}

/**
 * "What did we do about X?" across every session's kept conversation — live
 * and archived (an archive made before this store existed is read from its
 * archive copy). Every word must appear in one message (yours or Claude's)
 * or in an archive's written summary. Most recently active sessions first,
 * up to 20.
 */
export async function searchConversations(
  query: string,
  opts: { sessions: WorktreeSession[]; root?: string; archive?: string },
): Promise<ConversationHit[]> {
  const { words, jsonWords } = queryWords(query);
  if (words.length === 0) return [];
  const root = opts.root ?? conversationRoot();
  const archive = opts.archive ?? archiveRoot();
  const candidates = opts.sessions.map((s) => {
    const id = sessionIdFor(s);
    const stored = storedTranscripts(conversationDirFor(id, root));
    const rec = readArchive(id, archive);
    const lastMs = Math.max(0, ...stored.map((t) => t.mtimeMs), rec ? Date.parse(rec.archivedAt) || 0 : 0);
    // Its lines read as its agent writes them; none when work can't read that agent's conversations.
    const entries = agentFor(loadConfig(), s).conversation?.entries ?? (() => []);
    return { s, id, stored, rec, lastMs, entries };
  });
  candidates.sort((a, b) => b.lastMs - a.lastMs);
  const hits: ConversationHit[] = [];
  for (const c of candidates) {
    if (hits.length >= MAX_SESSIONS) break;
    const snippets: ConversationHit['snippets'] = [];
    const written = c.rec?.summary.written;
    if (written && words.every((w) => written.toLowerCase().includes(w))) {
      snippets.push({ role: 'summary', text: snippet(written, words), at: c.rec!.archivedAt });
    }
    // An archived session reads its archive (complete as of archiving; from
    // before this store existed too), a live one its own copy. Each falls
    // back to the other when it has nothing readable (archive transcripts
    // dropped by config, no sync yet).
    const fromArchive = (c.rec?.transcripts ?? []).map((t) => () => readArchivedTranscript(c.id, t.file, archive));
    const fromStore = c.stored.map((t) => t.read);
    const [first, second] = c.s.archivedAt ? [fromArchive, fromStore] : [fromStore, fromArchive];
    for (const texts of [first, second]) {
      let readAny = false;
      for (const read of texts) {
        if (snippets.length >= SNIPPETS_PER_SESSION) break;
        const raw = read();
        if (raw === null) continue;
        readAny = true;
        await new Promise((r) => setImmediate(r)); // a big history doesn't hold up the server
        snippets.push(...matchingLines(raw, words, jsonWords, SNIPPETS_PER_SESSION - snippets.length, c.entries));
      }
      if (readAny) break;
    }
    if (!snippets.length) continue;
    hits.push({
      sessionId: c.id,
      target: c.s.target,
      branch: c.s.branch,
      archived: !!c.s.archivedAt,
      archivedAt: c.s.archivedAt ?? null,
      worktreeRemoved: !!c.rec?.worktreeRemoved && !!c.s.archivedAt,
      lastAt: c.lastMs ? new Date(c.lastMs).toISOString() : null,
      snippets,
    });
  }
  return hits;
}
