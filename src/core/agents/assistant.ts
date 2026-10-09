import fs from 'node:fs';
import path from 'node:path';
import { getConfigDir } from '../platform/config.js';
import { atomicWriteFile } from '../platform/fs-safe.js';
import type { AssistantView, SessionWire } from '../api-types.js';
import { DISPLAY_LABEL, displayStatus } from '../sessions/session-view.js';
import type { AgentAdapter, AllowRule, WorkHook } from './types.js';

/**
 * The dashboard assistant (Ctrl+K): a persistent agent session in the PTY
 * host, like any worktree's, with its own folder under ~/.work/assistant. It
 * runs config `assistantAgent` (Claude Code by default; `assistantAgent()`).
 *
 * That folder is written by work: the agent's instructions file (CLAUDE.md
 * for Claude) saying what it is for and how to get the data (the
 * `work … --json` commands), and through its adapter's `workspace` its own
 * settings: the read-only commands pre-allowed, and a hook at the start of
 * each turn that adds what the user is looking at in the dashboard to the
 * prompt (`work hook assistant-context`), so "clean these up" or "why is this
 * one blocked?" need no explaining. An agent without a workspace gets the
 * instructions only (it asks before every command, and sees no view).
 *
 * It runs in the agent's normal permission mode, never --unsafe: anything
 * not pre-allowed — `work cleanup --apply`, `work remove`, git — asks first,
 * in the panel (and the Inbox).
 */

export const ASSISTANT_ID = 'assistant';

/** What the dashboard reported, kept this long for the hook. */
export const CONTEXT_TTL_MS = 30 * 60_000;

export function assistantDir(): string {
  return path.join(getConfigDir(), 'assistant');
}
const contextFile = () => path.join(assistantDir(), 'context.json');

/**
 * Read-only commands it may run without asking (each agent's adapter writes
 * them in its own terms). Exact forms for cleanup: a `work cleanup --json`
 * prefix rule would also allow `--apply`.
 */
export const ASSISTANT_ALLOW: AllowRule[] = [
  { command: 'work sessions', prefix: true },
  { command: 'work digest', prefix: true },
  { command: 'work overlaps', prefix: true },
  { command: 'work search', prefix: true },
  { command: 'work cleanup --json' },
  { command: 'work cleanup --json --no-fetch' },
  { command: 'work cleanup --no-fetch --json' },
  { command: 'work list', prefix: true },
  { command: 'work recent', prefix: true },
  // The Time tab's day, read only (set / reset / off / gather / post ask first).
  { command: 'work timesheet show', prefix: true },
];

/** Its hook: what the dashboard shows, added at the start of each turn. */
export const ASSISTANT_HOOKS: WorkHook[] = [
  { owner: 'assistant', edge: 'turn-start', command: 'work hook assistant-context', timeoutSec: 5 },
];

export const ASSISTANT_INSTRUCTIONS = `# You are the work dashboard's assistant

The user opens you with Ctrl+K in \`work web\`, the dashboard over all their git worktrees and the coding agent session in each. Help them make sense of it and act on it: what needs them, what each session did, what can be cleaned up, which sessions will conflict.

## Getting the data

Use the \`work\` CLI with \`--json\` (see the work-sessions skill) and parse it; don't guess from the filesystem:

- \`work sessions --json\` — every session: status (\`view.label\`), age, last active, context usage, archive state. \`--changes\` adds +N −M and same-file overlaps; \`--all\` adds older and archived ones.
- \`work digest --json --since today|yesterday|week\` — what each session did (prompts, turns, PRs).
- \`work overlaps --json\` — live sessions changing the same files.
- \`work cleanup --json\` — which worktrees can go, and why.
- \`work timesheet show [day] --json\` — the Time tab's day: hours per ticket, and why (sessions' Claude minutes, commits, Jira, meetings, chats). On the Time tab, the day on screen is described to you with each message.
- \`work search <words> --json\` — sessions whose conversation (live or archived, also older than the agent keeps) mentions it, with the matching lines: "what did we do about X?".

Each prompt comes with what the user is looking at in the dashboard (the tab, the selected session). When they say "this", "these" or "here", that is what they mean.

## Changing things

Ask before you change anything, and say exactly what will happen:
- Removing, archiving or forgetting worktrees: \`work cleanup --apply <id>… --action delete|archive|forget --json\`. Each is checked again right before it runs; report what was refused and why. Never \`--force\` unless the user asked for exactly that.
- A day's hours: \`work timesheet set <day> KEY=HOURS …\` (all its rows; quarter hours, the day's total as the user wants it), \`reset <day>\`, \`off <day>\`. Explain the change first. Posting to Tempo (\`work timesheet post <day>\`) only when the user asks for it.
- Anything else (\`work remove\`, git, files in a worktree): only when asked, and show the command first.

Don't post on GitHub, and don't send prompts to other sessions, unless the user asks. Keep answers short: the user is in the middle of something.
`;

/** What work wrote in the folder last time (relative paths), so files an earlier agent's setup left can go. */
const writtenFile = () => path.join(assistantDir(), '.work-written.json');
/** What a work from before the list wrote: Claude's. */
const BEFORE_THE_LIST = ['CLAUDE.md', path.join('.claude', 'settings.json')];

function readWritten(): string[] {
  try {
    const v = JSON.parse(fs.readFileSync(writtenFile(), 'utf-8')) as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ENOENT' ? BEFORE_THE_LIST : [];
  }
}

/**
 * Write (or refresh) the assistant's folder for the agent it runs; returns
 * it. Idempotent. Files work wrote there for another agent before (its
 * instructions, its settings with their allow rules and hooks) are removed:
 * after a switch they would be instructions and permissions nothing manages.
 * Only files work wrote and listed, inside the folder — never the user's own.
 */
export function prepareAssistantDir(agent: Pick<AgentAdapter, 'instructionsFile' | 'workspace'>): string {
  const dir = assistantDir();
  fs.mkdirSync(dir, { recursive: true });
  const before = readWritten();
  atomicWriteFile(path.join(dir, agent.instructionsFile), ASSISTANT_INSTRUCTIONS);
  const written = [agent.instructionsFile, ...(agent.workspace?.write(dir, { allow: ASSISTANT_ALLOW, hooks: ASSISTANT_HOOKS }) ?? [])].map(
    (f) => path.normalize(f),
  );
  const root = path.resolve(dir);
  for (const old of before.map((f) => path.normalize(f))) {
    const file = path.resolve(root, old);
    if (written.includes(old) || path.isAbsolute(old) || !file.startsWith(root + path.sep)) continue; // listed by us, inside the folder: nothing else
    fs.rmSync(file, { force: true });
  }
  atomicWriteFile(writtenFile(), JSON.stringify(written));
  return dir;
}

interface StoredContext {
  at: string;
  text: string;
  /** The Time tab's day on screen: described afresh at each prompt (rows change by Save, Post, a rebuild). */
  day?: string;
}

/**
 * The dashboard view in words, for the hook: which tab, and the selected
 * session's state. Pure.
 */
export function describeView(view: AssistantView, session: SessionWire | null, now = Date.now()): string {
  const lines = [`The user is looking at the dashboard's ${view.tab} tab${view.sub ? ` (${view.sub})` : ''}.`];
  if (session) {
    const status = DISPLAY_LABEL[displayStatus(session, now)];
    lines.push(
      `Selected session: ${session.target} · ${session.branch} (id ${session.id}) — ${status}.`,
      ...(session.attention?.summary ? [`  Its last line: ${session.attention.summary}`] : []),
      ...(session.diffStat?.files
        ? [`  Uncommitted: +${session.diffStat.added} −${session.diffStat.deleted} in ${session.diffStat.files} files.`]
        : []),
      ...(session.overlaps?.length
        ? [`  Changes the same files as: ${session.overlaps.map((o) => `${o.target} · ${o.branch}`).join(', ')}.`]
        : []),
      ...(session.context ? [`  Its conversation is ${Math.round((session.context.used / session.context.window) * 100)}% full.`] : []),
      ...(session.archivedAt ? ['  It is archived.'] : []),
      `  Worktree: ${session.paths.join(', ')}`,
    );
  }
  if (view.note) lines.push(view.note);
  return lines.join('\n');
}

export function writeAssistantContext(text: string, now = Date.now(), day?: string): void {
  fs.mkdirSync(assistantDir(), { recursive: true });
  const stored: StoredContext = { at: new Date(now).toISOString(), text, ...(day ? { day } : {}) };
  atomicWriteFile(contextFile(), JSON.stringify(stored));
}

/** The day on screen, if the Time tab is: for the hook to describe as it is now. */
export function assistantContextDay(now = Date.now()): string | null {
  const s = readStored(now);
  return s && typeof s.day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s.day) ? s.day : null;
}

function readStored(now: number): Partial<StoredContext> | null {
  try {
    const s = JSON.parse(fs.readFileSync(contextFile(), 'utf-8')) as Partial<StoredContext> | null;
    if (!s || typeof s.text !== 'string' || typeof s.at !== 'string') return null;
    return now - Date.parse(s.at) > CONTEXT_TTL_MS ? null : s;
  } catch {
    return null;
  }
}

/**
 * What the hook adds to a prompt; null when the dashboard said nothing
 * lately. `dayNow` describes the Time tab's day as it is at this prompt
 * (the hook reads it from state.db), not as it was when the tab was opened.
 */
export function readAssistantContext(now = Date.now(), dayNow?: string | null): string | null {
  const s = readStored(now);
  if (!s) return null;
  return `[work dashboard] ${s.text}${dayNow ? `\n${dayNow}` : ''}`;
}
