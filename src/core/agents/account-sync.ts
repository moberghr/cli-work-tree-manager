/**
 * Work's per-account setup — the hooks and the status-line wrapper in each account's settings — follows the accounts.
 * work web does it at start; an account added while it runs (`work account add`) would otherwise get neither until the
 * next start, and its sessions would show no status, take no comments and read no usage. So work web looks at the set of
 * account folders now and then (cheap: the accounts come from config.json read again only when it changed) and runs the
 * setup again when it differs. Agent-neutral: the folders come from each adapter's `accounts` part.
 */

/** The set of folders as a key: order and duplicates don't matter. */
const keyOf = (folders: readonly string[]): string => [...new Set(folders)].sort().join('\n');

export interface AccountSync {
  /** Look now: runs `apply` when the folders differ from the last look (one at a time; a change during a run is seen by
   *  the next look). True when it ran. */
  check(): Promise<boolean>;
  stop(): void;
}

export function startAccountSync(deps: {
  /** Every agent's account folders now. */
  folders: () => string[];
  /** Install the hooks and the usage readings again (every account). */
  apply: () => Promise<void>;
  /** A run that failed: said, and tried again at the next change. */
  onError?: (err: unknown) => void;
  /** How often to look (ms); 0: never by itself (`check` only). */
  everyMs?: number;
}): AccountSync {
  let last = keyOf(deps.folders());
  let running = false;
  const check = async (): Promise<boolean> => {
    if (running) return false;
    let now: string;
    try {
      now = keyOf(deps.folders());
    } catch (err) {
      deps.onError?.(err);
      return false;
    }
    if (now === last) return false;
    running = true;
    // Taken as seen either way: a run that fails is said once, not every few seconds (the next change runs it again).
    last = now;
    try {
      await deps.apply();
      return true;
    } catch (err) {
      deps.onError?.(err);
      return false;
    } finally {
      running = false;
    }
  };
  const every = deps.everyMs ?? 10_000;
  const timer = every > 0 ? setInterval(() => void check(), every) : null;
  timer?.unref?.();
  return { check, stop: () => timer && clearInterval(timer) };
}
