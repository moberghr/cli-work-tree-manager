/**
 * PURE — a session's timeline (the Timeline tab), shared with the demo; keep
 * it import-free. Everything it shows is already kept elsewhere: your
 * prompts (its transcripts), its turns (checkpoints, with the names already
 * written), its commits (git), its PRs (the PR watch), when it was made and
 * archived. This only puts them on one line, newest first.
 */

export type TimelineKind = 'created' | 'prompt' | 'turn' | 'commit' | 'pr-opened' | 'pr-merged' | 'pr-closed' | 'archived';

export interface TimelineEvent {
  at: string;
  kind: TimelineKind;
  text: string;
  /** The repo, for a commit or a PR in a group. */
  repo?: string;
  /** A commit's sha, a PR's url. */
  ref?: string;
  /** A turn's checkpoint id (to open its diff). */
  checkpoint?: number;
}

export interface TimelineInput {
  createdAt: string;
  archivedAt?: string | null;
  prompts: Array<{ ts: string; text: string }>;
  checkpoints: Array<{ id: number; ts: string; label?: string }>;
  commits: Array<{ repo: string; sha: string; at: string; subject: string }>;
  prs: Array<{
    repo: string;
    number: number;
    url: string;
    state: 'OPEN' | 'MERGED' | 'CLOSED';
    createdAt?: string;
    mergedAt?: string;
    closedAt?: string;
  }>;
}

/** A turn's name only a size ("3 files · +52 −8"): the fallback when no Claude named it, said as such. */
const SIZE_LABEL = /^(\d+ files? · \+\d+ −\d+|no changes)$/;

const MAX_TEXT = 200;
const clip = (t: string) => {
  const one = t.replace(/\s+/g, ' ').trim();
  return one.length > MAX_TEXT ? `${one.slice(0, MAX_TEXT - 1)}…` : one;
};

/** The events, newest first (at most `limit`). */
export function buildTimeline(input: TimelineInput, limit = 300): TimelineEvent[] {
  const out: TimelineEvent[] = [{ at: input.createdAt, kind: 'created', text: 'Session started' }];
  for (const p of input.prompts) out.push({ at: p.ts, kind: 'prompt', text: clip(p.text) });
  for (const c of input.checkpoints) {
    if (c.id === 0) continue; // the baseline, not a turn
    const label = c.label?.trim();
    out.push({
      at: c.ts,
      kind: 'turn',
      text: label && label !== 'Initial' ? (SIZE_LABEL.test(label) ? `A turn: ${label}` : label) : 'A turn',
      checkpoint: c.id,
    });
  }
  for (const c of input.commits) out.push({ at: c.at, kind: 'commit', text: clip(c.subject), repo: c.repo, ref: c.sha });
  for (const p of input.prs) {
    if (p.createdAt) out.push({ at: p.createdAt, kind: 'pr-opened', text: `Opened PR #${p.number}`, repo: p.repo, ref: p.url });
    if (p.state === 'MERGED' && p.mergedAt)
      out.push({ at: p.mergedAt, kind: 'pr-merged', text: `Merged PR #${p.number}`, repo: p.repo, ref: p.url });
    if (p.state === 'CLOSED' && p.closedAt)
      out.push({ at: p.closedAt, kind: 'pr-closed', text: `Closed PR #${p.number} without merging`, repo: p.repo, ref: p.url });
  }
  if (input.archivedAt) out.push({ at: input.archivedAt, kind: 'archived', text: 'Archived' });
  return out
    .filter((e) => Number.isFinite(Date.parse(e.at)))
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at) || order(a.kind) - order(b.kind))
    .slice(0, limit);
}

/** At the same moment: the result before what led to it (newest first). */
function order(k: TimelineKind): number {
  return ['archived', 'pr-merged', 'pr-closed', 'pr-opened', 'commit', 'turn', 'prompt', 'created'].indexOf(k);
}
