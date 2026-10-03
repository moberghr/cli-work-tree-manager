import path from 'node:path';
import { loadManifest } from '../diff/checkpoint.js';
import { agentOf } from '../agents/index.js';
import type { ConversationEntry } from '../agents/types.js';
import { promptsSince } from './digest.js';
import { scopeHashForPaths } from '../diff/scope-manager.js';
import { defaultRunner, type CommandRunner } from '../pr/ship.js';
import type { WorktreeSession } from '../sessions/session-types.js';
import { buildTimeline, type TimelineEvent, type TimelineInput } from './timeline.js';
import { readJsonlSince } from './jsonl.js';
import { lineTimeOf } from '../agents/index.js';
import type { SessionCi } from '../api-types.js';

/**
 * The inputs of a session's timeline (timeline.ts), read from where they are
 * kept: the last 30 days of its transcripts (prompts), its scope's
 * checkpoints (turns), git (commits since it left main, per repo), the PR
 * watch's last look (PRs). A read: it runs git log and merge-base, nothing
 * that changes anything.
 */

const DAYS = 30;
const MAX_TRANSCRIPT_BYTES = 8 << 20;
const MAX_COMMITS = 100;

async function commitsOf(repo: string, since: string, run: CommandRunner): Promise<TimelineInput['commits']> {
  const git = (...args: string[]) => run('git', ['-C', repo, ...args], repo);
  const base = (await git('merge-base', 'HEAD', 'origin/HEAD')).stdout.trim();
  // No origin/HEAD to measure from: only commits made since the session began,
  // not the branch's whole history (other people's work on a long-lived branch).
  const range = base ? [`${base}..HEAD`] : [`--since=${since}`, 'HEAD'];
  const log = await git('log', `--max-count=${MAX_COMMITS}`, '--format=%H%x09%aI%x09%s', ...range);
  if (log.code !== 0) return [];
  return log.stdout
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [sha, at, ...subject] = line.split('\t');
      return { repo: path.basename(repo), sha, at, subject: subject.join('\t') };
    });
}

export async function sessionTimeline(s: WorktreeSession, deps: { ci?: SessionCi | null; run?: CommandRunner; now?: number } = {}): Promise<TimelineEvent[]> {
  const run = deps.run ?? defaultRunner;
  const since = Math.max(Date.parse(s.createdAt) || 0, (deps.now ?? Date.now()) - DAYS * 86_400_000);
  const transcripts: ConversationEntry[][] = [];
  const conv = agentOf(s).conversation;
  for (const t of conv?.files(s) ?? []) {
    if (t.mtimeMs < since) continue;
    try {
      transcripts.push(conv!.entries((await readJsonlSince(t.file, since, lineTimeOf(conv!), { maxBytes: MAX_TRANSCRIPT_BYTES })).lines));
    } catch {
      /* gone or unreadable: the rest still tells the story */
    }
  }
  const commits = s.archivedAt ? [] : (await Promise.all(s.paths.map((p) => commitsOf(p, s.createdAt, run).catch(() => [])))).flat();
  const prs = (deps.ci?.repos ?? [])
    .filter((r) => r.pr)
    .map((r) => ({ repo: r.name, number: r.pr!.number, url: r.pr!.url, state: r.pr!.state, ...(r.pr!.mergedAt ? { mergedAt: r.pr!.mergedAt } : {}) }));
  return buildTimeline({
    createdAt: s.createdAt,
    archivedAt: s.archivedAt ?? null,
    prompts: promptsSince(transcripts, since),
    checkpoints: loadManifest(scopeHashForPaths(s.paths)).entries,
    commits,
    prs,
  });
}
