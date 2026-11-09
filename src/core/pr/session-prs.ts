import { json, tx, withDb } from '../platform/db.js';
import type { ShipPr } from '../api-types.js';
import { parsePrLink } from '../hosts/links.js';

/**
 * Every pull request a session made or worked on, kept as it goes — the session's own list, so its PRs no longer
 * depend on guessing from branches. A PR was found only through a branch the session was seen on (session-branches.ts),
 * and a branch made, pushed and left within one turn was never seen: its PR (and a PR in a repo the session doesn't
 * have — Claude opening one on the docs repo too) never showed, and the PR watch never fixed its failing CI.
 *
 * Sources: what the agent's conversation says (`AgentConversation.prLinks`: Claude Code writes a line for each PR its
 * session makes or works on), read as work copies the new lines of a conversation (conversation-store.ts) and once
 * over the whole conversation for a session from before (`scanned`); and every PR the PR watch finds on a branch of
 * the session. A PR stays on the list once it is there; the PR watch looks each one up by its link
 * (`GitHost.prForRef`) until it is merged or closed, then keeps its last look (`final`) and asks no more.
 *
 * Per session in state.db `session_prs` (schema v13, gone with the session: purgeSessionRows).
 */

export type SessionPrSource = 'agent' | 'branch';

export interface SessionPrRecord {
  /** The PR's link, as its host writes it: the key. */
  url: string;
  number: number;
  /** The host's name for its repo (`owner/name`), from the link; '' when it can't be told. */
  repoId: string;
  /** Its head branch, once known (its host's look, or the branch it was found on). */
  branch?: string;
  /** How work learned of it. */
  sources: SessionPrSource[];
  /** ISO. */
  firstSeen: string;
  /** Its last look once merged or closed: shown as it was, never asked again. */
  final?: ShipPr;
}

export interface SessionPrs {
  prs: SessionPrRecord[];
  /** When its whole conversation was read for PRs (once per session; later lines are read as they are copied). */
  scanned?: string;
}

/** A PR to put on a session's list. */
export interface PrSighting {
  url: string;
  number: number;
  /** `owner/name`; taken from the link when it parses. */
  repoId?: string;
  branch?: string;
  source: SessionPrSource;
  /** ISO; default now. */
  at?: string;
}

/** Most PRs kept per session: the oldest finished ones go first. */
export const MAX_SESSION_PRS = 100;

const isIso = (v: unknown): v is string => typeof v === 'string' && Number.isFinite(Date.parse(v));
const SOURCES: readonly SessionPrSource[] = ['agent', 'branch'];

function isShipPr(v: unknown): v is ShipPr {
  const p = v as Partial<ShipPr> | null;
  return (
    !!p &&
    typeof p === 'object' &&
    typeof p.number === 'number' &&
    typeof p.url === 'string' &&
    (p.state === 'OPEN' || p.state === 'MERGED' || p.state === 'CLOSED') &&
    typeof p.isDraft === 'boolean' &&
    typeof p.mergeStateStatus === 'string' &&
    (p.checks === 'pass' || p.checks === 'fail' || p.checks === 'pending' || p.checks === 'none') &&
    typeof p.headSha === 'string'
  );
}

/** A stored record, shape-checked; entries that don't hold up are dropped, not the record. Pure. */
export function cleanSessionPrs(raw: unknown): SessionPrs | null {
  const o = raw as { prs?: unknown; scanned?: unknown } | null;
  if (!o || typeof o !== 'object' || !Array.isArray(o.prs)) return null;
  const prs: SessionPrRecord[] = [];
  for (const x of o.prs as unknown[]) {
    const r = x as Partial<Record<keyof SessionPrRecord, unknown>> | null;
    if (!r || typeof r !== 'object' || typeof r.url !== 'string' || !r.url) continue;
    if (typeof r.number !== 'number' || !Number.isInteger(r.number) || r.number <= 0) continue;
    if (typeof r.repoId !== 'string' || !isIso(r.firstSeen) || !Array.isArray(r.sources)) continue;
    const sources = (r.sources as unknown[]).filter((s): s is SessionPrSource => SOURCES.includes(s as SessionPrSource));
    if (!sources.length) continue;
    prs.push({
      url: r.url,
      number: r.number,
      repoId: r.repoId,
      ...(typeof r.branch === 'string' && r.branch ? { branch: r.branch } : {}),
      sources,
      firstSeen: r.firstSeen,
      ...(isShipPr(r.final) && r.final.state !== 'OPEN' ? { final: r.final } : {}),
    });
  }
  return { prs, ...(isIso(o.scanned) ? { scanned: o.scanned } : {}) };
}

/** The link as its host writes it, and its repo (the key two sightings of one PR share). */
function normal(s: Pick<PrSighting, 'url' | 'number' | 'repoId'>): { url: string; repoId: string } {
  const link = parsePrLink(s.url);
  if (link && link.number === s.number) return { url: link.url, repoId: link.repoId };
  return { url: s.url, repoId: s.repoId ?? '' };
}

/**
 * The record with these sightings: a new PR appended, a known one's sources and branch filled in. Returns the record
 * unchanged (the same object) when nothing moved, so a caller writes only a change. Pure.
 */
export function withPrSightings(rec: SessionPrs | null, seen: PrSighting[], now: Date, opts: { scanned?: boolean } = {}): SessionPrs {
  const base: SessionPrs = rec ?? { prs: [] };
  let changed = !rec || (opts.scanned === true && !base.scanned);
  const prs = base.prs.map((p) => ({ ...p, sources: [...p.sources] }));
  for (const s of seen) {
    if (!Number.isInteger(s.number) || s.number <= 0 || !s.url) continue;
    const { url, repoId } = normal(s);
    const p = prs.find((x) => x.url === url);
    if (!p) {
      prs.push({
        url,
        number: s.number,
        repoId,
        ...(s.branch ? { branch: s.branch } : {}),
        sources: [s.source],
        firstSeen: isIso(s.at) ? s.at : now.toISOString(),
      });
      changed = true;
      continue;
    }
    if (!p.sources.includes(s.source)) {
      p.sources.push(s.source);
      changed = true;
    }
    if (s.branch && !p.branch) {
      p.branch = s.branch;
      changed = true;
    }
    if (!p.repoId && repoId) {
      p.repoId = repoId;
      changed = true;
    }
    if (isIso(s.at) && Date.parse(s.at) < Date.parse(p.firstSeen)) {
      p.firstSeen = s.at;
      changed = true;
    }
  }
  if (!changed) return base;
  return { prs: trim(prs), ...(base.scanned ? { scanned: base.scanned } : opts.scanned ? { scanned: now.toISOString() } : {}) };
}

/** At most MAX_SESSION_PRS: open ones are all kept; of the finished, the newest. */
function trim(prs: SessionPrRecord[]): SessionPrRecord[] {
  if (prs.length <= MAX_SESSION_PRS) return prs;
  const finished = prs.filter((p) => p.final).sort((a, b) => Date.parse(b.firstSeen) - Date.parse(a.firstSeen));
  const drop = new Set(finished.slice(Math.max(0, MAX_SESSION_PRS - (prs.length - finished.length))));
  return prs.filter((p) => !drop.has(p));
}

/**
 * The record with what the host said of its PRs: a merged or closed one keeps that last look (`final`) and is asked
 * no more; every look fills in its branch. Unchanged (the same object) when nothing moved. Pure.
 */
export function withPrLooks(rec: SessionPrs, looks: Array<{ url: string; pr: ShipPr; branch?: string }>): SessionPrs {
  let changed = false;
  const prs = rec.prs.map((p) => {
    const look = looks.find((l) => l.url === p.url || l.pr.url === p.url);
    if (!look) return p;
    const next = { ...p };
    if (look.branch && !p.branch) {
      next.branch = look.branch;
      changed = true;
    }
    if (look.pr.state !== 'OPEN' && !p.final) {
      next.final = look.pr;
      changed = true;
    }
    return next;
  });
  return changed ? { ...rec, prs } : rec;
}

function readRow(d: Parameters<Parameters<typeof withDb>[0]>[0], sessionId: string): SessionPrs | null {
  const row = d.prepare('SELECT data FROM session_prs WHERE session_id = ?').get(sessionId) as { data: string } | undefined;
  return row ? cleanSessionPrs(json.parse(row.data)) : null;
}

function writeRow(d: Parameters<Parameters<typeof withDb>[0]>[0], sessionId: string, rec: SessionPrs): void {
  d.prepare('INSERT OR REPLACE INTO session_prs (session_id, data) VALUES (?, ?)').run(sessionId, JSON.stringify(rec));
}

export function readSessionPrs(sessionId: string): SessionPrs | null {
  return withDb((d) => readRow(d, sessionId));
}

/** Put PRs on a session's list, in one transaction over the row as it is now; writes only a change. Returns the record after. */
export function noteSessionPrs(sessionId: string, seen: PrSighting[], now = new Date(), opts: { scanned?: boolean } = {}): SessionPrs {
  return tx((d) => {
    const old = readRow(d, sessionId);
    const next = withPrSightings(old, seen, now, opts);
    if (next !== old) writeRow(d, sessionId, next);
    return next;
  });
}

/** Record what the host said of a session's listed PRs (withPrLooks), in one transaction; writes only a change. */
export function notePrLooks(sessionId: string, looks: Array<{ url: string; pr: ShipPr; branch?: string }>): void {
  if (!looks.length) return;
  tx((d) => {
    const old = readRow(d, sessionId);
    if (!old) return;
    const next = withPrLooks(old, looks);
    if (next !== old) writeRow(d, sessionId, next);
  });
}
