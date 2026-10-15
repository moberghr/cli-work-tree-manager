import fs from 'node:fs';
import path from 'node:path';
import { claudeProjectsRoot, encodeProjectDir, projectTranscripts } from './activity.js';
import type { WorktreeSession } from '../../sessions/session-types.js';
import type { ConversationFile } from '../types.js';

/**
 * Where Claude Code keeps a session's conversations: its transcripts under
 * ~/.claude/projects/<encoded folder>/ — the Claude adapter's `files`. A
 * group's are in its root's folder (Claude runs in the group root).
 */

/** Every Claude Code transcript of this session's conversations (group: its root). */
export function listTranscripts(session: WorktreeSession): ConversationFile[] {
  const dirs = session.isGroup ? [...new Set(session.paths.map((p) => path.dirname(p)))] : session.paths;
  const out: ConversationFile[] = [];
  for (const d of dirs) out.push(...projectTranscripts(path.join(claudeProjectsRoot(), encodeProjectDir(d))));
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
 * A background agent of this session's conversation wrote after `sinceMs` (a turn's end): that turn handed its work to
 * it, and it is still at it. Claude Code keeps each subagent's transcript in `<conversation>/subagents/agent-*.jsonl`
 * with a `.meta.json` beside it saying how it was asked for — `requestShape: "background"` runs on after the turn
 * that started it ends, and its end comes back as a new turn (a `<task-notification>`).
 */
export function backgroundWorkSince(session: WorktreeSession, sinceMs: number): boolean {
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
        if (fs.statSync(file).mtimeMs <= sinceMs) continue;
        const meta: unknown = JSON.parse(fs.readFileSync(file.replace(/\.jsonl$/, '.meta.json'), 'utf8'));
        if (meta && typeof meta === 'object' && (meta as { requestShape?: unknown }).requestShape === 'background') return true;
      } catch {
        /* gone meanwhile, or no meta beside it: not one we can tell is in the background */
      }
    }
  }
  return false;
}
