import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { archiveDirFor, archiveRoot, readArchive, writeArchiveRecord } from './session-archive.js';

/**
 * Archived conversations, kept small. A transcript is plain JSON lines and
 * compresses to about a tenth, so archives older than `compressAfterDays`
 * (config `archive.compressAfterDays`, default 30; 0 = never) are gzipped:
 * nothing is lost — search and Restore read them (readArchivedTranscript).
 * Deleting them is opt-in (`archive.dropTranscriptsAfterDays`, default 0 =
 * never): the summary and prompts stay, and a Restore then starts a fresh
 * conversation.
 */

export const DEFAULT_COMPRESS_AFTER_DAYS = 30;
const DAY_MS = 24 * 3600_000;

export interface RetentionResult {
  compressed: string[];
  dropped: string[];
  bytesSaved: number;
}

export function applyArchiveRetention(opts: {
  compressAfterDays?: number;
  dropAfterDays?: number;
  now?: number;
  root?: string;
}): RetentionResult {
  const root = opts.root ?? archiveRoot();
  const now = opts.now ?? Date.now();
  const compressAfter = opts.compressAfterDays ?? DEFAULT_COMPRESS_AFTER_DAYS;
  const dropAfter = opts.dropAfterDays ?? 0;
  const out: RetentionResult = { compressed: [], dropped: [], bytesSaved: 0 };
  let ids: string[];
  try {
    ids = fs
      .readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return out;
  }
  for (const id of ids) {
    const rec = readArchive(id, root);
    if (!rec || rec.transcriptsDroppedAt) continue;
    const age = now - Date.parse(rec.archivedAt);
    if (!Number.isFinite(age)) continue;
    const dir = path.join(archiveDirFor(id, root), 'transcripts');
    if (dropAfter > 0 && age >= dropAfter * DAY_MS) {
      out.bytesSaved += dirBytes(dir);
      fs.rmSync(dir, { recursive: true, force: true });
      rec.transcriptsDroppedAt = new Date(now).toISOString();
      writeArchiveRecord(rec, root);
      out.dropped.push(id);
      continue;
    }
    if (compressAfter <= 0 || rec.compressedAt || age < compressAfter * DAY_MS) continue;
    for (const t of rec.transcripts) {
      const plain = path.join(dir, t.file);
      if (!fs.existsSync(plain)) continue;
      const data = fs.readFileSync(plain);
      const gz = zlib.gzipSync(data);
      // Written and checked before the original goes.
      fs.writeFileSync(`${plain}.gz`, gz);
      if (!zlib.gunzipSync(fs.readFileSync(`${plain}.gz`)).equals(data)) {
        fs.rmSync(`${plain}.gz`, { force: true });
        continue;
      }
      fs.rmSync(plain, { force: true });
      out.bytesSaved += data.length - gz.length;
    }
    rec.compressedAt = new Date(now).toISOString();
    writeArchiveRecord(rec, root);
    out.compressed.push(id);
  }
  return out;
}

function dirBytes(dir: string): number {
  let n = 0;
  try {
    for (const f of fs.readdirSync(dir)) n += fs.statSync(path.join(dir, f)).size;
  } catch {
    /* gone */
  }
  return n;
}
