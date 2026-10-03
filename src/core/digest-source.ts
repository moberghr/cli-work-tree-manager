import { loadHistory } from './history.js';
import { sessionStatusView } from './turn-activity.js';
import { sessionIdFor } from './session-id.js';
import { readStatus } from './session-status.js';
import { readSessionActivity } from './session-activity.js';
import { readJsonlSince } from './jsonl.js';
import { lineTimeOf } from './agents/index.js';
import { agentOf } from './agents/index.js';
import type { ConversationEntry } from './agents/types.js';
import { loadManifest } from './checkpoint.js';
import { scopeHashForPaths } from './scope-manager.js';
import { buildDigest, promptEntries } from './digest.js';
import { workSteps, type WorkStep } from './work-time.js';
import type { DiffStat, DigestResponse, SessionCi } from './api-types.js';

/**
 * Gathers the digest's inputs from disk (history, transcripts touched in
 * the window, checkpoint manifests, status rows) and builds it — for the
 * Today tab and `work digest` alike. Pure assembly lives in digest.ts.
 *
 * What only a running work web knows comes in through `deps`: the diff-stat
 * cache and the PR watch's state (the CLI asks work web for those, or goes
 * without). It never runs Claude, gh or git: a digest is a read.
 */

/** Default: the last 24 hours; never more than two weeks back. */
export function digestWindow(sinceMs: number | undefined, now = Date.now()): number {
  return Math.max(sinceMs !== undefined && Number.isFinite(sinceMs) ? sinceMs : now - 24 * 3_600_000, now - 14 * 24 * 3_600_000);
}

export interface DigestDeps {
  diffStatFor?: (sessionId: string) => DiffStat | null;
  ciFor?: (sessionId: string) => SessionCi | null | Promise<SessionCi | null>;
  now?: () => number;
}

export interface DigestSource {
  collect(sinceMs?: number): Promise<DigestResponse>;
}

/** Sessions read at once: each can mean reading up to 64 MB of transcript. */
const READ_CONCURRENCY = 3;

/** `fn` over `items`, at most `limit` at a time, results in order. */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      for (let i = next++; i < items.length; i = next++) out[i] = await fn(items[i]);
    }),
  );
  return out;
}

/**
 * A digest source that keeps what it already read of each transcript — its
 * prompts only (promptEntries) — by file identity (path, size, mtime):
 * changing the window re-reads only what changed since, and the cache holds
 * just the files of the last digest. The CLI makes one per run; work web
 * keeps one.
 */
export function createDigestSource(deps: DigestDeps = {}): DigestSource {
  const now = deps.now ?? Date.now;
  let cache = new Map<string, { sinceMs: number; win: PromptWindow; steps: WorkStep[] }>();
  return {
    async collect(asked) {
      const t0 = now();
      const sinceMs = digestWindow(asked, t0);
      const next = new Map<string, { sinceMs: number; win: PromptWindow; steps: WorkStep[] }>();
      const inputs = await mapLimit(
        loadHistory().filter((s) => !s.archivedAt || Date.parse(s.archivedAt) >= sinceMs),
        READ_CONCURRENCY,
        async (s) => {
            const id = sessionIdFor(s);
            const status = readStatus(id);
            const attention = status ? sessionStatusView(status, s, readSessionActivity(s).lastActivity ?? 0) : null;
            const transcripts: ConversationEntry[][] = [];
            const work: WorkStep[][] = [];
            let partial = false;
            // Its conversations, as its agent keeps them (none when work can't read them).
            const conv = agentOf(s).conversation;
            for (const t of conv?.files(s) ?? []) {
              if (t.mtimeMs < sinceMs) continue;
              const key = `${t.file}:${t.size}:${t.mtimeMs}`;
              const hit = cache.get(key);
              const reuse = !!hit && hit.sinceMs <= sinceMs;
              // The agent's work steps come from the whole read, before it is slimmed to prompts.
              const read = reuse ? null : await readJsonlSince(t.file, sinceMs, lineTimeOf(conv!));
              const all = read ? conv!.entries(read.lines) : [];
              const win = reuse ? hit.win : { entries: promptEntries(all), partial: read!.partial };
              const steps = reuse ? hit.steps : workSteps(all).steps;
              next.set(key, { sinceMs: reuse ? hit.sinceMs : sinceMs, win, steps });
              transcripts.push(win.entries);
              work.push(steps);
              if (win.partial) partial = true;
            }
            return {
              sessionId: id,
              target: s.target,
              branch: s.branch,
              isGroup: s.isGroup,
              lastAccessedAt: s.lastAccessedAt,
              archivedAt: s.archivedAt ?? null,
              status: attention ? { state: attention.state, summary: attention.summary, updatedAt: attention.updatedAt } : null,
              transcripts,
              transcriptsPartial: partial,
              work,
              checkpoints: loadManifest(scopeHashForPaths(s.paths)).entries,
              diffStat: deps.diffStatFor?.(id) ?? null,
              ci: (await deps.ciFor?.(id)) ?? null,
            };
        },
      );
      cache = next;
      return {
        since: new Date(sinceMs).toISOString(),
        generatedAt: new Date(t0).toISOString(),
        sessions: buildDigest(inputs, sinceMs),
      };
    },
  };
}

/** A read window reduced to the prompts the digest uses (whether the file's start was left unread). */
interface PromptWindow {
  entries: ConversationEntry[];
  partial: boolean;
}
