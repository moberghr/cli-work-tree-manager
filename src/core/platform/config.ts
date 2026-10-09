import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { atomicWriteFile } from './fs-safe.js';
import { validatePrompts } from '../sessions/saved-prompts.js';
import type { SavedPrompt } from '../api-types.js';

/**
 * An opt-in shell command that runs when a session changes status. The command
 * runs with the session's directory as its cwd (passed as the spawn `cwd`
 * option, never interpolated into the command string).
 */
export interface StatusHook {
  on: 'idle' | 'needs_input';
  command: string;
}

export interface WorkConfig {
  worktreesRoot: string;
  repos: Record<string, string>;
  groups: Record<string, string[]>;
  copyFiles: string[];
  /** Folders the Repos page scans for git repos (repo-scan.ts); default: the one the worktrees root sits in. */
  scanRoots?: string[];
  /** Repos you chose not to enrol (paths), so the Repos page stops offering them. */
  ignoredRepos?: string[];
  /** The Jira watch (jira-watch.ts; turned on and off in the Jira tab): at most this many automatic starts a day (default 5). */
  jiraWatch?: { maxPerDay?: number };
  /** The Time tab's rules (core/time/allocate.ts, defaults in DEFAULT_TIME_SETTINGS), and the Jira
   *  projects whose keys count in commit subjects (default: the projects of your sessions' keys). */
  time?: Partial<import('../time/allocate.js').TimeSettings> & {
    projects?: string[];
    /** Posting to Tempo: the env variable with the token (default TEMPO_API_TOKEN) and your Jira account id (else JIRA_ACCOUNT_ID). */
    tempo?: { tokenEnv?: string; accountId?: string };
    /** Outlook and Teams through Microsoft Graph: the app registration to sign in with (else GRAPH_CLIENT_ID / GRAPH_TENANT_ID). */
    graph?: { clientId?: string; tenantId?: string };
  };
  /** Stacked sessions (stack-sync.ts): bring a parent's new commits into the sessions stacked on it (default true). */
  stacks?: { autoUpdate?: boolean };
  /** The agent that writes work's own summaries — checkpoint names, catch-up, archive summaries, the Jira watch's choice (default `claude`; one without one-shot runs writes none). */
  internalAgent?: string;
  /** The agent the Ctrl+K assistant runs (an adapter's id; Claude Code by default). */
  assistantAgent?: string;
  /** Environment variable names to keep for a session restored after a reboot (the launching shell's values; secret-looking names are never kept). */
  hostEnv?: string[];
  /** Writing session time to Jira as worklogs (jira-worklog.ts): the site, your email, and the API token (from the env var `tokenEnv`, default JIRA_API_TOKEN, or `token`). */
  jiraWorklog?: { site: string; email: string; tokenEnv?: string; token?: string };
  /**
   * AI tool command to launch in worktrees. May include extra args, e.g.
   * "claude" (default), "gemini", "codex", or "my-tool --some-flag".
   */
  aiCommand?: string;
  /**
   * Launch `work tree`'s AI session inside the PTY host and attach this
   * terminal to it (like `work attach`), so it survives closing the tab and
   * the dashboard shows the same screen. Default on; `false` launches
   * directly in the terminal. Per call: `--host` / `--no-host`.
   */
  launchViaHost?: boolean;
  /**
   * Per-tool flag overrides. Defaults come from the preset matching the
   * binary in `aiCommand` (see AI_TOOL_PRESETS in core/ai-launcher.ts).
   * Set any value to an empty string to disable that flag for the configured tool.
   */
  aiCommandFlags?: {
    /** Flag for skipping permission checks. */
    unsafe?: string;
    /** Flag for resuming the most recent session. */
    resume?: string;
    /** Flag for passing an initial prompt as a file path. */
    promptFile?: string;
    /** Flag for passing an inline prompt; empty string = positional arg. */
    prompt?: string;
  };
  /** Editor command for opening worktrees. Default: "code" */
  editor?: string;
  /**
   * Range of dev-server ports to allocate to worktrees (inclusive).
   * Each worktree gets a stable port exposed as $PORT to the launched process.
   * Default when unset: { start: 3000, end: 3099 }.
   */
  portRange?: { start: number; end: number };
  /**
   * Dev-server command per repo alias, run from the dashboard with this
   * worktree's $PORT (e.g. `{ "web": "npm run dev -- --port $PORT" }`).
   */
  devCommands?: Record<string, string>;
  /**
   * Stop a session's Claude in the PTY host after this many minutes idle with
   * no window attached; opening the session resumes its conversation. Frees
   * memory (each Claude holds a few hundred MB). Default 240; 0 = never.
   */
  sleepIdleAfterMinutes?: number;
  /**
   * Archived conversations (archive-retention.ts): gzip them once this many
   * days old (default 30; 0 = never; lossless), and delete them after this
   * many (default 0 = never; the summary and prompts stay).
   */
  archive?: { compressAfterDays?: number; dropTranscriptsAfterDays?: number };
  /**
   * Background PR watch in `work web` (both default on): archive a session
   * once all its PRs merged, and tell its Claude when CI fails or reviewers
   * leave feedback.
   */
  prWatch?: {
    autoArchive?: boolean;
    fixCi?: boolean;
    reviewComments?: boolean;
    /** Review bots whose comments go to Claude like a colleague's (logins,
     *  e.g. "copilot-pull-request-reviewer"). Default: Copilot and
     *  github-actions (pr-review.ts DEFAULT_TRUSTED_BOTS); [] = none. */
    trustedBots?: string[];
    /** Start a session's Claude (resuming its conversation) when feedback
     *  arrives and it isn't running, so it works on it at once. Default on. */
    wakeClaude?: boolean;
  };
  /**
   * Opt-in desktop notifications. When true, the dashboard fires an OS
   * notification when a session goes idle or needs input. Default: off.
   */
  notifications?: boolean;
  /**
   * Opt-in shell commands run when a session changes status (idle /
   * needs_input). Each command runs with the session dir as its cwd.
   * Generalizes `notifications`; both paths work independently. Default: none.
   */
  statusHooks?: StatusHook[];
  /**
   * One-click instructions in a session's "Prompts ▾" menu, replacing the
   * built-in ones: `[{ "label": "Add tests", "prompt": "…", "repos": ["api"] }]`
   * (`repos` optional: only for those repo aliases / group names).
   */
  prompts?: SavedPrompt[];
}

/** Lowest port we allow to be configured (avoid privileged ports < 1024). */
const MIN_PORT = 1024;
/** Highest valid TCP port. */
const MAX_PORT = 65535;

/**
 * Validate a configured port range. Returns the normalized range when it is a
 * pair of integers with `MIN_PORT <= start <= end <= MAX_PORT`, otherwise
 * undefined (callers then fall back to the default range). Rejects non-integers,
 * privileged/out-of-bounds ports, and reversed ranges.
 */
export function validatePortRange(value: unknown): { start: number; end: number } | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const { start, end } = value as { start?: unknown; end?: unknown };
  if (typeof start !== 'number' || typeof end !== 'number') return undefined;
  if (!Number.isInteger(start) || !Number.isInteger(end)) return undefined;
  if (start < MIN_PORT || end > MAX_PORT) return undefined;
  if (start > end) return undefined;
  return { start, end };
}

export function getConfigDir(): string {
  const dir = path.join(os.homedir(), '.work');
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

/** An agent named in config (`internalAgent`, `assistantAgent`): an adapter's id, a plain word — never a path or a command line. */
export function isAgentId(v: unknown): v is string {
  return typeof v === 'string' && /^[\w.-]+$/.test(v);
}

export function getConfigPath(): string {
  return path.join(getConfigDir(), 'config.json');
}

function validateDevCommands(raw: unknown): Record<string, string> | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const out: Record<string, string> = {};
  for (const [alias, cmd] of Object.entries(raw)) if (typeof cmd === 'string' && cmd.trim()) out[alias] = cmd;
  return out;
}

/** A list of non-empty strings, or undefined (not a list). */
/** The Time tab's section as written: only well-formed values (a bad one is left to its default). */
export function validateTime(raw: unknown): WorkConfig['time'] {
  if (!raw || typeof raw !== 'object') return undefined;
  const t = raw as Record<string, unknown>;
  const num = (k: string, min: number) => (typeof t[k] === 'number' && (t[k] as number) >= min ? { [k]: t[k] as number } : {});
  const key = (k: string) => (typeof t[k] === 'string' && /^[A-Z][A-Z0-9]{1,9}-\d+$/.test(t[k] as string) ? { [k]: t[k] as string } : {});
  const strs = (o: unknown, keys: string[]) => {
    if (!o || typeof o !== 'object') return undefined;
    const out: Record<string, string> = {};
    for (const k of keys) {
      const v = (o as Record<string, unknown>)[k];
      if (typeof v === 'string' && v.trim()) out[k] = v.trim();
    }
    return Object.keys(out).length ? out : undefined;
  };
  const days = stringList(t.holidays)?.filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d));
  const projects = stringList(t.projects)?.filter((p) => /^[A-Z][A-Z0-9]{1,9}$/.test(p));
  const tempo = strs(t.tempo, ['tokenEnv', 'accountId']);
  const graph = strs(t.graph, ['clientId', 'tenantId']);
  return {
    ...num('dayHours', 0.25),
    ...num('multiplier', 0),
    ...num('capHours', 0),
    ...num('stepHours', 0.01),
    ...num('minHours', 0),
    ...key('gapTicket'),
    ...key('timeOffTicket'),
    ...(days ? { holidays: days } : {}),
    ...(projects ? { projects } : {}),
    ...(tempo ? { tempo } : {}),
    ...(graph ? { graph } : {}),
  };
}

function stringList(raw: unknown): string[] | undefined {
  return Array.isArray(raw) ? raw.filter((x): x is string => typeof x === 'string' && x.trim().length > 0) : undefined;
}

export function loadConfig(): WorkConfig | null {
  const configPath = getConfigPath();
  if (!fs.existsSync(configPath)) {
    return null;
  }

  try {
    const raw = fs.readFileSync(configPath, 'utf-8');
    const parsed = JSON.parse(raw);
    return {
      worktreesRoot: parsed.worktreesRoot ?? '',
      repos: parsed.repos ?? {},
      groups: parsed.groups ?? {},
      copyFiles: parsed.copyFiles ?? [],
      scanRoots: stringList(parsed.scanRoots),
      ignoredRepos: stringList(parsed.ignoredRepos),
      aiCommand: parsed.aiCommand,
      aiCommandFlags: parsed.aiCommandFlags,
      editor: parsed.editor,
      portRange: validatePortRange(parsed.portRange),
      notifications: parsed.notifications === true,
      statusHooks: Array.isArray(parsed.statusHooks) ? parsed.statusHooks : [],
      launchViaHost: typeof parsed.launchViaHost === 'boolean' ? parsed.launchViaHost : undefined,
      devCommands: validateDevCommands(parsed.devCommands),
      sleepIdleAfterMinutes:
        typeof parsed.sleepIdleAfterMinutes === 'number' && parsed.sleepIdleAfterMinutes >= 0 ? parsed.sleepIdleAfterMinutes : undefined,
      prompts: validatePrompts(parsed.prompts),
      time: validateTime(parsed.time),
      archive:
        parsed.archive && typeof parsed.archive === 'object'
          ? {
              ...(typeof parsed.archive.compressAfterDays === 'number' && parsed.archive.compressAfterDays >= 0
                ? { compressAfterDays: parsed.archive.compressAfterDays }
                : {}),
              ...(typeof parsed.archive.dropTranscriptsAfterDays === 'number' && parsed.archive.dropTranscriptsAfterDays >= 0
                ? { dropTranscriptsAfterDays: parsed.archive.dropTranscriptsAfterDays }
                : {}),
            }
          : undefined,
      stacks: parsed.stacks && typeof parsed.stacks === 'object' ? { autoUpdate: parsed.stacks.autoUpdate !== false } : undefined,
      internalAgent: isAgentId(parsed.internalAgent) ? parsed.internalAgent : undefined,
      assistantAgent: isAgentId(parsed.assistantAgent) ? parsed.assistantAgent : undefined,
      hostEnv: Array.isArray(parsed.hostEnv)
        ? parsed.hostEnv.filter((n: unknown): n is string => typeof n === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(n))
        : undefined,
      jiraWorklog:
        parsed.jiraWorklog &&
        typeof parsed.jiraWorklog === 'object' &&
        typeof parsed.jiraWorklog.site === 'string' &&
        typeof parsed.jiraWorklog.email === 'string'
          ? {
              site: parsed.jiraWorklog.site,
              email: parsed.jiraWorklog.email,
              ...(typeof parsed.jiraWorklog.tokenEnv === 'string' ? { tokenEnv: parsed.jiraWorklog.tokenEnv } : {}),
              ...(typeof parsed.jiraWorklog.token === 'string' ? { token: parsed.jiraWorklog.token } : {}),
            }
          : undefined,
      prWatch:
        parsed.prWatch && typeof parsed.prWatch === 'object'
          ? {
              autoArchive: parsed.prWatch.autoArchive !== false,
              fixCi: parsed.prWatch.fixCi !== false,
              reviewComments: parsed.prWatch.reviewComments !== false,
              ...(Array.isArray(parsed.prWatch.trustedBots)
                ? {
                    trustedBots: parsed.prWatch.trustedBots.filter(
                      (b: unknown): b is string => typeof b === 'string' && b.trim().length > 0,
                    ),
                  }
                : {}),
              wakeClaude: parsed.prWatch.wakeClaude !== false,
            }
          : undefined,
    };
  } catch {
    return null;
  }
}

export function saveConfig(config: WorkConfig): void {
  // Atomic (write temp + rename): a crash or a concurrent reader can never
  // see a half-written config (§5.3 — history/tasks already did this).
  atomicWriteFile(getConfigPath(), JSON.stringify(config, null, 2));
}

export function ensureConfig(): WorkConfig {
  const config = loadConfig();
  if (!config) {
    throw new Error('Configuration not found. Run "work init" to set up.');
  }
  return config;
}
