import fs from 'node:fs';
import { defaultRunner, type CommandRunner } from './ship.js';
import type { WorktreeSession } from './history.js';

/**
 * `+N −M` per session for the dashboard rows: tracked changes vs HEAD
 * (`git diff HEAD --numstat`) plus untracked files, summed over the
 * session's repos.
 *
 * Computing it runs git per repo, far too slow to do inline for every
 * session on every /api/sessions call (people have hundreds). So reads are
 * served from a cache and never block: a stale or missing entry schedules a
 * background refresh (bounded concurrency), and the caller is told when a
 * value actually changed so it can broadcast once.
 */

export interface DiffStat {
  added: number;
  deleted: number;
  files: number;
}

export function parseNumstat(out: string): { added: number; deleted: number; files: number } {
  let added = 0;
  let deleted = 0;
  let files = 0;
  for (const line of out.split('\n')) {
    const m = line.match(/^(\d+|-)\t(\d+|-)\t/);
    if (!m) continue;
    files++;
    // Binary files report "-\t-"; they count as a changed file, 0 lines.
    if (m[1] !== '-') added += Number(m[1]);
    if (m[2] !== '-') deleted += Number(m[2]);
  }
  return { added, deleted, files };
}

export async function computeDiffStat(
  paths: string[],
  run: CommandRunner = defaultRunner,
): Promise<DiffStat | null> {
  let total: DiffStat = { added: 0, deleted: 0, files: 0 };
  let any = false;
  for (const p of paths) {
    if (!fs.existsSync(p)) continue;
    const numstat = await run('git', ['diff', 'HEAD', '--numstat'], p);
    if (numstat.code !== 0) continue;
    any = true;
    const t = parseNumstat(numstat.stdout);
    const untracked = await run('git', ['ls-files', '--others', '--exclude-standard'], p);
    const newFiles = untracked.code === 0 ? untracked.stdout.split('\n').filter((l) => l.trim()).length : 0;
    total = { added: total.added + t.added, deleted: total.deleted + t.deleted, files: total.files + t.files + newFiles };
  }
  return any ? total : null;
}

interface Entry {
  stat: DiffStat | null;
  at: number;
  inFlight: boolean;
}

export interface DiffStatCacheOptions {
  ttlMs?: number;
  concurrency?: number;
  run?: CommandRunner;
  /** Called (debounced by the caller as it likes) when a value changed. */
  onChange?: () => void;
  now?: () => number;
}

export class DiffStatCache {
  private readonly entries = new Map<string, Entry>();
  private readonly queue: Array<{ id: string; paths: string[] }> = [];
  private running = 0;
  private readonly ttlMs: number;
  private readonly concurrency: number;
  private readonly run: CommandRunner;
  private readonly now: () => number;

  constructor(private readonly opts: DiffStatCacheOptions = {}) {
    this.ttlMs = opts.ttlMs ?? 20_000;
    this.concurrency = opts.concurrency ?? 4;
    this.run = opts.run ?? defaultRunner;
    this.now = opts.now ?? Date.now;
  }

  /** Last known value (possibly stale or null); schedules a refresh when
   *  it's missing or older than the TTL. Never blocks. */
  get(id: string, paths: string[]): DiffStat | null {
    const e = this.entries.get(id);
    if (!e || (!e.inFlight && this.now() - e.at > this.ttlMs)) this.schedule(id, paths);
    return e?.stat ?? null;
  }

  /** Force a refresh soon (a file changed in that worktree). */
  invalidate(id: string): void {
    const e = this.entries.get(id);
    if (e) e.at = 0;
  }

  /** Resolves when the queue is drained — for tests. */
  async idle(): Promise<void> {
    while (this.running > 0 || this.queue.length > 0) {
      await new Promise((r) => setTimeout(r, 5));
    }
  }

  private schedule(id: string, paths: string[]): void {
    const e = this.entries.get(id) ?? { stat: null, at: 0, inFlight: false };
    if (e.inFlight) return;
    e.inFlight = true;
    this.entries.set(id, e);
    this.queue.push({ id, paths });
    this.pump();
  }

  private pump(): void {
    while (this.running < this.concurrency && this.queue.length > 0) {
      const job = this.queue.shift()!;
      this.running++;
      computeDiffStat(job.paths, this.run)
        .catch(() => null)
        .then((stat) => {
          const e = this.entries.get(job.id)!;
          const changed = JSON.stringify(e.stat) !== JSON.stringify(stat);
          e.stat = stat;
          e.at = this.now();
          e.inFlight = false;
          if (changed) this.opts.onChange?.();
        })
        .finally(() => {
          this.running--;
          this.pump();
        });
    }
  }
}

/** Which sessions are worth computing for: not archived, touched in the
 *  last two weeks or reporting a status. Keeps hundreds of old worktrees
 *  from costing git calls on every refresh. */
export function wantsDiffStat(s: WorktreeSession, hasStatus: boolean, now = Date.now()): boolean {
  if (s.archivedAt) return false;
  if (hasStatus) return true;
  const last = Date.parse(s.lastAccessedAt) || 0;
  return now - last < 14 * 24 * 60 * 60_000;
}
