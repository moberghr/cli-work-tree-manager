/**
 * The settings work's Settings page and a repo's settings show and change: one list, shared by the server (which
 * checks what it writes to config.json) and the SPA (which draws each one and checks what you type), and the demo.
 * Pure and import-free.
 *
 * Only plain values are here: a switch, a number, a line of text, a list of words, a choice. What has a page of its
 * own isn't (repos and groups: Repos; Claude accounts: Accounts; which PRs are reviewed: Reviews), and neither is
 * what doesn't fit a field (saved prompts, status hooks, the agent's flags, the Time tab's ticket hints, holidays) —
 * the page says those are in config.json. No secret is ever one of them: a token is named by the environment
 * variable that holds it, never shown or written here.
 */

/** A setting that can't be written as asked: why, and the status a route answers with. */
export class SettingsError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 = 400,
  ) {
    super(message);
  }
}

export type SettingKind =
  | { type: 'bool' }
  | { type: 'number'; min: number; max: number; /** 0 is allowed besides [min, max] ("off"). */ zeroOff?: boolean }
  | { type: 'text'; placeholder?: string }
  | { type: 'list'; placeholder?: string; /** Each entry must match this (an environment variable's name). */ pattern?: string }
  | { type: 'choice'; options: Array<{ value: string; label: string }> };

export interface SettingField {
  /** Its place in config.json, dotted (`prWatch.autoArchive`). */
  path: string;
  section: SettingSection;
  label: string;
  /** What it does, a sentence or two. */
  help: string;
  kind: SettingKind;
  /** What it is when config.json doesn't say (shown as the value then). */
  default: boolean | number | string | string[] | null;
  /** When it takes effect, when that isn't at once. */
  when?: string;
}

export type SettingSection = 'General' | 'Agents & terminals' | 'Pull requests' | 'Reviews' | 'Jira' | 'Time' | 'Archive & usage';

export const SETTING_SECTIONS: readonly SettingSection[] = [
  'General',
  'Agents & terminals',
  'Pull requests',
  'Reviews',
  'Jira',
  'Time',
  'Archive & usage',
];

const bool = (path: string, section: SettingSection, label: string, help: string, def: boolean, when?: string): SettingField => ({
  path,
  section,
  label,
  help,
  kind: { type: 'bool' },
  default: def,
  ...(when ? { when } : {}),
});

export const SETTINGS: readonly SettingField[] = [
  // ---- General
  {
    path: 'worktreesRoot',
    section: 'General',
    label: 'Worktrees folder',
    help: 'Where new worktrees are made. Existing sessions stay where they are.',
    kind: { type: 'text' },
    default: null,
  },
  {
    path: 'editor',
    section: 'General',
    label: 'Editor',
    help: 'The command Open in editor runs (code, cursor, idea, subl…).',
    kind: { type: 'text', placeholder: 'code' },
    default: 'code',
  },
  bool(
    'notifications',
    'General',
    'Desktop notifications',
    'A notification when a session finishes or needs you and no dashboard is looking.',
    false,
  ),
  {
    path: 'copyFiles',
    section: 'General',
    label: 'Files copied into new worktrees',
    help: 'Glob patterns of files git ignores that a new worktree should still have (local settings, .env files).',
    kind: { type: 'list', placeholder: 'appsettings.Development.json' },
    default: [],
  },
  {
    path: 'scanRoots',
    section: 'General',
    label: 'Folders scanned for repos',
    help: 'The Repos page lists the git repos in these folders. Empty: the folder that holds the worktrees folder.',
    kind: { type: 'list' },
    default: [],
  },
  bool(
    'sessionFolders',
    'General',
    'Every session in a folder of its own (experimental)',
    'A new session, a single repo too, is a folder of repos, so Add a repo works on it. Existing sessions keep their layout.',
    false,
  ),
  // ---- Agents & terminals
  {
    path: 'aiCommand',
    section: 'Agents & terminals',
    label: 'Agent for new sessions',
    help: 'The command a new session runs. An existing session keeps the one it was made with.',
    kind: { type: 'text', placeholder: 'claude' },
    default: 'claude',
  },
  {
    path: 'internalAgent',
    section: 'Agents & terminals',
    label: "Agent for work's summaries",
    help: 'Writes checkpoint names, catch-ups, archive summaries and the Reviews step.',
    kind: { type: 'text', placeholder: 'claude' },
    default: 'claude',
  },
  {
    path: 'assistantAgent',
    section: 'Agents & terminals',
    label: 'Agent for the Ctrl+K assistant',
    help: 'The agent the Ask panel runs.',
    kind: { type: 'text', placeholder: 'claude' },
    default: 'claude',
  },
  bool(
    'launchViaHost',
    'Agents & terminals',
    'Run sessions in the PTY host',
    '`work tree` starts its agent in the PTY host, so the dashboard shows the same terminal. Off: in the terminal you ran it from, invisible to the dashboard.',
    true,
  ),
  {
    path: 'sleepIdleAfterMinutes',
    section: 'Agents & terminals',
    label: 'Stop idle agents after (minutes)',
    help: 'An agent nobody is watching that has printed nothing this long, with nothing running, is stopped; opening the session starts it again. 0: never.',
    kind: { type: 'number', min: 5, max: 1440, zeroOff: true },
    default: 10,
  },
  {
    path: 'hostEnv',
    section: 'Agents & terminals',
    label: 'Environment kept for restored sessions',
    help: 'Variables a session restored after a restart keeps from the shell that started it. Names that look like secrets are never kept.',
    kind: { type: 'list', placeholder: 'JAVA_HOME', pattern: '^[A-Za-z_][A-Za-z0-9_]*$' },
    default: ['JAVA_HOME', 'PATH'],
  },
  bool(
    'useBundledConpty',
    'Agents & terminals',
    'Windows: use the terminal node-pty ships',
    "Terminals start on node-pty's own ConPTY instead of Windows' (experimental; try it if a terminal start hangs).",
    false,
    'at the next terminal start',
  ),
  // ---- Pull requests
  bool(
    'prWatch.autoArchive',
    'Pull requests',
    'Archive a session once its PRs merge',
    'Its conversation is kept, and Restore brings everything back.',
    true,
  ),
  bool(
    'prWatch.fixCi',
    'Pull requests',
    'Ask Claude to fix failing checks',
    "Once per push, for the checks that count (see a repo's settings).",
    true,
  ),
  bool(
    'prWatch.fixConflicts',
    'Pull requests',
    'Ask Claude to resolve merge conflicts',
    'It merges the base in; a conflict that takes a choice comes to you.',
    true,
  ),
  bool(
    'prWatch.reviewComments',
    'Pull requests',
    'Hand review comments to Claude',
    'From reviewers with write access and the trusted bots. Claude plans and drafts replies; nothing is posted without your yes.',
    true,
  ),
  bool(
    'prWatch.wakeClaude',
    'Pull requests',
    'Start a stopped Claude for them',
    "When feedback comes and the session's Claude isn't running, it's started to work on it.",
    true,
  ),
  {
    path: 'prWatch.trustedBots',
    section: 'Pull requests',
    label: 'Review bots trusted like a colleague',
    help: 'Their comments go to Claude too. Empty list: none.',
    kind: { type: 'list', placeholder: 'copilot-pull-request-reviewer' },
    default: ['copilot-pull-request-reviewer', 'github-actions'],
  },
  bool(
    'stacks.autoUpdate',
    'Pull requests',
    'Keep stacked sessions up to date',
    'A session made from another one is updated from it after a turn, when that goes cleanly.',
    true,
  ),
  // ---- Reviews
  {
    path: 'reviews.maxPerDay',
    section: 'Reviews',
    label: 'Most reviews prepared a day',
    help: 'Empty: no limit.',
    kind: { type: 'number', min: 1, max: 1000 },
    default: null,
  },
  {
    path: 'reviews.maxLines',
    section: 'Reviews',
    label: 'Bigger PRs wait for a click (changed lines)',
    help: 'A PR changing more lines than this is prepared only when you ask.',
    kind: { type: 'number', min: 1, max: 1_000_000 },
    default: 3000,
  },
  // ---- Jira
  {
    path: 'jiraWatch.maxPerDay',
    section: 'Jira',
    label: 'Most issues the Jira watch starts a day',
    help: 'Newly assigned issues it starts by itself (when it is on, on the Jira tab).',
    kind: { type: 'number', min: 0, max: 100 },
    default: 5,
  },
  {
    path: 'jiraWorklog.site',
    section: 'Jira',
    label: 'Jira site for worklogs',
    help: 'Where → PAY-12 writes a worklog, e.g. yourcompany.atlassian.net.',
    kind: { type: 'text', placeholder: 'yourcompany.atlassian.net' },
    default: null,
  },
  {
    path: 'jiraWorklog.email',
    section: 'Jira',
    label: 'Your Jira email',
    help: 'Who the worklog is written as.',
    kind: { type: 'text' },
    default: null,
  },
  {
    path: 'jiraWorklog.tokenEnv',
    section: 'Jira',
    label: 'Environment variable with the API token',
    help: 'The token itself is never stored here.',
    kind: { type: 'text', placeholder: 'JIRA_API_TOKEN' },
    default: 'JIRA_API_TOKEN',
  },
  // ---- Time
  {
    path: 'time.dayHours',
    section: 'Time',
    label: 'A workday (hours)',
    help: '',
    kind: { type: 'number', min: 0.5, max: 24 },
    default: 7.5,
  },
  {
    path: 'time.multiplier',
    section: 'Time',
    label: 'Claude minutes × this = your hours',
    help: 'How measured agent time becomes your time on a ticket.',
    kind: { type: 'number', min: 0, max: 100 },
    default: 5,
  },
  {
    path: 'time.capHours',
    section: 'Time',
    label: 'At most this much of a day to tickets',
    help: 'The gap ticket keeps the rest.',
    kind: { type: 'number', min: 0, max: 24 },
    default: 7,
  },
  {
    path: 'time.stepHours',
    section: 'Time',
    label: 'Round to (hours)',
    help: '',
    kind: { type: 'number', min: 0.05, max: 8 },
    default: 0.25,
  },
  {
    path: 'time.minHours',
    section: 'Time',
    label: 'A ticket gets at least (hours)',
    help: '',
    kind: { type: 'number', min: 0, max: 8 },
    default: 0.5,
  },
  {
    path: 'time.gapTicket',
    section: 'Time',
    label: 'Gap ticket',
    help: "Gets what's left of the day. Empty: left unallocated.",
    kind: { type: 'text', placeholder: 'SSD-1' },
    default: null,
  },
  {
    path: 'time.timeOffTicket',
    section: 'Time',
    label: 'Time-off ticket',
    help: 'A day off is booked to it.',
    kind: { type: 'text' },
    default: null,
  },
  {
    path: 'time.projects',
    section: 'Time',
    label: 'Your Jira projects',
    help: "Only these projects' keys count. Empty: your sessions' and the issues you moved.",
    kind: { type: 'list', placeholder: 'PAY' },
    default: [],
  },
  {
    path: 'time.deskProjects',
    section: 'Time',
    label: 'Service-desk projects',
    help: "Their tickets keep the minimum; any other project's ticket is a task.",
    kind: { type: 'list', placeholder: 'SSD' },
    default: [],
  },
  {
    path: 'time.pointsWeight',
    section: 'Time',
    label: 'Story points weight',
    help: "A task's hours × (1 + this × (points − 1)). 0: points don't count.",
    kind: { type: 'number', min: 0, max: 10 },
    default: 0.25,
  },
  {
    path: 'time.storyPointsField',
    section: 'Time',
    label: 'Story points field',
    help: "Your Jira site's field for them (customfield_…).",
    kind: { type: 'text', placeholder: 'customfield_10016' },
    default: null,
  },
  {
    path: 'time.catchUpDays',
    section: 'Time',
    label: 'Days the Time tab gathers back',
    help: "Claude's own transcripts go back about 30 days.",
    kind: { type: 'number', min: 1, max: 92 },
    default: 14,
  },
  {
    path: 'time.tempo.accountId',
    section: 'Time',
    label: 'Your Jira account id (Tempo)',
    help: 'Else JIRA_ACCOUNT_ID.',
    kind: { type: 'text' },
    default: null,
  },
  {
    path: 'time.tempo.tokenEnv',
    section: 'Time',
    label: 'Environment variable with the Tempo token',
    help: 'The token itself is never stored here.',
    kind: { type: 'text', placeholder: 'TEMPO_API_TOKEN' },
    default: 'TEMPO_API_TOKEN',
  },
  // ---- Archive & usage
  {
    path: 'archive.compressAfterDays',
    section: 'Archive & usage',
    label: "Compress an archive's transcripts after (days)",
    help: 'Lossless; search and Restore read them all the same.',
    kind: { type: 'number', min: 1, max: 3650 },
    default: 30,
  },
  {
    path: 'archive.dropTranscriptsAfterDays',
    section: 'Archive & usage',
    label: "Delete an archive's transcripts after (days)",
    help: 'Its summary stays. 0: never.',
    kind: { type: 'number', min: 1, max: 3650, zeroOff: true },
    default: 0,
  },
  bool(
    'usage.statusLine',
    'Archive & usage',
    "Read plan limits from Claude's status line",
    "The Usage meter's source. Off gives Claude Code its own status line back.",
    true,
    'at the next work web start',
  ),
];

/** What the Settings page says isn't on it (edit config.json for those: `work config edit`). */
export const SETTINGS_ELSEWHERE =
  'Repos and groups are on the Repos page, Claude accounts on Accounts, which PRs are reviewed on Reviews. Saved prompts, status hooks, the agent’s flags, the port range, git hosts and the Time tab’s hints, holidays and vacation are in config.json: work config edit opens it.';

export const settingAt = (path: string): SettingField | undefined => SETTINGS.find((f) => f.path === path);

/** A value to write: checked and tidied, or why not. `null`: back to the default (the key goes). Pure. */
export function checkSetting(field: SettingField, raw: unknown): { ok: true; value: unknown } | { ok: false; error: string } {
  if (raw === null) return { ok: true, value: null };
  const k = field.kind;
  switch (k.type) {
    case 'bool':
      return typeof raw === 'boolean' ? { ok: true, value: raw } : { ok: false, error: 'on or off' };
    case 'number': {
      // Empty: back to the default.
      if (typeof raw === 'string' && raw.trim() === '') return { ok: true, value: null };
      const n = typeof raw === 'string' ? Number(raw) : raw;
      if (typeof n !== 'number' || !Number.isFinite(n)) return { ok: false, error: 'a number' };
      if (k.zeroOff && n === 0) return { ok: true, value: 0 };
      if (n < k.min || n > k.max) return { ok: false, error: `from ${k.min} to ${k.max}${k.zeroOff ? ', or 0 for off' : ''}` };
      return { ok: true, value: n };
    }
    case 'text': {
      if (typeof raw !== 'string') return { ok: false, error: 'text' };
      const t = raw.trim();
      if (t.length > 500) return { ok: false, error: 'at most 500 characters' };
      return t ? { ok: true, value: t } : { ok: true, value: null };
    }
    case 'list': {
      if (!Array.isArray(raw)) return { ok: false, error: 'a list' };
      const items: string[] = [];
      for (const x of raw) {
        if (typeof x !== 'string') return { ok: false, error: 'a list of words' };
        const t = x.trim();
        if (!t) continue;
        if (t.length > 300) return { ok: false, error: `“${t.slice(0, 30)}…” is too long` };
        if (k.pattern && !new RegExp(k.pattern).test(t)) return { ok: false, error: `“${t}” isn't a variable's name` };
        if (!items.includes(t)) items.push(t);
      }
      if (items.length > 100) return { ok: false, error: 'at most 100' };
      return { ok: true, value: items };
    }
    case 'choice':
      return typeof raw === 'string' && k.options.some((o) => o.value === raw)
        ? { ok: true, value: raw }
        : { ok: false, error: `one of ${k.options.map((o) => o.value).join(', ')}` };
  }
}

/** The value at a dotted path of a JSON object (undefined: not set). Pure. */
export function valueAt(obj: unknown, path: string): unknown {
  let cur: unknown = obj;
  for (const key of path.split('.')) {
    if (!cur || typeof cur !== 'object' || Array.isArray(cur)) return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

/**
 * The object with the value set at a dotted path (objects on the way made), or the key taken out (`null`) — and an
 * object left empty by that taken out too. Changes `obj` in place. Pure but for that.
 */
export function setValueAt(obj: Record<string, unknown>, path: string, value: unknown): void {
  const keys = path.split('.');
  const chain: Array<Record<string, unknown>> = [obj];
  let cur = obj;
  for (const key of keys.slice(0, -1)) {
    const next = cur[key];
    if (!next || typeof next !== 'object' || Array.isArray(next)) {
      if (value === null) return; // nothing there to take out
      cur[key] = {};
    }
    cur = cur[key] as Record<string, unknown>;
    chain.push(cur);
  }
  const last = keys[keys.length - 1];
  if (value === null) delete cur[last];
  else cur[last] = value;
  if (value !== null) return;
  // Take out the objects the removal left empty, innermost first.
  for (let i = chain.length - 1; i > 0; i--) {
    if (Object.keys(chain[i]).length) break;
    delete chain[i - 1][keys[i - 1]];
  }
}

// ---- a repo's settings

export type ReviewMode = 'all' | 'asked' | 'off';

/** A repo's settings, as the Repos page's Settings panel shows and changes them. */
export interface RepoSettingsValues {
  /** The checks that count where its host requires none (`prWatch.requiredChecks[alias]`); null: every check counts. */
  requiredChecks: string[] | null;
  /** What Start dev server runs (`devCommands[alias]`); null: none. */
  devCommand: string | null;
  /** Its PRs reviewed in the background (`reviews.projects[alias]`); null: as its group says, else asked. */
  reviews: ReviewMode | null;
}

export type RepoSettingKey = keyof RepoSettingsValues;

/** Where a repo setting lives in config.json, under its alias. */
export const REPO_SETTING_PATH: Record<RepoSettingKey, string> = {
  requiredChecks: 'prWatch.requiredChecks',
  devCommand: 'devCommands',
  reviews: 'reviews.projects',
};

/** A repo setting's value to write, checked; `null`: take it out. Pure. */
export function checkRepoSetting(key: RepoSettingKey, raw: unknown): { ok: true; value: unknown } | { ok: false; error: string } {
  if (raw === null) return { ok: true, value: null };
  if (key === 'requiredChecks') {
    const r = checkSetting({ ...SETTINGS[0], kind: { type: 'list' } }, raw);
    if (!r.ok) return r;
    return (r.value as string[]).length ? r : { ok: true, value: null };
  }
  if (key === 'devCommand') return checkSetting({ ...SETTINGS[0], kind: { type: 'text' } }, raw);
  return raw === 'all' || raw === 'asked' || raw === 'off' ? { ok: true, value: raw } : { ok: false, error: 'all, asked or off' };
}

/** A repo's settings from config.json as it is (raw JSON), by its alias. Pure. */
export function repoSettingsOf(raw: unknown, alias: string): RepoSettingsValues {
  const map = (path: string) => {
    const m = valueAt(raw, path);
    return m && typeof m === 'object' && !Array.isArray(m) ? (m as Record<string, unknown>) : {};
  };
  const checks = map(REPO_SETTING_PATH.requiredChecks)[alias];
  const dev = map(REPO_SETTING_PATH.devCommand)[alias];
  const review = map(REPO_SETTING_PATH.reviews)[alias];
  return {
    requiredChecks: Array.isArray(checks) ? checks.filter((c): c is string => typeof c === 'string') : null,
    devCommand: typeof dev === 'string' && dev ? dev : null,
    reviews: review === 'all' || review === 'asked' || review === 'off' ? review : null,
  };
}
