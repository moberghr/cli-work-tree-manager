import { contentBlocks, type TranscriptEntry } from './transcript-entry.js';
import type { DiffStat, DigestSession, SessionCi } from './api-types.js';

/**
 * "What did each session do today?" — for a standup, or for coming back
 * after a weekend. Built from what's already on disk: the prompts you gave
 * (the transcripts), the turns it finished (checkpoints, named when a name
 * was already made — the digest never runs Claude), where it stands now,
 * its diff and its PRs. The assembly is pure; web-server.ts feeds it.
 */

export const MAX_PROMPTS = 12;
const MAX_PROMPT_CHARS = 240;

/** Text Claude Code writes as a "user" entry that you didn't type: slash
 *  command echoes, the local-command caveat, subagent task notifications,
 *  the "[Request interrupted by user]" marker. */
const NOT_TYPED = /^\s*(<command-name>|<command-message>|<local-command-|<system-reminder>|<bash-|<task-notification>|\[Request interrupted|Caveat: )/;

/** What `checkpoint-summary.ts` names a turn when Claude was unavailable:
 *  "3 files · +52 −8" or "no changes". A size, not what the turn did. */
export const HEURISTIC_LABEL_RE = /^(\d+ files? · \+\d+ −\d+|no changes)$/;

function promptText(e: TranscriptEntry): string | null {
  if (e.type !== 'user' || e.isSidechain === true || e.isMeta === true) return null;
  const blocks = contentBlocks(e);
  // A tool result is Claude's own loop, not you.
  if (blocks.some((b) => b.type === 'tool_result')) return null;
  const text = blocks
    .filter((b) => b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('\n')
    .trim();
  if (!text || NOT_TYPED.test(text)) return null;
  return text;
}

/** One line of at most MAX_PROMPT_CHARS. */
function clip(text: string): string {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length > MAX_PROMPT_CHARS ? line.slice(0, MAX_PROMPT_CHARS - 1).trimEnd() + '…' : line;
}

/** Your prompts after `sinceMs`, oldest first. The same entry seen twice
 *  (by its uuid, else time + text) counts once; typing "commit" three times
 *  is three prompts. */
/**
 * Of a transcript's entries, only what the digest reads — your prompts —
 * reduced to their uuid, time and text. A day's transcripts hold tool
 * output too (megabytes per session); the digest kept all of it parsed in
 * memory for every session in the window, for the sake of a few lines.
 */
export function promptEntries(entries: TranscriptEntry[]): TranscriptEntry[] {
  const out: TranscriptEntry[] = [];
  for (const e of entries) {
    const text = promptText(e);
    if (!text) continue;
    out.push({
      type: 'user',
      ...(typeof e.uuid === 'string' ? { uuid: e.uuid } : {}),
      ...(typeof e.timestamp === 'string' ? { timestamp: e.timestamp } : {}),
      message: { role: 'user', content: text },
    } as TranscriptEntry);
  }
  return out;
}

export function promptsSince(transcripts: TranscriptEntry[][], sinceMs: number): Array<{ ts: string; text: string }> {
  const out: Array<{ ts: string; text: string }> = [];
  const seen = new Set<string>();
  for (const entries of transcripts) {
    for (const e of entries) {
      const ts = typeof e.timestamp === 'string' ? Date.parse(e.timestamp) : NaN;
      if (!(ts >= sinceMs)) continue;
      const text = promptText(e);
      if (!text) continue;
      const line = clip(text);
      const key = typeof e.uuid === 'string' && e.uuid ? e.uuid : `${ts}|${line}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ ts: new Date(ts).toISOString(), text: line });
    }
  }
  return out.sort((a, b) => a.ts.localeCompare(b.ts));
}

export interface DigestInput {
  sessionId: string;
  target: string;
  branch: string;
  isGroup: boolean;
  lastAccessedAt: string;
  archivedAt: string | null;
  status: { state: 'working' | 'needs_input' | 'idle'; summary?: string; updatedAt: string } | null;
  /** Entries of the transcripts written to since the window opened. */
  transcripts: TranscriptEntry[][];
  /** A transcript was too large to read back to the window's start. */
  transcriptsPartial?: boolean;
  /** The session scope's checkpoints (id 0 is the baseline, not a turn). */
  checkpoints: Array<{ id: number; ts: string; label?: string }>;
  diffStat: DiffStat | null;
  ci: SessionCi | null;
}

/** One digest row, or null when the session did nothing in the window. */
export function digestSession(s: DigestInput, sinceMs: number): DigestSession | null {
  const prompts = promptsSince(s.transcripts, sinceMs);
  const turns = s.checkpoints.filter((c) => c.id > 0 && Date.parse(c.ts) >= sinceMs);
  const archivedInWindow = !!s.archivedAt && Date.parse(s.archivedAt) >= sinceMs;
  const prs = (s.ci?.repos ?? [])
    .filter((r) => r.pr)
    .map((r) => ({
      repo: r.name,
      number: r.pr!.number,
      url: r.pr!.url,
      state: r.pr!.state,
      ...(r.pr!.mergedAt ? { mergedAt: r.pr!.mergedAt } : {}),
    }));
  const mergedInWindow = prs.some((p) => p.mergedAt && Date.parse(p.mergedAt) >= sinceMs);
  if (prompts.length === 0 && turns.length === 0 && !archivedInWindow && !mergedInWindow) return null;

  const times = [
    ...prompts.map((p) => Date.parse(p.ts)),
    ...turns.map((t) => Date.parse(t.ts)),
    ...prs.map((p) => (p.mergedAt && Date.parse(p.mergedAt) >= sinceMs ? Date.parse(p.mergedAt) : 0)),
    archivedInWindow ? Date.parse(s.archivedAt!) : 0,
    s.status ? Date.parse(s.status.updatedAt) || 0 : 0,
  ];
  return {
    sessionId: s.sessionId,
    target: s.target,
    branch: s.branch,
    isGroup: s.isGroup,
    state: s.status?.state ?? null,
    ...(s.status?.summary ? { summary: s.status.summary } : {}),
    prompts: prompts.slice(-MAX_PROMPTS),
    morePrompts: Math.max(0, prompts.length - MAX_PROMPTS),
    turns: turns.length,
    turnLabels: turns
      .map((t) => t.label?.trim())
      .filter((l): l is string => !!l && l !== 'Initial' && !HEURISTIC_LABEL_RE.test(l)),
    ...(s.transcriptsPartial ? { partial: true } : {}),
    diffStat: s.diffStat,
    prs,
    archivedAt: s.archivedAt,
    lastActivity: new Date(Math.max(...times)).toISOString(),
  };
}

/** Rows for every session that did something, most recent first. */
export function buildDigest(inputs: DigestInput[], sinceMs: number): DigestSession[] {
  return inputs
    .map((s) => digestSession(s, sinceMs))
    .filter((d): d is DigestSession => d !== null)
    .sort((a, b) => b.lastActivity.localeCompare(a.lastActivity));
}
