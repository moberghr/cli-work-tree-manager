import fs from 'node:fs';
import path from 'node:path';
import { getConfigDir } from './config.js';
import { atomicWriteFile } from './fs-safe.js';
import type { AssistantView, SessionWire } from './api-types.js';
import { DISPLAY_LABEL, displayStatus } from './session-view.js';

/**
 * The dashboard assistant (Ctrl+K): a persistent Claude session in the PTY
 * host, like any worktree's, with its own folder under ~/.work/assistant.
 *
 * That folder is written by work: a CLAUDE.md saying what it is for and how
 * to get the data (the `work … --json` commands), and a project
 * settings.json that pre-allows the read-only ones and installs a
 * UserPromptSubmit hook. The hook adds what the user is looking at in the
 * dashboard to every prompt (`work hook assistant-context`), so "clean these
 * up" or "why is this one blocked?" need no explaining.
 *
 * It runs in Claude Code's normal permission mode, never --unsafe: anything
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
 * Read-only commands it may run without asking. Exact forms for cleanup:
 * a `work cleanup --json:*` prefix rule would also allow `--apply`.
 */
export const ASSISTANT_ALLOW = [
  'Bash(work sessions:*)',
  'Bash(work digest:*)',
  'Bash(work overlaps:*)',
  'Bash(work cleanup --json)',
  'Bash(work cleanup --json --no-fetch)',
  'Bash(work cleanup --no-fetch --json)',
  'Bash(work list:*)',
  'Bash(work recent:*)',
];

const CLAUDE_MD = `# You are the work dashboard's assistant

The user opens you with Ctrl+K in \`work web\`, the dashboard over all their git worktrees and the Claude session in each. Help them make sense of it and act on it: what needs them, what each session did, what can be cleaned up, which sessions will conflict.

## Getting the data

Use the \`work\` CLI with \`--json\` (see the work-sessions skill) and parse it; don't guess from the filesystem:

- \`work sessions --json\` — every session: status (\`view.label\`), age, last active, context usage, archive state. \`--changes\` adds +N −M and same-file overlaps; \`--all\` adds older and archived ones.
- \`work digest --json --since today|yesterday|week\` — what each session did (prompts, turns, PRs).
- \`work overlaps --json\` — live sessions changing the same files.
- \`work cleanup --json\` — which worktrees can go, and why.

Each prompt comes with what the user is looking at in the dashboard (the tab, the selected session). When they say "this", "these" or "here", that is what they mean.

## Changing things

Ask before you change anything, and say exactly what will happen:
- Removing, archiving or forgetting worktrees: \`work cleanup --apply <id>… --action delete|archive|forget --json\`. Each is checked again right before it runs; report what was refused and why. Never \`--force\` unless the user asked for exactly that.
- Anything else (\`work remove\`, git, files in a worktree): only when asked, and show the command first.

Don't post on GitHub, and don't send prompts to other sessions, unless the user asks. Keep answers short: the user is in the middle of something.
`;

/** Write (or refresh) the assistant's folder; returns it. Idempotent. */
export function prepareAssistantDir(): string {
  const dir = assistantDir();
  fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
  atomicWriteFile(path.join(dir, 'CLAUDE.md'), CLAUDE_MD);
  // Project settings are ours; the user's "don't ask again" choices go to
  // .claude/settings.local.json, which this never touches.
  const settings = {
    permissions: { allow: ASSISTANT_ALLOW },
    hooks: {
      UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'work hook assistant-context', timeout: 5 }] }],
    },
  };
  atomicWriteFile(path.join(dir, '.claude', 'settings.json'), JSON.stringify(settings, null, 2) + '\n');
  return dir;
}

interface StoredContext {
  at: string;
  text: string;
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
      ...(session.diffStat?.files ? [`  Uncommitted: +${session.diffStat.added} −${session.diffStat.deleted} in ${session.diffStat.files} files.`] : []),
      ...(session.overlaps?.length ? [`  Changes the same files as: ${session.overlaps.map((o) => `${o.target} · ${o.branch}`).join(', ')}.`] : []),
      ...(session.context ? [`  Its conversation is ${Math.round((session.context.used / session.context.window) * 100)}% full.`] : []),
      ...(session.archivedAt ? ['  It is archived.'] : []),
      `  Worktree: ${session.paths.join(', ')}`,
    );
  }
  if (view.note) lines.push(view.note);
  return lines.join('\n');
}

export function writeAssistantContext(text: string, now = Date.now()): void {
  fs.mkdirSync(assistantDir(), { recursive: true });
  const stored: StoredContext = { at: new Date(now).toISOString(), text };
  atomicWriteFile(contextFile(), JSON.stringify(stored));
}

/** What the hook adds to a prompt; null when the dashboard said nothing lately. */
export function readAssistantContext(now = Date.now()): string | null {
  try {
    const raw = JSON.parse(fs.readFileSync(contextFile(), 'utf-8')) as unknown;
    const s = raw as Partial<StoredContext> | null;
    if (!s || typeof s.text !== 'string' || typeof s.at !== 'string') return null;
    if (now - Date.parse(s.at) > CONTEXT_TTL_MS) return null;
    return `[work dashboard] ${s.text}`;
  } catch {
    return null;
  }
}
