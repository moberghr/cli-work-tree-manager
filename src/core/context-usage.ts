import fs from 'node:fs';
import path from 'node:path';
import { claudeProjectsRoot, encodeProjectDir } from './claude-activity.js';
import { readTranscriptTail, type TranscriptEntry } from './transcript.js';
import type { ContextUsage } from './api-types.js';
import type { WorktreeSession } from './session-types.js';

export type { ContextUsage } from './api-types.js';

/**
 * How full a session's conversation is. Every assistant message in the
 * transcript carries the token usage of the request that produced it, so
 * the newest one says how big the context is now: its prompt (input +
 * cache reads + cache writes) plus its reply, which the next turn carries.
 * Near the window Claude Code compacts the conversation, and answers get
 * worse before that — the dashboard shows when to start fresh.
 */

/** Claude's standard window; the 1M-token variants are recognised by a
 *  `[1m]` model id or by usage that no 200k window could hold. */
export const DEFAULT_WINDOW = 200_000;
export const LARGE_WINDOW = 1_000_000;

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);

/** From transcript entries (oldest first): the newest main-thread usage. */
export function contextUsageFrom(entries: TranscriptEntry[]): ContextUsage | null {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    // Subagent (Task) turns run in their own context.
    if (e.type !== 'assistant' || e.isSidechain === true) continue;
    const u = e.message?.usage;
    if (!u || typeof u !== 'object') continue;
    const used =
      num(u.input_tokens) + num(u.cache_read_input_tokens) + num(u.cache_creation_input_tokens) + num(u.output_tokens);
    if (used === 0) continue;
    const model = typeof e.message?.model === 'string' ? e.message.model : undefined;
    const window = (model && /\[1m\]/i.test(model)) || used > DEFAULT_WINDOW ? LARGE_WINDOW : DEFAULT_WINDOW;
    return { used, window, ...(model ? { model } : {}) };
  }
  return null;
}

/** The newest transcript Claude wrote for this session (group: its root). */
export function latestTranscript(session: WorktreeSession): { file: string; mtimeMs: number; size: number } | null {
  const dirs = session.isGroup ? [...new Set(session.paths.map((p) => path.dirname(p)))] : session.paths;
  let best: { file: string; mtimeMs: number; size: number } | null = null;
  for (const d of dirs) {
    const projectDir = path.join(claudeProjectsRoot(), encodeProjectDir(d));
    let names: string[];
    try {
      names = fs.readdirSync(projectDir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!name.endsWith('.jsonl')) continue;
      try {
        const file = path.join(projectDir, name);
        const st = fs.statSync(file);
        if (!best || st.mtimeMs > best.mtimeMs) best = { file, mtimeMs: st.mtimeMs, size: st.size };
      } catch {
        /* vanished */
      }
    }
  }
  return best;
}

/** Only the tail is read — a usage line is always near the end. */
const USAGE_TAIL_BYTES = 64 * 1024;
const cache = new Map<string, { key: string; usage: ContextUsage | null }>();

/** The session's context usage now; re-reads a transcript only after it changed. */
export function readContextUsage(session: WorktreeSession): ContextUsage | null {
  const t = latestTranscript(session);
  if (!t) return null;
  const key = `${t.file}:${t.size}:${t.mtimeMs}`;
  const id = session.paths.join('|');
  const hit = cache.get(id);
  if (hit?.key === key) return hit.usage;
  const usage = contextUsageFrom(readTranscriptTail(t.file, USAGE_TAIL_BYTES));
  cache.set(id, { key, usage });
  return usage;
}
