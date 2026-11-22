import os from 'node:os';
import spawn from '../../platform/spawn.js';
import { applyEnvDelta } from '../../platform/env-delta.js';
import { internalRunEnv } from '../../platform/internal-run.js';
import { debugLog } from '../../platform/logger.js';
import { recordReading } from '../../usage/usage-store.js';
import { accountEnv, isLoggedIn, setUpAccounts, type ClaudeAccount } from './accounts.js';
import { withoutParentSession } from './env.js';
import { accountOf, clampPercent, labelOf } from './rate-limits.js';
import type { UsageWindow } from '../../usage/usage.js';

/**
 * Asking Claude Code for its plan limits, as `/usage` shows them. Its status line (rate-limits.ts) carries only the
 * 5-hour and weekly windows; a model's own weekly window (Fable's: `/usage`'s "Current week (Fable)") is in no status
 * line and no rate-limit event. Claude Code tells it when asked, through a `get_usage` control request written to
 * `claude -p --input-format stream-json --output-format stream-json --verbose` with no prompt: no model is asked, it
 * costs nothing and answers in about a second, signed in as the account's sessions are (no token of ours).
 *
 * Measured on 2.1.330 (2026-11-21, Windows; the request as Novadeck found it on 2.1.323): the answer's
 * `rate_limits.model_scoped` lists each model's window by `display_name` with `utilization` (0–100) and an ISO
 * `resets_at`; `five_hour` and `seven_day` are there too, and `seven_day_opus` / `seven_day_sonnet` where the plan has
 * them (else null). It is undocumented: an answer that doesn't fit gives no reading, and the status line's stay.
 *
 * The run loads none of the user's settings, hooks, plugins or MCP servers (`--setting-sources ""`,
 * `--strict-mcp-config`), keeps no session (`--no-session-persistence`), starts in a neutral folder, and goes without
 * `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` (print mode would take them; the plan's limits are the login's).
 */

export const USAGE_ASK_ARGS = [
  '-p',
  '--input-format',
  'stream-json',
  '--output-format',
  'stream-json',
  '--verbose',
  '--setting-sources',
  '',
  '--no-session-persistence',
  '--strict-mcp-config',
];

const REQUEST_ID = 'work-usage';

/** The one line written to the run's input. */
export const USAGE_ASK_REQUEST = JSON.stringify({
  type: 'control_request',
  request_id: REQUEST_ID,
  request: { subtype: 'get_usage', skip_behaviors: true },
});

/** How often an account is asked at most: GET /api/usage asks, and it comes on every reading the status line writes. */
export const ASK_EVERY_MS = 5 * 60_000;

/** A run that hasn't answered by then is stopped. */
const ASK_TIMEOUT_MS = 20_000;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function resetIso(v: unknown): string | null {
  if (typeof v !== 'string' || v.trim() === '') return null;
  const ms = Date.parse(v);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/** `Fable` → `fable`, `Opus 4` → `opus_4`: a model window's id part. */
const slug = (name: string) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '');

/** The account-wide windows the status line also gives, and the per-model ones it doesn't (`asked`). */
const ACCOUNT_KEYS = ['five_hour', 'seven_day'];
const MODEL_KEYS = ['seven_day_opus', 'seven_day_sonnet'];

/** The windows in a `get_usage` answer (the run's stdout, one JSON object per line); null when no answer fits. */
export function parseUsageAnswer(stdout: string): UsageWindow[] | null {
  for (const line of stdout.split('\n')) {
    if (!line.includes('"control_response"')) continue;
    let v: unknown;
    try {
      v = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRecord(v) || v.type !== 'control_response' || !isRecord(v.response)) continue;
    const r = v.response;
    if (r.subtype !== 'success' || r.request_id !== REQUEST_ID || !isRecord(r.response)) continue;
    const limits = r.response.rate_limits;
    if (!isRecord(limits)) return null;
    const windows: UsageWindow[] = [];
    const add = (id: string, label: string, w: unknown, asked: boolean) => {
      if (!isRecord(w) || typeof w.utilization !== 'number' || !Number.isFinite(w.utilization)) return;
      windows.push({
        id,
        label,
        usedPercent: clampPercent(w.utilization),
        resetsAt: resetIso(w.resets_at),
        ...(asked ? { asked: true } : {}),
      });
    };
    for (const key of ACCOUNT_KEYS) add(key, labelOf(key), limits[key], false);
    for (const key of MODEL_KEYS) add(key, labelOf(key), limits[key], true);
    if (Array.isArray(limits.model_scoped)) {
      for (const m of limits.model_scoped) {
        if (!isRecord(m) || typeof m.display_name !== 'string' || !m.display_name.trim()) continue;
        const name = m.display_name.trim().slice(0, 40);
        const id = `seven_day_model_${slug(name)}`;
        if (windows.some((w) => w.id === id)) continue;
        add(id, `Weekly ${name} limit`, m, true);
      }
    }
    return windows;
  }
  return null;
}

/** Runs the ask with `env` and gives back what it printed (rejects when it couldn't run). Injectable for tests. */
export type UsageAskRun = (env: NodeJS.ProcessEnv) => Promise<string>;

const runAsk: UsageAskRun = (env) =>
  new Promise((resolve, reject) => {
    const child = spawn('claude', USAGE_ASK_ARGS, { cwd: os.tmpdir(), env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let out = '';
    const timer = setTimeout(() => child.kill(), ASK_TIMEOUT_MS);
    timer.unref?.();
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (d: string) => {
      out += d;
      // The answer is all we wanted: don't wait for it to wind down.
      if (out.includes(`"request_id":"${REQUEST_ID}"`) && out.endsWith('\n')) child.kill();
    });
    child.stderr?.resume();
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', () => {
      clearTimeout(timer);
      resolve(out);
    });
    child.stdin?.on('error', () => undefined); // it may exit before reading
    child.stdin?.end(`${USAGE_ASK_REQUEST}\n`);
  });

/** The environment an account is asked in: its config folder, work's internal-run marker, no API key and no parent session. */
export function askEnv(account: string, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = withoutParentSession({ ...applyEnvDelta(base, accountEnv(account)), ...internalRunEnv() }) as NodeJS.ProcessEnv;
  for (const k of Object.keys(env)) if (/^ANTHROPIC_(API_KEY|AUTH_TOKEN)$/i.test(k)) delete env[k];
  return env;
}

const lastAsked = new Map<string, number>();

/** Forget when each account was asked (tests). */
export function resetUsageAsks(): void {
  lastAsked.clear();
}

/**
 * Ask each signed-in account not asked in the last ASK_EVERY_MS and keep its answer as the account's reading (a full
 * one: it replaces the status line's, `asked` windows included). Never throws; returns the accounts it recorded.
 */
export async function askClaudeUsage(
  o: { now?: number; run?: UsageAskRun; accounts?: ClaudeAccount[]; loggedIn?: (dir: string) => boolean | null } = {},
): Promise<string[]> {
  const now = o.now ?? Date.now();
  const run = o.run ?? runAsk;
  const loggedIn = o.loggedIn ?? isLoggedIn;
  let accounts: ClaudeAccount[];
  try {
    accounts = o.accounts ?? setUpAccounts();
  } catch (e) {
    debugLog('WARN', `[usage] accounts not read for asking: ${e instanceof Error ? e.message : String(e)}`);
    return [];
  }
  const due = accounts.filter((a) => loggedIn(a.dir) !== false && now - (lastAsked.get(a.name) ?? -Infinity) >= ASK_EVERY_MS);
  for (const a of due) lastAsked.set(a.name, now);
  // One account at a time: each ask starts a Claude Code, and several at once weigh on a busy machine.
  const done: Array<string | null> = [];
  for (const a of due) {
    try {
      const windows = parseUsageAnswer(await run(askEnv(a.name)));
      if (!windows || windows.length === 0) {
        debugLog('INFO', `[usage] ${a.name}: Claude Code gave no usage answer (get_usage)`);
        done.push(null);
        continue;
      }
      // Kept under the key the status-line hook uses for this folder (~/.claude: `default`).
      recordReading('claude', accountOf(a.dir), windows, now, { full: true });
      done.push(a.name);
    } catch (e) {
      debugLog('WARN', `[usage] ${a.name}: asking Claude Code for usage failed: ${e instanceof Error ? e.message : String(e)}`);
      done.push(null);
    }
  }
  return done.filter((n): n is string => n !== null);
}
