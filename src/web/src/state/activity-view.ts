import type { ActivityRun, ActivityWire } from '../../../core/api-types.js';

/**
 * What of the background activity needs you, in a line, for the top bar's
 * dot: a job resting (GitHub's limit), or one that worked before and now
 * failed. A job that has never worked here (Jira without acli) is not set
 * up, not broken, and keeps the dot quiet. Null: all fine. Pure.
 */
export function activityAttention(data: ActivityWire | null, now: number): string | null {
  if (!data) return null;
  const resting = data.schedules.find((s) => s.pausedUntil && Date.parse(s.pausedUntil) > now);
  if (resting) return `${resting.label} is resting${resting.pausedWhy ? `: ${resting.pausedWhy}` : ''}`;
  const seen = new Set<string>();
  for (const run of data.recent) {
    // Newest first: the first finished run of each kind is how it stands now.
    if (seen.has(run.kind) || run.status === 'skipped') continue;
    seen.add(run.kind);
    const workedBefore = data.recent.some((r) => r.kind === run.kind && r.status === 'done');
    if (run.status === 'failed' && workedBefore) return `${run.label} failed${run.summary ? `: ${run.summary}` : ''}`;
  }
  return null;
}

/** What the dot's tooltip says when nothing needs you. */
export function activityQuietLine(data: ActivityWire | null): string {
  const first = data?.running[0];
  if (!first) return 'Background jobs: all quiet';
  const progress = first.progress && first.progress.total > 0 ? ` ${first.progress.done}/${first.progress.total}` : '';
  const more = (data?.running.length ?? 0) > 1 ? ` (+${data!.running.length - 1} more)` : '';
  return `${first.label}${progress}${more}`;
}

const decided = (r: ActivityRun) => r.notes.some((n) => n.level !== 'info');

/**
 * Recent runs with the uneventful repeats folded: consecutive runs of the
 * same job that ended the same way and decided nothing (no action, no
 * warning) become one row, the newest, counting the others (`repeats`).
 * Pure.
 */
export function collapseRuns(runs: ActivityRun[]): ActivityRun[] {
  const out: ActivityRun[] = [];
  for (const run of runs) {
    const last = out[out.length - 1];
    if (last && last.kind === run.kind && last.status === run.status && !decided(last) && !decided(run)) {
      out[out.length - 1] = { ...last, repeats: (last.repeats ?? 0) + (run.repeats ?? 0) + 1 };
      continue;
    }
    out.push(run);
  }
  return out;
}
