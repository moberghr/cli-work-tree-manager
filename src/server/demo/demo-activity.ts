import { createActivityLog, type ActivityLog } from '../../core/platform/activity.js';
import type { DemoScenario } from './scenario.js';

const SWEEP_EVERY_MS = 30_000;
const STEP_MS = 700;

/**
 * The demo's Activity panel: the same log the real server keeps, filled by
 * a pretend PR check every 30 s that walks the scenario's sessions and says
 * what the real one would (from the scenario's PRs), plus a little history.
 */
export function createDemoActivity(scenario: DemoScenario, emit: () => void): { log: ActivityLog; stop: () => void } {
  const log = createActivityLog({ onChange: emit });
  const prCheck = log.schedule('pr-watch', 'Pull request check', SWEEP_EVERY_MS);
  const idle = log.schedule('idle-sleep', 'Idle Claude check', 5 * 60_000);
  idle.next(Date.now() + 4 * 60_000);

  log.start('jira', 'Fetching your Jira issues').done(`${scenario.jira().length} issues`);
  log.start('pr-list', 'Listing open pull requests').done(`${scenario.prs().length} open PRs in 3 repos`);
  const sleep = log.start('idle-sleep', 'Looking for idle Claudes');
  sleep.done(`${scenario.list().length} Claudes running · none idle long enough`);

  let timers: NodeJS.Timeout[] = [];
  const later = (ms: number, fn: () => void) => {
    const t = setTimeout(fn, ms);
    t.unref?.();
    timers.push(t);
  };
  const sweep = () => {
    prCheck.next(Date.now() + SWEEP_EVERY_MS);
    const sessions = scenario.list().filter((s) => !s.archivedAt);
    const run = log.start('pr-watch', 'Checking pull requests');
    run.progress(0, sessions.length);
    let prs = 0;
    let threads = 0;
    let failing = 0;
    sessions.forEach((s, i) => {
      later((i + 1) * STEP_MS, () => {
        for (const r of scenario.ci(s.id)?.repos ?? []) {
          if (r.pr?.state !== 'OPEN') continue;
          prs++;
          threads += r.openThreads ?? 0;
          if (r.pr.checks === 'fail') {
            failing++;
            run.note(`${s.target} ${s.branch}: checks fail on #${r.pr.number} (${(r.pr.failing ?? []).map((f) => f.name).join(', ')}): already told its Claude`, { sessionId: s.id });
          }
          if (r.openThreads) run.note(`${s.target} ${s.branch}: ${r.openThreads} unresolved review threads on #${r.pr.number}`, { sessionId: s.id });
        }
        run.progress(i + 1, sessions.length);
        if (i === sessions.length - 1) {
          const parts = [`${sessions.length} sessions`, `${prs} open PRs`];
          if (threads) parts.push(`${threads} unresolved review threads`);
          if (failing) parts.push(`${failing} failing`);
          run.done(parts.join(' · '));
        }
      });
    });
    if (sessions.length === 0) run.done('0 sessions');
  };
  later(3000, sweep);
  prCheck.next(Date.now() + 3000);
  const every = setInterval(sweep, SWEEP_EVERY_MS);
  every.unref?.();
  return {
    log,
    stop: () => {
      clearInterval(every);
      for (const t of timers) clearTimeout(t);
      timers = [];
    },
  };
}
