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
