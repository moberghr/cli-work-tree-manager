import { readReadings } from '../../usage/usage-store.js';
import type { AgentUsageSource } from '../types.js';
import type { UnwrapOutcome } from './statusline.js';

// The installer (statusline.ts: the settings editor, its lock) loads only when work web or `work usage --restore` asks:
// every hook process imports the adapter, and none of them needs it.
type Installer = typeof import('./statusline.js');
let installer: Installer | undefined;
const loadInstaller = async (): Promise<Installer> => (installer ??= await import('./statusline.js'));

/** What `work usage --restore` says it did for Claude. */
export function restoreMessage(o: UnwrapOutcome): string {
  switch (o) {
    case 'restored':
      return 'Your own status line is back (work no longer reads the plan limits from it).';
    case 'not-ours':
      return "Its status line isn't work's: left as it is.";
    case 'kept':
      return "work's status line left in place: the copy of yours (~/.work/statusline.json) is missing or damaged. Set yours again with /statusline in Claude Code.";
    case 'failed':
      return "Its settings couldn't be changed (see above).";
  }
}

/** Plan limits from what the status-line hook recorded (usage-store.ts); set up by wrapping Claude's status line. */
export const claudeUsage: AgentUsageSource = {
  read: () => readReadings('claude'),
  async setup(o) {
    const outcome = await (await loadInstaller()).applyStatusLineSetting(o);
    if (outcome === 'wrapped') return 'status line wrapped: it records the plan limits';
    if (outcome === 'restored') return 'status line given back (usage.statusLine is false)';
    return 'status line left alone (lean server)';
  },
  async restore() {
    const outcome = await (await loadInstaller()).unwrapStatusLine();
    return { ok: outcome === 'restored' || outcome === 'not-ours', message: restoreMessage(outcome) };
  },
};
