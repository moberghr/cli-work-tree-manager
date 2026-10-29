import { readReadings } from '../../usage/usage-store.js';
import { claudeAccounts } from './accounts.js';
import { accountOf } from './rate-limits.js';
import { savedPath } from './statusline-run.js';
import type { UsageAccount } from '../../usage/usage.js';
import type { AgentUsageSource } from '../types.js';
import type { UnwrapOutcome } from './statusline.js';

// The installer (statusline.ts: the settings editor, its lock) loads only when work web or `work usage --restore` asks:
// every hook process imports the adapter, and none of them needs it.
type Installer = typeof import('./statusline.js');
let installer: Installer | undefined;
const loadInstaller = async (): Promise<Installer> => (installer ??= await import('./statusline.js'));

/** What `work usage --restore` says it did for Claude (`saved`: where the copy of the user's line is, when it isn't ~/.work/statusline.json). */
export function restoreMessage(o: UnwrapOutcome, saved = '~/.work/statusline.json'): string {
  switch (o) {
    case 'restored':
      return 'Your own status line is back (work no longer reads the plan limits from it).';
    case 'not-ours':
      return "Its status line isn't work's: left as it is.";
    case 'kept':
      return `work's status line left in place: the copy of yours (${saved}) is missing or damaged. Set yours again with /statusline in Claude Code.`;
    case 'failed':
      return "Its settings couldn't be changed (see above).";
  }
}

/**
 * The readings, one per account the status-line hook saw. The hook names an account by its folder (`accountOf`:
 * `default` or `cfg-<hash>`, since it loads no config); here each is given the name it has in config `claudeAccounts`, and
 * the one new sessions use is marked. A folder that is no account (any more) keeps its hash.
 */
function namedReadings(): UsageAccount[] {
  const accounts = claudeAccounts();
  const byKey = new Map<string, { name: string; isDefault: boolean }>();
  for (const a of accounts) if (!byKey.has(accountOf(a.dir))) byKey.set(accountOf(a.dir), { name: a.name, isDefault: a.isDefault });
  return readReadings('claude').map((r) => {
    const known = byKey.get(r.account);
    return known ? { ...r, account: known.name, ...(known.isDefault ? { isDefault: true } : {}) } : r;
  });
}

/** Plan limits from what the status-line hook recorded (usage-store.ts); set up by wrapping the status line of every account's settings. */
export const claudeUsage: AgentUsageSource = {
  read: namedReadings,
  async setup(o) {
    const outcome = await (await loadInstaller()).applyStatusLineSetting(o);
    if (outcome === 'wrapped') return 'status line wrapped: it records the plan limits';
    if (outcome === 'restored') return 'status line given back (usage.statusLine is false)';
    return 'status line left alone (lean server)';
  },
  async restore() {
    const done = await (await loadInstaller()).unwrapAllStatusLines();
    const accounts = claudeAccounts();
    const ok = done.every((d) => d.outcome === 'restored' || d.outcome === 'not-ours');
    if (done.length === 1) return { ok, message: restoreMessage(done[0]!.outcome) };
    const message = done
      .map((d) => {
        const dir = accounts.find((a) => a.name === d.account)?.dir;
        return `${d.account}: ${restoreMessage(d.outcome, dir ? savedPath(dir) : undefined)}`;
      })
      .join('\n');
    return { ok, message };
  },
};
