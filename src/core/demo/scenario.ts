import { createCommentStore, type CommentStore } from '../comment-store.js';
import type { ChatRecord } from '../chat-view.js';
import { parseGitDiff, type ParsedFile } from '../diff-parse.js';
import { findOverlaps } from '../overlap.js';
import { mergedParent, stackChildCounts, stackParents } from '../stack.js';
import { buildDigest } from '../digest.js';
import { cleanupVerdict } from '../cleanup-verdict.js';
import { createPresence, type Presence } from '../presence.js';
import { ciFixMessage } from '../pr-watch.js';
import type {
  ChecksState,
  DevServerState,
  SessionCi,
  MergeMethod,
  NotifyEvent,
  MergeSelection,
  RepoShipState,
  SessionAttention,
  SessionWire,
  ShipPr,
  ShipPreflight,
  ShipResult,
  PermissionRequest,
  DigestResponse,
  CleanupAction,
  CleanupCandidate,
  CleanupState,
  ChatSnapshot,
} from '../api-types.js';
import type { AgentState } from '../attention.js';
import type { PullRequestInfo } from '../pr.js';
import type { JiraIssue } from '../jira.js';
import type { Task } from '../tasks.js';

/**
 * The demo world: a handful of sessions, their diffs, PRs, comments and
 * terminals, living only in memory, plus a script of things that happen
 * over time (agents finishing, asking for permission) and simulated
 * effects for what the user does (answering, shipping, archiving).
 *
 * Pure state + transitions: no git, no files, no processes, no clock
 * reads except through the injected `now`. The demo server exposes it
 * through the same wire types as the real work web (api-types.ts) — if
 * the dashboard works against this, it depends only on that contract.
 */

// ---- the world ------------------------------------------------------------

interface DemoRepo {
  name: string;
  /** Unified diffs (`git diff` format) for the two diff scopes. */
  uncommitted: string;
  sinceBranch: string;
  published: boolean;
  pr: ShipPr | null;
  /** Unresolved review threads on the PR (simulated). */
  openThreads?: number;
}

interface DemoSession {
  id: string;
  /** Its $PORT, and whether a (simulated) dev server serves on it. */
  port: number;
  dev: 'stopped' | 'starting' | 'running';
  target: string;
  branch: string;
  isGroup: boolean;
  repos: DemoRepo[];
  createdAt: string;
  lastAccessedAt: string;
  attention: SessionAttention | null;
  archivedAt: string | null;
  comments: CommentStore;
  /** Terminal screen, one entry per line. */
  transcript: string[];
  /** The branch it was made from (a fork: the parent session's), for stacks. */
  baseBranch?: string;
  /** Archived with its worktree removed (merged and clean, as a real archive does): nothing left to clean up. */
  worktreeRemoved?: boolean;
}


/** The demo's sessions run Claude Code, with everything work can do with it. */
const DEMO_AGENT = { id: 'claude', name: 'Claude Code', can: { read: true, hooks: true, live: true, answer: true, chat: true } };

export type DemoEvent = { event: string; data: unknown };

/** A unified diff split into its per-file blocks (text kept verbatim). */
function fileBlocks(diff: string): string[] {
  return diff ? diff.split(/(?=^diff --git )/m).filter((b) => b.startsWith('diff --git ')) : [];
}
function blockPath(block: string): string {
  return parseGitDiff(block)[0]?.path ?? '';
}

// ---- canned content -------------------------------------------------------

function diffNew(file: string, lines: string[]): string {
  return [
    `diff --git a/${file} b/${file}`,
    'new file mode 100644',
    'index 0000000..1111111',
    '--- /dev/null',
    `+++ b/${file}`,
    `@@ -0,0 +1,${lines.length} @@`,
    ...lines.map((l) => '+' + l),
    '',
  ].join('\n');
}

function diffEdit(file: string, start: number, before: string[], after: string[], context: string[] = []): string {
  const oldLen = context.length + before.length;
  const newLen = context.length + after.length;
  return [
    `diff --git a/${file} b/${file}`,
    'index 1111111..2222222 100644',
    `--- a/${file}`,
    `+++ b/${file}`,
    `@@ -${start},${oldLen} +${start},${newLen} @@`,
    ...context.map((l) => ' ' + l),
    ...before.map((l) => '-' + l),
    ...after.map((l) => '+' + l),
    '',
  ].join('\n');
}

const AUTH_FIX = diffNew('src/auth.ts', [
  'export function afterLogin(returnTo: string | null): string {',
  '  // Only same-site paths: an absolute URL here was an open redirect,',
  "  // and '/login' itself caused the redirect loop.",
  "  if (!returnTo || !returnTo.startsWith('/') || returnTo.startsWith('//')) return '/';",
  "  if (returnTo.startsWith('/login')) return '/';",
  '  return returnTo;',
  '}',
]) + diffNew('src/auth.test.ts', [
  "import { afterLogin } from './auth';",
  '',
  "test('never redirects back to /login', () => {",
  "  expect(afterLogin('/login?next=/login')).toBe('/');",
  '});',
  '',
  "test('refuses absolute URLs', () => {",
  "  expect(afterLogin('https://evil.example')).toBe('/');",
  '});',
]);

const CSV_EXPORT = diffNew('src/invoices/export.ts', [
  "import type { Invoice } from './model';",
  '',
  'const HEADER = [\'number\', \'customer\', \'issued\', \'total\'];',
  '',
  'export function toCsv(invoices: Invoice[]): string {',
  "  const rows = invoices.map((i) => [i.number, quote(i.customer), i.issued, i.total.toFixed(2)]);",
  "  return [HEADER, ...rows].map((r) => r.join(',')).join('\\n');",
  '}',
  '',
  'function quote(s: string): string {',
  '  return /[",\\n]/.test(s) ? `"${s.replace(/"/g, \'""\')}"` : s;',
  '}',
]) + diffEdit(
  'src/invoices/routes.ts',
  12,
  ["router.get('/invoices', list);"],
  ["router.get('/invoices', list);", "router.get('/invoices.csv', exportCsv);"],
  ["router.get('/invoices/:id', show);"],
) + diffEdit(
  // The same file chore/deps-update bumps: the dashboard warns about it.
  'package.json',
  14,
  [],
  ['    "csv-stringify": "^6.5.0",'],
  ['  "dependencies": {'],
);

const SEARCH_FILTERS = diffEdit(
  'src/search/SearchPage.tsx',
  30,
  ['      <Results items={results} />'],
  ['      <Filters value={filters} onChange={setFilters} brands={brands} />', '      <Results items={applyFilters(results, filters)} />'],
  ['    <Page title="Search">'],
);

const CHECKOUT_BACKEND = diffNew('src/checkout/steps.ts', [
  "export type Step = 'address' | 'payment';",
  '',
  'export function nextStep(step: Step): Step | null {',
  "  return step === 'address' ? 'payment' : null;",
  '}',
]);
const CHECKOUT_FRONTEND = diffNew('src/checkout/CheckoutSteps.tsx', [
  "import { useState } from 'react';",
  '',
  'export function CheckoutSteps() {',
  "  const [step, setStep] = useState<'address' | 'payment'>('address');",
  "  return step === 'address' ? <Address onNext={() => setStep('payment')} /> : <Payment />;",
  '}',
]);

const DEPS = diffEdit(
  'package.json',
  14,
  ['    "express": "^4.19.2",', '    "zod": "^3.23.0"'],
  ['    "express": "^4.21.2",', '    "zod": "^3.24.1"'],
  ['  "dependencies": {'],
);

/** How full each demo conversation is (share of a 200k window). */
const DEMO_CONTEXT: Record<string, number> = {
  'feat/invoice-export': 0.38,
  'feat/checkout-v2': 0.84, // a long session: the dashboard suggests starting fresh
  'feat/search-filters': 0.21,
  'fix/login-redirect': 0.55,
  'chore/deps-update': 0.12,
};

const PERMISSION_BASH = 'Claude needs your permission to use Bash';
const PERMISSION_EDIT = 'Claude needs your permission to use Edit';

/** Canned final messages when a simulated turn finishes. */
const FINISH_MESSAGES: Record<string, string> = {
  'feat/invoice-export': 'Added GET /invoices.csv with RFC 4180 quoting and a test for commas in names.',
  'feat/search-filters': 'Price and brand filters are in; results update as you change them.',
  'feat/checkout-v2': 'Split checkout into address and payment steps in both repos; both build.',
  'chore/deps-update': 'Updated express and zod; all tests pass.',
};

// ---- scenario -------------------------------------------------------------

/** A scripted change at `at` ms after start. */
interface ScriptStep {
  at: number;
  run: (s: DemoScenario) => void;
}

export interface ScenarioOptions {
  now?: () => number;
  /** Scale for the scripted timeline and simulated turns (tests use 0). */
  speed?: number;
}

/** How far back the seeded world reaches (the oldest seeded prompt). */
const DEMO_HISTORY_MS = 6 * 3_600_000;

export class DemoScenario {
  /** Which demo tabs are looking at what (POST /api/presence). */
  readonly presence: Presence;
  readonly sessions = new Map<string, DemoSession>();
  private readonly listeners = new Set<(e: DemoEvent) => void>();
  private readonly now: () => number;

  /** The scenario's clock (simulated time), for the demo server's checks. */
  clockMs(): number {
    return this.now();
  }
  private readonly started: number;
  private readonly speed: number;
  private script: ScriptStep[] = [];
  private pending: Array<{ at: number; run: () => void }> = [];
  private tasks: Task[] = [];
  private nextTaskId = 1;
  private nextPr = 214;

  constructor(opts: ScenarioOptions = {}) {
    this.now = opts.now ?? Date.now;
    this.presence = createPresence(this.now);
    this.speed = opts.speed ?? 1;
    this.started = this.now();
    this.seed();
  }

  // -- events ---------------------------------------------------------------

  subscribe(cb: (e: DemoEvent) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  private emit(event: string, data: unknown = { ts: this.now() }): void {
    for (const cb of this.listeners) cb({ event, data });
  }

  private changed(): void {
    this.emit('sessions-changed');
  }

  /** Advance scripted and scheduled changes up to now. Call on an interval. */
  tick(): void {
    const t = this.now();
    const due = this.script.filter((s) => this.started + s.at * this.speed <= t);
    this.script = this.script.filter((s) => !due.includes(s));
    for (const s of due) s.run(this);
    const ready = this.pending.filter((p) => p.at <= t);
    this.pending = this.pending.filter((p) => !ready.includes(p));
    for (const p of ready) p.run();
  }

  private after(ms: number, run: () => void): void {
    this.pending.push({ at: this.now() + ms * this.speed, run });
  }

  // -- seed -----------------------------------------------------------------

  private iso(minutesAgo: number): string {
    return new Date(this.now() - minutesAgo * 60_000).toISOString();
  }

  private add(
    target: string,
    branch: string,
    repos: Array<Partial<DemoRepo> & { name: string }>,
    state: { state: AgentState; seen: boolean; summary: string; minutesAgo: number; request?: PermissionRequest } | null,
    transcript: string[],
    lastAccessedMinutesAgo = 30,
  ): DemoSession {
    const s: DemoSession = {
      id: `demo-${target}-${branch.replace(/[^a-z0-9]+/gi, '-')}`,
      target,
      branch,
      isGroup: repos.length > 1,
      repos: repos.map((r) => ({ uncommitted: '', sinceBranch: '', published: false, pr: null, ...r })),
      createdAt: this.iso(lastAccessedMinutesAgo + 60),
      lastAccessedAt: this.iso(lastAccessedMinutesAgo),
      attention: state
        ? {
            state: state.state, seen: state.seen, since: this.iso(state.minutesAgo), summary: state.summary,
            updatedAt: this.iso(state.minutesAgo), stale: false, ...(state.request ? { request: state.request } : {}),
          }
        : null,
      archivedAt: null,
      comments: createCommentStore(),
      transcript,
      port: 3000 + this.sessions.size * 7,
      dev: 'stopped',
    };
    this.sessions.set(s.id, s);
    return s;
  }

  private seed(): void {
    this.add(
      'api', 'feat/invoice-export',
      [{ name: 'api', uncommitted: CSV_EXPORT, sinceBranch: CSV_EXPORT }],
      { state: 'needs_input', seen: false, summary: PERMISSION_BASH, minutesAgo: 4, request: { tool: 'Bash', detail: 'npm test -- invoices' } },
      claudeScreen('Add CSV export to the invoices endpoint', [
        '● Read(src/invoices/routes.ts)',
        '● Write(src/invoices/export.ts)',
        '● I will run the invoice tests to check the quoting.',
        '',
        '  Bash command: npm test -- invoices',
        '  Do you want to proceed?',
        '  ❯ 1. Yes',
        "    2. Yes, and don't ask again for npm test",
        '    3. No, tell Claude what to do differently',
      ]),
      8,
    );
    const login = this.add(
      'web', 'fix/login-redirect',
      [{ name: 'web', uncommitted: AUTH_FIX, sinceBranch: AUTH_FIX }],
      { state: 'idle', seen: false, summary: 'Fixed the redirect loop after login and added a regression test.', minutesAgo: 11 },
      claudeScreen('Fix the redirect loop after login', [
        '● Read(src/auth.ts)',
        '● Update(src/auth.ts)',
        '● Write(src/auth.test.ts)',
        '● Bash(npm test -- auth)  ⎿  2 passed',
        '',
        '● Fixed the redirect loop after login and added a regression test.',
      ]),
      15,
    );
    login.comments.post({
      repo: 'web', file: 'src/auth.ts', line: 4, side: 'right',
      body: "Does this also cover '//evil.example' (protocol-relative)?",
      author: 'user', status: 'published',
    });
    this.add(
      'shop', 'feat/checkout-v2',
      [
        { name: 'backend', uncommitted: '', sinceBranch: CHECKOUT_BACKEND, published: true },
        { name: 'frontend', uncommitted: CHECKOUT_FRONTEND, sinceBranch: CHECKOUT_FRONTEND },
      ],
      { state: 'working', seen: true, summary: 'Split checkout into address and payment steps', minutesAgo: 2 },
      claudeScreen('Split checkout into address and payment steps', [
        '● Write(backend/src/checkout/steps.ts)',
        '● Write(frontend/src/checkout/CheckoutSteps.tsx)',
        '✻ Wiring the steps into the checkout page…  (esc to interrupt)',
      ]),
      5,
    );
    this.add(
      'web', 'feat/search-filters',
      [{ name: 'web', uncommitted: SEARCH_FILTERS, sinceBranch: SEARCH_FILTERS }],
      { state: 'working', seen: true, summary: 'Add price and brand filters to search', minutesAgo: 1 },
      claudeScreen('Add price and brand filters to search', [
        '● Read(src/search/SearchPage.tsx)',
        '● Update(src/search/SearchPage.tsx)',
        '✻ Adding the brand list…  (esc to interrupt)',
      ]),
      3,
    );
    this.add(
      'api', 'chore/deps-update',
      [{
        name: 'api', uncommitted: '', sinceBranch: DEPS, published: true,
        pr: { number: 212, url: 'https://github.com/example/api/pull/212', state: 'OPEN', isDraft: false, mergeStateStatus: 'UNSTABLE', checks: 'fail', headSha: 'c0ffee1234ab',
          failing: [{ name: 'test (node 22)', url: 'https://github.com/example/api/actions/runs/1' }, { name: 'typecheck' }] },
        openThreads: 2,
      }],
      { state: 'idle', seen: true, summary: FINISH_MESSAGES['chore/deps-update'], minutesAgo: 50 },
      claudeScreen('Update dependencies', ['● Bash(npm outdated)', '● Update(package.json)', '● Bash(npm test)  ⎿  84 passed', '', '● ' + FINISH_MESSAGES['chore/deps-update']]),
      55,
    );
    this.add('web', 'spike/dark-mode', [{ name: 'web' }], null, claudeScreen('', []), 60 * 24 * 40);
    // A fork of the invoice export, stacked on it (and two commits behind it).
    this.add(
      'api', 'feat/invoice-pdf',
      [{ name: 'api' }],
      { state: 'idle', seen: true, summary: 'PDF layout drafted; waiting for the CSV columns to settle.', minutesAgo: 90 },
      claudeScreen('Add a PDF variant of the invoice export', ['● Read(src/invoices/export.ts)', '● Write(src/invoices/pdf.ts)', '', '● PDF layout drafted; waiting for the CSV columns to settle.']),
      95,
    ).baseBranch = 'feat/invoice-export';
    // A parent that merged (archived), and the session still stacked on it: Move onto main.
    const taxes = this.add(
      'api', 'feat/tax-rates',
      [{ name: 'api', published: true, pr: { number: 205, url: 'https://github.com/example/api/pull/205', state: 'MERGED', isDraft: false, mergeStateStatus: 'CLEAN', checks: 'pass', headSha: 'tax0001aa' } }],
      null, claudeScreen('', []), 60 * 26,
    );
    taxes.archivedAt = this.iso(60 * 20);
    taxes.worktreeRemoved = true;
    this.add(
      'api', 'feat/tax-report',
      [{ name: 'api' }],
      { state: 'idle', seen: true, summary: 'Tax report endpoint ready; built on the tax rates branch.', minutesAgo: 60 * 3 },
      claudeScreen('Add a tax report on top of the new rates', ['● Write(src/tax/report.ts)', '', '● Tax report endpoint ready; built on the tax rates branch.']),
      60 * 3,
    ).baseBranch = 'feat/tax-rates';

    this.tasks = [
      { id: this.nextTaskId++, text: 'Rate-limit the public invoices API', done: false, createdAt: this.iso(300) },
      { id: this.nextTaskId++, text: 'Remove the old checkout feature flag', done: false, createdAt: this.iso(900) },
      { id: this.nextTaskId++, text: 'Write release notes for 3.4', done: true, createdAt: this.iso(2000), doneAt: this.iso(200) },
    ];

    // The day moves on while you look: agents finish and ask for things.
    this.script = [
      {
        at: 20_000,
        run: (s) => s.setState('demo-web-feat-search-filters', 'needs_input', PERMISSION_EDIT, { tool: 'Edit', detail: 'src/search/BrandFilter.tsx' }),
      },
      { at: 45_000, run: (s) => s.finishTurn('demo-shop-feat-checkout-v2') },
    ];
  }

  // -- state changes --------------------------------------------------------

  private setState(id: string, state: AgentState, summary?: string, request?: PermissionRequest): void {
    const s = this.sessions.get(id);
    if (!s || s.archivedAt) return;
    const ts = new Date(this.now()).toISOString();
    const seen = state === 'working' ? true : false;
    const prev = s.attention?.state;
    s.attention = {
      state,
      seen,
      since: s.attention?.state === state ? s.attention.since : ts,
      summary: summary ?? s.attention?.summary,
      updatedAt: ts,
      stale: false,
      ...(state === 'needs_input' && request ? { request } : {}),
    };
    if (state === 'needs_input' && summary) {
      s.transcript.push('', `  ${summary.replace('Claude needs your permission to use ', '')} — do you want to proceed?`, '  ❯ 1. Yes', '    2. No, tell Claude what to do differently');
    }
    // Same discipline as the real server: notify only if nobody is looking.
    const kind = state === 'needs_input' && prev !== 'needs_input' ? 'needs_input' : state === 'idle' && prev === 'working' ? 'idle' : null;
    if (kind && this.presence.route(id) !== 'none') {
      const event: NotifyEvent = {
        sessionId: id,
        kind,
        title: `${kind === 'needs_input' ? 'Needs your input' : 'Finished'} — ${s.target} · ${s.branch}`,
        body: s.attention.summary,
      };
      this.emit('notify', event);
    }
    this.changed();
  }

  private finishTurn(id: string): void {
    const s = this.sessions.get(id);
    if (!s) return;
    const msg = FINISH_MESSAGES[s.branch] ?? 'Done.';
    s.transcript.push('', `● ${msg}`);
    this.emitTerminal(id, `\r\n\r\n● ${msg}\r\n`);
    this.setState(id, 'idle', msg);
  }

  /** Allow / Deny from the inbox. Same refusals as the real route: an
   *  error message when there's nothing (or something else) to answer. */
  answer(id: string, answer: 'allow' | 'deny', request: PermissionRequest | undefined): string | null {
    const s = this.sessions.get(id);
    const req = s?.attention?.state === 'needs_input' ? s.attention.request : undefined;
    if (!s || !req) return 'Nothing to answer — it has moved on.';
    if (request?.tool !== req.tool || request?.detail !== req.detail) return 'The request changed since you saw it. Look again before answering.';
    if (answer === 'deny') {
      s.transcript.push('  ⎿  User rejected the request');
      this.emitTerminal(id, '\r\n  ⎿  User rejected the request\r\n> ');
      this.setState(id, 'idle', `Denied ${req.tool}: ${req.detail} — tell Claude what to do instead`);
      this.markSeen(id);
      return null;
    }
    s.transcript.push(`● Allowed ${req.tool}(${req.detail})`);
    this.setState(id, 'working', `Allowed ${req.tool}: ${req.detail}`);
    this.emitTerminal(id, `\r\n● ${req.tool}(${req.detail})\r\n✻ Working…\r\n`);
    this.after(8_000, () => this.finishTurn(id));
    return null;
  }

  /** The user typed a line into a session's terminal. */
  input(id: string, line: string): void {
    if (id === 'assistant') {
      const text = line.trim();
      if (!text) return;
      const reply = [
        '',
        `● (demo) You're on ${this.assistantView}. In the real dashboard I'd run`,
        '  `work sessions --json` and answer here; anything that changes things',
        '  asks you first.',
        '',
      ];
      this.assistantLines.push(`> ${text}`, ...reply);
      this.emitTerminal(id, `\r\n${reply.join('\r\n')}\r\n> `);
      return;
    }
    const s = this.sessions.get(id);
    if (!s) return;
    const text = line.trim();
    s.transcript.push(`> ${text}`);
    const answered = s.attention?.state === 'needs_input';
    this.setState(id, 'working', answered ? s.attention?.summary?.replace('Claude needs your permission to use', 'Continuing after') : text || 'Working');
    const reply = answered ? '● Thanks — continuing.' : '● On it.';
    s.transcript.push(reply);
    this.emitTerminal(id, `\r\n${reply}\r\n✻ Working…\r\n`);
    this.after(8_000, () => this.finishTurn(id));
  }

  /**
   * The session as a chat: the simulated terminal's `> ` lines are your
   * messages, `● Tool(args)` lines tool calls, other `●` lines the agent's
   * text — as the chat records (chat-view.ts) the real chat route serves.
   */
  chatSnapshot(id: string): ChatSnapshot | null {
    const s = this.sessions.get(id);
    if (!s) return null;
    const lines: ChatRecord[][] = [];
    let n = 0;
    for (const line of s.transcript) {
      if (line.startsWith('> ') && line.length > 2) {
        lines.push([{ kind: 'you', text: line.slice(2) }]);
        continue;
      }
      const tool = /^● (\w+)\((.*)\)$/.exec(line);
      if (tool) {
        const toolId = `demo-tool-${n++}`;
        lines.push([{ kind: 'tool', id: toolId, name: tool[1], input: { args: tool[2] } }]);
        lines.push([{ kind: 'tool-result', toolId, text: 'ok (simulated)', isError: false }]);
        continue;
      }
      if (line.startsWith('● ')) lines.push([{ kind: 'text', text: line.slice(2) }]);
    }
    const state = s.attention?.state === 'working' ? 'working' : s.attention?.state === 'needs_input' ? 'needs_input' : 'idle';
    return {
      sessionId: id,
      state,
      error: null,
      conversationId: `demo-${id}`,
      messages: lines.map((records, seq) => ({ seq, records })),
      partial: null,
      permissions: [],
      terminalRunning: false,
    };
  }

  /** A chat message: the same simulated turn as typing it in the terminal. */
  chatSend(id: string, text: string): boolean {
    if (!this.sessions.has(id)) return false;
    this.input(id, text);
    this.emit('chat-changed', { sessionId: id });
    return true;
  }

  private terminalListeners = new Map<string, Set<(data: string) => void>>();

  onTerminal(id: string, cb: (data: string) => void): () => void {
    const set = this.terminalListeners.get(id) ?? new Set();
    set.add(cb);
    this.terminalListeners.set(id, set);
    return () => set.delete(cb);
  }

  private emitTerminal(id: string, data: string): void {
    for (const cb of this.terminalListeners.get(id) ?? []) cb(data);
  }

  /** The Ctrl+K assistant's simulated terminal (the real one is a Claude
   *  session in the PTY host; see core/assistant.ts). */
  private assistantLines = [
    '╭──────────────────────────────────────────────╮',
    '│ ✻ Claude Code  ·  dashboard assistant (demo) │',
    '╰──────────────────────────────────────────────╯',
    '',
    '  Ask about your sessions: what needs you, what each did today,',
    '  what can be cleaned up, which ones touch the same files.',
    '',
  ];
  private assistantView = 'the dashboard';

  /** What the dashboard says it shows (POST /api/assistant/context). */
  setAssistantView(text: string): void {
    this.assistantView = text;
  }

  screen(id: string): string {
    if (id === 'assistant') return this.assistantLines.join('\r\n') + '\r\n> ';
    return (this.sessions.get(id)?.transcript ?? []).join('\r\n') + '\r\n';
  }

  // -- reads (wire shapes) --------------------------------------------------

  list(): SessionWire[] {
    const all = [...this.sessions.values()];
    const wires = all.map((s) => this.wire(s));
    // Same rule as work web: live sessions changing the same file of a repo.
    const overlaps = findOverlaps(
      all
        .filter((s) => !s.archivedAt)
        .map((s) => ({
          id: s.id,
          target: s.target,
          branch: s.branch,
          touched: s.repos.map((r) => ({
            repoKey: r.name,
            name: r.name,
            files: [...new Set([...parseGitDiff(r.sinceBranch), ...parseGitDiff(r.uncommitted)].map((f) => f.path))],
          })),
        })),
    );
    // Same rule as work web: made from another live session's branch = stacked on it.
    const parents = stackParents(wires);
    const children = stackChildCounts(parents);
    for (const w of wires) {
      const p = parents.get(w.id);
      if (p) {
        w.stackedOn = { id: p.id, branch: p.branch };
        // The parent moved on since the fork: shown as work web would.
        w.behind = { base: p.branch, commits: 2, conflicts: false, stacked: true };
      }
      if (children.get(w.id)) w.stackedChildren = children.get(w.id);
      // Its parent merged and was archived: "Move onto main".
      const merged = p ? null : mergedParent(w, wires, undefined, (x) => this.sessions.get(x.id)?.repos.some((r) => r.pr?.state === 'MERGED') ?? false);
      if (merged) w.stackParentMerged = { id: merged.id, branch: merged.branch };
    }
    for (const w of wires) {
      const o = overlaps.get(w.id);
      if (o) w.overlaps = o;
    }
    return wires;
  }

  wire(s: DemoSession): SessionWire {
    const comments = s.comments.snapshot();
    const stat = this.diffStat(s);
    return {
      agent: DEMO_AGENT,
      id: s.id,
      target: s.target,
      branch: s.branch,
      isGroup: s.isGroup,
      paths: s.repos.map((r) => `~/worktrees/${s.target}/${s.branch.replace(/\//g, '-')}${s.isGroup ? '/' + r.name : ''}`),
      createdAt: s.createdAt,
      lastAccessedAt: s.lastAccessedAt,
      draftCount: comments.filter((c) => c.status === 'draft').length,
      commentCount: comments.length,
      claudeCount: comments.filter((c) => c.author === 'claude').length,
      ptyStatus: s.attention?.state === 'working' || s.attention?.state === 'needs_input' ? 'running' : 'idle',
      lastActivity: s.attention ? Date.parse(s.attention.updatedAt) : null,
      activityState: s.attention?.state === 'working' ? 'active' : s.attention ? 'open' : 'stale',
      pendingForClaudeCount: 0,
      attention: s.attention,
      diffStat: stat.files ? stat : null,
      archivedAt: s.archivedAt,
      port: s.port,
      ...(s.baseBranch ? { baseBranch: s.baseBranch } : {}),
      context: DEMO_CONTEXT[s.branch] ? { used: Math.round(DEMO_CONTEXT[s.branch] * 200_000), window: 200_000, model: 'claude-sonnet-5' } : null,
      ...(this.reviewThreads(s) > 0 ? { openReviewThreads: this.reviewThreads(s) } : {}),
    };
  }

  /** Unresolved review threads on its open PRs, as the PR watch counts them. */
  private reviewThreads(s: DemoSession): number {
    return s.archivedAt ? 0 : s.repos.reduce((n, r) => n + (r.pr?.state === 'OPEN' ? (r.openThreads ?? 0) : 0), 0);
  }

  private diffStat(s: DemoSession): { added: number; deleted: number; files: number } {
    let added = 0;
    let deleted = 0;
    let files = 0;
    for (const r of s.repos) {
      for (const f of parseGitDiff(r.uncommitted)) {
        files++;
        added += f.added;
        deleted += f.deleted;
      }
    }
    return { added, deleted, files };
  }

  diff(id: string, base: 'uncommitted' | 'branch'): { sessionId: string; base: string; resolvedBase: string; repos: Array<{ name: string; root: string; files: ParsedFile[]; resolvedBase: string }> } | null {
    const s = this.sessions.get(id);
    if (!s) return null;
    const resolvedBase = base === 'uncommitted' ? 'HEAD' : 'origin/main';
    return {
      sessionId: id,
      base,
      resolvedBase,
      repos: s.repos.map((r) => ({
        name: r.name,
        root: `~/worktrees/${s.target}/${r.name}`,
        files: parseGitDiff(base === 'uncommitted' ? r.uncommitted : r.sinceBranch),
        resolvedBase,
      })),
    };
  }

  /**
   * Simulated per-turn checkpoints: a baseline plus one step per
   * instruction. Turn 1 wrote all but each repo's last uncommitted file;
   * turn 2 wrote that last file. Sessions with nothing uncommitted have
   * only the baseline (so "Last turn" is disabled there).
   */
  checkpoints(id: string): Array<{ id: number; ts: string; label?: string; repos: Record<string, string | null> }> | null {
    const s = this.sessions.get(id);
    if (!s) return null;
    const repos = Object.fromEntries(s.repos.map((r) => [r.name, null]));
    const base = Date.parse(s.lastAccessedAt);
    const at = (minsAgo: number) => new Date(base - minsAgo * 60_000).toISOString();
    const entries: Array<{ id: number; ts: string; label?: string; repos: Record<string, string | null> }> = [
      { id: 0, ts: at(40), label: 'Initial', repos },
    ];
    if (s.repos.some((r) => r.uncommitted)) {
      entries.push({ id: 1, ts: at(25), label: 'Implemented the change', repos });
      entries.push({ id: 2, ts: at(5), label: 'Addressed review feedback', repos });
    }
    return entries;
  }

  /** The files a checkpoint range changed — see checkpoints(). */
  rangeDiff(id: string, from: number, to: number): { sessionId: string; base: string; resolvedBase: string; repos: Array<{ name: string; root: string; files: ParsedFile[]; resolvedBase: string }> } | null {
    const s = this.sessions.get(id);
    if (!s) return null;
    const lo = Math.max(0, Math.min(from, to));
    const hi = Math.min(2, Math.max(from, to));
    return {
      sessionId: id,
      base: 'range',
      resolvedBase: `checkpoint ${lo}`,
      repos: s.repos.map((r) => {
        const files = parseGitDiff(r.uncommitted);
        const inTurn = (i: number) => (i === files.length - 1 ? 2 : 1);
        return {
          name: r.name,
          root: `~/worktrees/${s.target}/${r.name}`,
          files: files.filter((_, i) => inTurn(i) > lo && inTurn(i) <= hi),
          resolvedBase: `checkpoint ${lo}`,
        };
      }),
    };
  }

  /**
   * Simulated revert: drop the file (or the hunks overlapping new-side
   * lines [start, end]) from the uncommitted diff — and from the branch
   * diff too while it's the same uncommitted work — then leave Claude the
   * same note the real server does.
   */
  revert(id: string, req: { repo: string; path: string; lines?: { start: number; end: number } }): { ok: true; description: string } | { ok: false; status: 404 | 409; error: string } {
    const s = this.sessions.get(id);
    const r = s?.repos.find((x) => x.name === req.repo);
    if (!s || !r) return { ok: false, status: 404, error: 'unknown session or repo' };
    const block = fileBlocks(r.uncommitted).find((b) => blockPath(b) === req.path);
    if (!block) return { ok: false, status: 409, error: 'that file has no uncommitted change any more — reload the diff' };
    let next = '';
    if (req.lines) {
      const { start, end } = req.lines;
      const at = block.search(/^@@ /m);
      const hunks = block.slice(at).split(/(?=^@@ )/m);
      const keep = hunks.filter((h) => {
        const m = h.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/);
        if (!m) return true;
        const from = Number(m[1]);
        const to = from + Math.max(m[2] === undefined ? 1 : Number(m[2]), 1) - 1;
        return !(from <= end && to >= start);
      });
      if (keep.length === hunks.length) return { ok: false, status: 409, error: 'that change is no longer in the file — reload the diff' };
      next = keep.length ? block.slice(0, at) + keep.join('') : '';
    }
    if (r.sinceBranch.includes(block)) r.sinceBranch = r.sinceBranch.replace(block, next);
    r.uncommitted = r.uncommitted.replace(block, next);
    const where = s.isGroup ? `${r.name}/${req.path}` : req.path;
    const what = req.lines ? `lines ${req.lines.start}–${req.lines.end} of \`${where}\`` : `\`${where}\``;
    s.comments.post({ side: 'general', status: 'published', body: `I reverted your uncommitted change to ${what} (back to HEAD). Leave it that way — don't reintroduce it unless I ask.` });
    this.emit('comments-changed', { sessionId: id });
    this.emit('diff-changed', { sessionId: id });
    this.changed();
    return { ok: true, description: `reverted ${req.path}` };
  }

  comments(id: string): CommentStore | null {
    return this.sessions.get(id)?.comments ?? null;
  }

  // -- CI (the PR watch, simulated) ------------------------------------------

  /** The Today digest, through the same builder as work web: the demo's
   *  prompts are the `> …` lines of its simulated terminals. */
  digest(sinceMs: number): DigestResponse {
    // The world is seeded up to a few hours back; "since midnight" asked
    // just after midnight would cut it off, and Today would show a demo
    // with nothing in it.
    sinceMs = Math.min(sinceMs, this.started - DEMO_HISTORY_MS);
    const inputs = [...this.sessions.values()].map((s) => ({
      sessionId: s.id,
      target: s.target,
      branch: s.branch,
      isGroup: s.isGroup,
      lastAccessedAt: s.lastAccessedAt,
      archivedAt: s.archivedAt,
      status: s.attention ? { state: s.attention.state, summary: s.attention.summary, updatedAt: s.attention.updatedAt } : null,
      transcripts: [
        s.transcript
          .filter((l) => l.startsWith('> ') && l.length > 2)
          .map((l, i) => ({
            role: 'you' as const,
            // The first prompt started the session; later ones came as you went.
            at: i === 0 ? s.createdAt : s.attention?.since ?? s.lastAccessedAt,
            text: l.slice(2),
          })),
      ],
      checkpoints: this.checkpoints(s.id) ?? [],
      diffStat: this.diffStat(s).files ? this.diffStat(s) : null,
      ci: this.ci(s.id),
    }));
    return {
      since: new Date(sinceMs).toISOString(),
      generatedAt: new Date(this.now()).toISOString(),
      sessions: buildDigest(inputs, sinceMs),
    };
  }

  ci(id: string): SessionCi | null {
    const s = this.sessions.get(id);
    if (!s) return null;
    return {
      checkedAt: new Date(this.now()).toISOString(),
      repos: s.repos.map((r) => ({
        name: r.name,
        pr: r.pr,
        done: r.pr?.state === 'MERGED',
        ...(r.pr?.state === 'OPEN' && r.openThreads ? { openThreads: r.openThreads } : {}),
      })),
    };
  }

  /** "Ask Claude to fix CI": the note goes in, Claude answers, pushes, and
   *  the checks re-run green. */
  fixCi(id: string): boolean {
    const s = this.sessions.get(id);
    if (!s) return false;
    const failing = s.repos
      .filter((r) => r.pr?.state === 'OPEN' && r.pr.checks === 'fail')
      .map((r) => ({ repo: r.name, number: r.pr!.number, checks: (r.pr!.failing ?? []).map((f) => f.name) }));
    if (!failing.length) return false;
    const note = s.comments.post({ side: 'general', status: 'published', body: ciFixMessage(failing, s.isGroup) });
    this.emit('comments-changed', { sessionId: id });
    this.setState(id, 'working', 'Fix the failing CI checks');
    this.after(3_000, () => {
      s.comments.post({ body: 'The node 22 run failed on a removed `Buffer.slice` overload — switched to `subarray`, fixed the type error, pushed.', parentId: note.id, author: 'claude', status: 'published' });
      for (const r of s.repos) {
        if (r.pr?.checks === 'fail') r.pr = { ...r.pr, checks: 'pending', mergeStateStatus: 'BLOCKED', headSha: 'f1x' + r.pr.headSha.slice(3), failing: undefined };
      }
      this.emit('comments-changed', { sessionId: id });
      this.emit('ci-changed', { sessionId: id });
      this.setState(id, 'idle', 'Fixed the CI failures and pushed.');
    });
    this.after(7_000, () => {
      for (const r of s.repos) if (r.pr?.checks === 'pending') r.pr = { ...r.pr, checks: 'pass', mergeStateStatus: 'CLEAN' };
      this.emit('ci-changed', { sessionId: id });
      this.changed();
    });
    return true;
  }

  // -- dev server (simulated: a start comes up a moment later) --------------

  devState(id: string): DevServerState | null {
    const s = this.sessions.get(id);
    if (!s) return null;
    return {
      port: s.port,
      listening: s.dev === 'running',
      url: `http://localhost:${s.port}/`,
      command: 'npm run dev',
      repo: s.repos[s.repos.length - 1].name,
      running: s.dev === 'stopped' ? null : { pid: 40_000 + s.port, startedAt: new Date(this.now()).toISOString() },
    };
  }

  devStart(id: string): boolean {
    const s = this.sessions.get(id);
    if (!s || s.dev !== 'stopped') return false;
    s.dev = 'starting';
    this.after(1_500, () => {
      if (s.dev !== 'starting') return;
      s.dev = 'running';
      this.emit('dev-changed', { sessionId: id });
    });
    this.emit('dev-changed', { sessionId: id });
    return true;
  }

  devStop(id: string): boolean {
    const s = this.sessions.get(id);
    if (!s || s.dev === 'stopped') return false;
    s.dev = 'stopped';
    this.emit('dev-changed', { sessionId: id });
    return true;
  }

  /** A user comment gets a simulated reply from Claude a few seconds later. */
  replyLater(id: string, commentId: string): void {
    this.after(4_000, () => {
      const store = this.comments(id);
      if (!store) return;
      store.post({ body: 'Good catch — updated it and added a test for that case.', parentId: commentId, author: 'claude', status: 'published' });
      this.emit('comments-changed', { sessionId: id });
      this.changed();
    });
  }

  markSeen(id: string): boolean {
    const s = this.sessions.get(id);
    if (!s) return false;
    if (s.attention && !s.attention.seen) {
      s.attention = { ...s.attention, seen: true };
      this.changed();
    }
    return true;
  }

  setArchived(id: string, archived: boolean): boolean {
    const s = this.sessions.get(id);
    if (!s) return false;
    s.archivedAt = archived ? new Date(this.now()).toISOString() : null;
    this.changed();
    return true;
  }

  remove(id: string): boolean {
    const ok = this.sessions.delete(id);
    if (ok) this.changed();
    return ok;
  }

  // -- cleanup (simulated: an instant scan over the demo's own sessions) ----

  private cleanupState: CleanupState = { phase: 'idle', done: 0, total: 0, candidates: [], results: [] };

  cleanup(): CleanupState {
    return this.cleanupState;
  }

  /** Sessions quiet for a day or more: merged if a PR merged or it never
   *  changed anything, else work of its own (archived after a week). */
  cleanupScan(): CleanupState {
    const now = this.now();
    const candidates: CleanupCandidate[] = [];
    for (const s of this.sessions.values()) {
      if (s.worktreeRemoved) continue;
      const lastActiveMs = Math.max(Date.parse(s.lastAccessedAt), s.attention ? Date.parse(s.attention.updatedAt) : 0);
      const repos = s.repos.map((r) => {
        const own = parseGitDiff(r.sinceBranch).length > 0 && r.pr?.state !== 'MERGED';
        return {
          name: r.name, path: `~/worktrees/${s.target}/${s.branch.replace(/\//g, '-')}`, exists: true, readable: true,
          dirty: r.uncommitted && r.uncommitted !== r.sinceBranch ? parseGitDiff(r.uncommitted).length : 0,
          ahead: own ? 1 : 0, merged: own ? null : ('contained' as const), base: 'origin/HEAD', baseCheckout: false,
        };
      });
      const v = cleanupVerdict({ repos, lastActiveMs, archived: !!s.archivedAt }, now);
      if (v.verdict === 'keep') continue;
      candidates.push({
        sessionId: s.id, target: s.target, branch: s.branch, isGroup: s.isGroup,
        lastActive: new Date(lastActiveMs).toISOString(), archivedAt: s.archivedAt, ...v, repos,
      });
    }
    this.cleanupState = { phase: 'idle', done: this.sessions.size, total: this.sessions.size, candidates, results: [], finishedAt: new Date(now).toISOString() };
    return this.cleanupState;
  }

  cleanupApply(items: Array<{ sessionId: string; action: CleanupAction }>): CleanupState {
    const results: CleanupState['results'] = [];
    for (const it of items) {
      const c = this.cleanupState.candidates.find((x) => x.sessionId === it.sessionId);
      const s = this.sessions.get(it.sessionId);
      if (!c || !s || (it.action === 'delete' && c.verdict !== 'merged')) {
        results.push({ ...it, ok: false, message: c ? `Not removed: ${c.reason}.` : 'The session is gone already.' });
        continue;
      }
      if (it.action === 'archive') s.archivedAt = new Date(this.now()).toISOString();
      else this.sessions.delete(it.sessionId);
      results.push({ ...it, ok: true, message: it.action === 'delete' ? 'Worktree removed' : it.action === 'archive' ? 'Archived' : 'Forgotten' });
    }
    const ok = new Set(results.filter((r) => r.ok).map((r) => r.sessionId));
    this.cleanupState = { ...this.cleanupState, results, candidates: this.cleanupState.candidates.filter((c) => !ok.has(c.sessionId)) };
    this.changed();
    return this.cleanupState;
  }

  /** Move onto main (simulated): it is based on main now, so no longer stacked. */
  retarget(id: string): boolean {
    const s = this.sessions.get(id);
    if (!s) return false;
    s.baseBranch = 'main';
    this.changed();
    return true;
  }

  create(target: string, branch: string, prompt?: string, baseBranch?: string): SessionWire {
    const project = this.projects();
    const group = project.groups.find((g) => g.name === target);
    const first = prompt?.split('\n')[0];
    const s = this.add(
      target,
      branch,
      (group?.members ?? [target]).map((name) => ({ name })),
      { state: 'working', seen: true, summary: first ?? 'Getting started', minutesAgo: 0 },
      claudeScreen(first ?? '', ['✻ Reading the codebase…']),
      0,
    );
    if (baseBranch) s.baseBranch = baseBranch;
    this.changed();
    return this.wire(s);
  }

  // -- ship -----------------------------------------------------------------

  private repoState(s: DemoSession, r: DemoRepo): RepoShipState {
    const commits = r.sinceBranch ? 1 : 0;
    const dirtyFiles = r.uncommitted && r.uncommitted !== r.sinceBranch ? parseGitDiff(r.uncommitted).length : 0;
    const done = r.pr?.state === 'MERGED' || (!r.pr && commits === 0);
    const blockers: string[] = [];
    if (!done) {
      if (dirtyFiles) blockers.push(`${dirtyFiles} uncommitted file${dirtyFiles === 1 ? '' : 's'} — commit or stash first`);
      if (!r.published) blockers.push('branch not pushed yet');
      if (!r.pr) blockers.push('no pull request');
      else {
        if (r.pr.isDraft) blockers.push('pull request is a draft');
        if (r.pr.checks === 'pending') blockers.push('checks still running');
        if (r.pr.checks === 'fail') blockers.push('checks failing');
      }
    }
    return {
      name: s.isGroup ? r.name : s.target,
      path: `~/worktrees/${s.target}/${r.name}`,
      branch: s.branch,
      localSha: r.pr?.headSha ?? 'a1b2c3d4e5f6',
      dirtyFiles,
      hasUpstream: r.published,
      tracksRemote: r.published,
      ahead: r.published ? 0 : null,
      behind: r.published ? 0 : null,
      pr: r.pr,
      done,
      doneReason: done ? (r.pr ? 'merged' : 'untouched') : undefined,
      mergeBlockers: blockers,
      commitsVsBase: commits,
    };
  }

  preflight(id: string): ShipPreflight | null {
    const s = this.sessions.get(id);
    return s ? { repos: s.repos.map((r) => this.repoState(s, r)) } : null;
  }

  ship(id: string, action: 'push' | 'create-pr', draft = false): ShipResult[] | null {
    const s = this.sessions.get(id);
    if (!s) return null;
    const out = s.repos.map((r): ShipResult => {
      const name = s.isGroup ? r.name : s.target;
      if (r.pr?.state === 'MERGED' || !r.sinceBranch) return { repo: name, ok: true, message: 'nothing to do' };
      if (action === 'push' || !r.published) r.published = true;
      if (action === 'push') return { repo: name, ok: true, message: 'pushed' };
      if (r.pr?.state === 'OPEN') return { repo: name, ok: true, message: `PR #${r.pr.number} already open`, url: r.pr.url };
      const number = this.nextPr++;
      r.pr = {
        number,
        url: `https://github.com/example/${name}/pull/${number}`,
        state: 'OPEN',
        isDraft: draft,
        mergeStateStatus: 'CLEAN',
        checks: 'pending' as ChecksState,
        headSha: (number.toString(16) + 'abcdef1234').slice(0, 12),
      };
      const pr = r.pr;
      this.after(6_000, () => {
        pr.checks = 'pass';
        this.changed();
      });
      return { repo: name, ok: true, message: draft ? 'draft PR opened' : 'PR opened', url: r.pr.url };
    });
    this.changed();
    return out;
  }

  merge(id: string, selection: MergeSelection[], method: MergeMethod): { results: ShipResult[]; archived: boolean; allDone: boolean } | null {
    const s = this.sessions.get(id);
    if (!s) return null;
    const states = new Map(s.repos.map((r) => [this.repoState(s, r).name, { r, st: this.repoState(s, r) }]));
    const problems = selection
      .map((sel) => {
        const e = states.get(sel.name);
        if (!e) return { repo: sel.name, ok: false, message: 'not a repository of this session' };
        if (e.st.done) return { repo: sel.name, ok: false, message: 'already merged' };
        if (!e.r.pr || e.r.pr.headSha !== sel.headSha) return { repo: sel.name, ok: false, message: 'the pull request changed since you looked — review it again before merging' };
        if (e.st.mergeBlockers.length) return { repo: sel.name, ok: false, message: `not merged: ${e.st.mergeBlockers.join('; ')}` };
        return null;
      })
      .filter((p): p is ShipResult => p !== null);
    if (problems.length || selection.length === 0) {
      return { results: problems.length ? problems : [{ repo: '-', ok: false, message: 'no repositories selected' }], archived: false, allDone: false };
    }
    const results = selection.map((sel) => {
      const { r } = states.get(sel.name)!;
      r.pr = { ...r.pr!, state: 'MERGED' };
      return { repo: sel.name, ok: true, merged: true, message: `PR #${r.pr.number} merged (${method})`, url: r.pr.url };
    });
    const allDone = s.repos.every((r) => this.repoState(s, r).done);
    if (allDone) s.archivedAt = new Date(this.now()).toISOString();
    this.changed();
    return { results, archived: allDone, allDone };
  }

  // -- side panes -------------------------------------------------------------

  projects(): { singles: Array<{ name: string; kind: 'single'; path: string }>; groups: Array<{ name: string; kind: 'group'; members: string[] }> } {
    return {
      singles: [
        { name: 'api', kind: 'single', path: '~/repos/api' },
        { name: 'web', kind: 'single', path: '~/repos/web' },
      ],
      groups: [{ name: 'shop', kind: 'group', members: ['backend', 'frontend'] }],
    };
  }

  prs(): PullRequestInfo[] {
    const out: PullRequestInfo[] = [];
    for (const s of this.sessions.values()) {
      for (const r of s.repos) {
        if (r.pr?.state !== 'OPEN') continue;
        out.push({
          number: r.pr.number,
          title: FINISH_MESSAGES[s.branch]?.split(/[.;]/)[0] ?? s.branch,
          branch: s.branch,
          url: r.pr.url,
          isDraft: r.pr.isDraft,
          checksStatus: r.pr.checks === 'pass' ? 'SUCCESS' : r.pr.checks === 'fail' ? 'FAILURE' : 'PENDING',
          reviewDecision: 'REVIEW_REQUIRED',
          myReview: 'NONE',
          isMine: true,
          repoAlias: s.isGroup ? s.target : s.target,
        });
      }
    }
    out.push({
      number: 208, title: 'Cache product images at the edge', branch: 'perf/image-cache', url: 'https://github.com/example/web/pull/208',
      isDraft: false, checksStatus: 'SUCCESS', reviewDecision: 'APPROVED', myReview: 'APPROVED', isMine: false, repoAlias: 'web',
    });
    return out;
  }

  jira(): JiraIssue[] {
    return [
      { key: 'SHOP-412', summary: 'Customers can save a card for next time', status: 'To Do', issuetype: 'Story', priority: 'High', url: 'https://example.atlassian.net/browse/SHOP-412' },
      { key: 'SHOP-398', summary: 'Invoice PDF shows the wrong VAT rate for EU customers', status: 'In Progress', issuetype: 'Bug', priority: 'Highest', url: 'https://example.atlassian.net/browse/SHOP-398' },
      { key: 'SHOP-377', summary: 'Search: remember the last used filters', status: 'To Do', issuetype: 'Story', priority: 'Medium', url: 'https://example.atlassian.net/browse/SHOP-377' },
    ];
  }

  taskList(): Task[] {
    return this.tasks;
  }

  addTask(text: string): Task[] {
    this.tasks = [...this.tasks, { id: this.nextTaskId++, text, done: false, createdAt: new Date(this.now()).toISOString() }];
    this.emit('tasks-changed');
    return this.tasks;
  }

  updateTask(id: number, patch: Partial<Pick<Task, 'text' | 'done'>>): Task[] {
    this.tasks = this.tasks.map((t) =>
      t.id === id
        ? { ...t, ...patch, doneAt: patch.done ? new Date(this.now()).toISOString() : patch.done === false ? undefined : t.doneAt }
        : t,
    );
    this.emit('tasks-changed');
    return this.tasks;
  }

  deleteTask(id: number): Task[] {
    this.tasks = this.tasks.filter((t) => t.id !== id);
    this.emit('tasks-changed');
    return this.tasks;
  }
}

/** A plausible Claude Code screen for the Terminal tab (plain text, no TUI). */
function claudeScreen(prompt: string, lines: string[]): string[] {
  return [
    '╭────────────────────────────────────────────╮',
    '│ ✻ Claude Code  ·  demo session (simulated)  │',
    '╰────────────────────────────────────────────╯',
    '',
    ...(prompt ? [`> ${prompt}`, ''] : []),
    ...lines,
  ];
}
