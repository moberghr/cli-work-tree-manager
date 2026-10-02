import type { ConversationEntry } from './agents/types.js';
import { workedBetween, type WorkStep } from './work-time.js';
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

/** What `checkpoint-summary.ts` names a turn when Claude was unavailable:
 *  "3 files · +52 −8" or "no changes". A size, not what the turn did. */
export const HEURISTIC_LABEL_RE = /^(\d+ files? · \+\d+ −\d+|no changes)$/;

/** One line of at most MAX_PROMPT_CHARS. */
function clip(text: string): string {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length > MAX_PROMPT_CHARS ? line.slice(0, MAX_PROMPT_CHARS - 1).trimEnd() + '…' : line;
}

/**
 * Of a conversation's entries, only what the digest reads — your prompts.
 * A day's conversations hold tool output too (megabytes per session); the
 * digest kept all of it in memory for every session in the window, for the
 * sake of a few lines.
 */
export function promptEntries(entries: readonly ConversationEntry[]): ConversationEntry[] {
  return entries.filter((e) => e.role === 'you' && !e.sidechain && e.text !== '');
}

/** Your prompts after `sinceMs`, oldest first. The same entry seen twice
 *  (by its id, else time + text) counts once; typing "commit" three times
 *  is three prompts. */
export function promptsSince(transcripts: readonly (readonly ConversationEntry[])[], sinceMs: number): Array<{ ts: string; text: string }> {
  const out: Array<{ ts: string; text: string }> = [];
  const seen = new Set<string>();
  for (const entries of transcripts) {
    for (const e of entries) {
      const ts = Date.parse(e.at);
      if (!(ts >= sinceMs)) continue;
      if (e.role !== 'you' || e.sidechain || !e.text) continue;
      const line = clip(e.text);
      const key = e.id ? e.id : `${ts}|${line}`;
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
  transcripts: ConversationEntry[][];
  /** A transcript was too large to read back to the window's start. */
  transcriptsPartial?: boolean;
  /** Claude's work steps in those transcripts (work-time.ts). */
  work?: WorkStep[][];
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
    ...(() => {
      const ms = (s.work ?? []).reduce((n, steps) => n + workedBetween(steps, sinceMs), 0);
      return ms > 0 ? { workedMs: ms } : {};
    })(),
  };
}

/** Rows for every session that did something, most recent first. */
export function buildDigest(inputs: DigestInput[], sinceMs: number): DigestSession[] {
  return inputs
    .map((s) => digestSession(s, sinceMs))
    .filter((d): d is DigestSession => d !== null)
    .sort((a, b) => b.lastActivity.localeCompare(a.lastActivity));
}
