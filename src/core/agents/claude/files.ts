import fs from 'node:fs';
import path from 'node:path';
import { claudeProjectsRoots, encodeProjectDir, projectTranscripts } from './activity.js';
import { sessionAccount } from './accounts.js';
import type { WorktreeSession } from '../../sessions/session-types.js';
import type { BackgroundWork, ConversationFile } from '../types.js';

/**
 * Where Claude Code keeps a session's conversations: its transcripts under
 * ~/.claude/projects/<encoded folder>/ — the Claude adapter's `files`. A
 * group's are in its root's folder (Claude runs in the group root).
 */

/**
 * Every Claude Code transcript of this session's conversations (group: its root): its own account's projects folder
 * first, then the other accounts' (a switch moves them, but one left behind is still its conversation), each file once.
 */
export function listTranscripts(session: WorktreeSession): ConversationFile[] {
  const dirs = session.isGroup ? [...new Set(session.paths.map((p) => path.dirname(p)))] : session.paths;
  const roots = claudeProjectsRoots(sessionAccount(session));
  const seen = new Set<string>();
  const out: ConversationFile[] = [];
  for (const d of dirs)
    for (const root of roots)
      for (const f of projectTranscripts(path.join(root, encodeProjectDir(d)))) {
        if (seen.has(f.file)) continue;
        seen.add(f.file);
        out.push(f);
      }
  return out;
}

/**
 * Its transcripts and their subagents' (`<conversation>/subagents/agent-*.jsonl`, beside `<conversation>.jsonl`):
 * a subagent's tokens are spent on the plan too, though its lines aren't in the conversation's file.
 */
export function listUsageFiles(session: WorktreeSession): ConversationFile[] {
  const out: ConversationFile[] = [];
  for (const t of listTranscripts(session)) {
    out.push(t);
    const dir = path.join(t.file.replace(/\.jsonl$/, ''), 'subagents');
    let names: string[];
    try {
      names = fs.readdirSync(dir);
    } catch {
      continue; // no subagents in this one
    }
    for (const name of names) {
      if (!name.startsWith('agent-') || !name.endsWith('.jsonl')) continue;
      const file = path.join(dir, name);
      try {
        const st = fs.statSync(file);
        out.push({ file, mtimeMs: st.mtimeMs, size: st.size });
      } catch {
        /* gone meanwhile */
      }
    }
  }
  return out;
}

/** The newest transcript Claude wrote for this session. */
export function latestTranscript(session: WorktreeSession): ConversationFile | null {
  let best: ConversationFile | null = null;
  for (const t of listTranscripts(session)) if (!best || t.mtimeMs > best.mtimeMs) best = t;
  return best;
}

/** Only the conversations written around the turn that ended are looked in (the rest are other days' work). */
const AROUND_TURN_MS = 60_000;
/**
 * A background agent quiet this long is taken as done (hung, killed). Long, since quiet isn't done: one waiting on a
 * test run or its own review lanes writes nothing for many minutes (15 read a running review as Idle), and the
 * question is only asked while Claude Code itself still says busy (withLiveClaude), which ends with a killed one.
 */
const AGENT_QUIET_MS = 60 * 60_000;
/** It is asked on every sessions list while it applies: an answer is reused this long. */
const ANSWER_FOR_MS = 2_000;
const answers = new Map<string, { at: number; work: BackgroundWork | null }>();

/**
 * A background agent of this session's conversation is still at it after `sinceMs` (a turn's end) — it wrote since,
 * or that turn started it (lookForBackgroundWork) — and what it is (its own description; `what` null when it gives
 * none); null when there is none: that turn handed its work to it. Claude Code keeps each subagent's transcript in `<conversation>/subagents/agent-*.jsonl`
 * with a `.meta.json` beside it saying how it was asked for — `requestShape: "background"` runs on after the turn
 * that started it ends, and its end comes back as a new turn (a `<task-notification>`).
 */
export function backgroundWorkSince(session: WorktreeSession, sinceMs: number, now = Date.now()): BackgroundWork | null {
  const key = `${session.paths.join('|')}|${sinceMs}`;
  const kept = answers.get(key);
  if (kept && now - kept.at >= 0 && now - kept.at < ANSWER_FOR_MS) return kept.work;
  const work = lookForBackgroundWork(session, sinceMs, Math.max(sinceMs, now - AGENT_QUIET_MS), now - AGENT_QUIET_MS);
  if (answers.size > 200) answers.clear();
  answers.set(key, { at: now, work });
  return work;
}

/** An agent's own words for itself (its meta's `description`), on one line; null when it gives none. */
function whatOf(meta: object): string | null {
  const d = (meta as { description?: unknown }).description;
  return typeof d === 'string' && d.trim() ? d.trim().replace(/\s+/g, ' ') : null;
}

/**
 * A background subagent of a conversation written around `sinceMs` (the turn's end), still at it: written within the
 * quiet limit (after `afterMs` when it wrote since the turn ended), or — not written since — started for that turn
 * (its meta written in the minute before the turn ended: the turn started it, then ended; reported: a review just
 * started read Idle until its first write), and written within the quiet limit (`quietFrom`).
 */
function lookForBackgroundWork(session: WorktreeSession, sinceMs: number, afterMs: number, quietFrom = afterMs): BackgroundWork | null {
  for (const t of listTranscripts(session)) {
    if (t.mtimeMs < sinceMs - AROUND_TURN_MS) continue;
    const dir = path.join(t.file.replace(/\.jsonl$/, ''), 'subagents');
    let names: string[];
    try {
      names = fs.readdirSync(dir);
    } catch {
      continue; // no subagents in this one
    }
    for (const name of names) {
      if (!name.endsWith('.jsonl')) continue;
      const file = path.join(dir, name);
      try {
        const written = fs.statSync(file).mtimeMs;
        if (written <= quietFrom) continue;
        const metaFile = file.replace(/\.jsonl$/, '.meta.json');
        const startedForTurn = fs.statSync(metaFile).mtimeMs >= sinceMs - AROUND_TURN_MS;
        if (written <= afterMs && !startedForTurn) continue;
        const meta: unknown = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
        if (meta && typeof meta === 'object' && (meta as { requestShape?: unknown }).requestShape === 'background')
          return { what: whatOf(meta) };
      } catch {
        /* gone meanwhile, or no meta beside it: not one we can tell is in the background */
      }
    }
  }
  return null;
}
