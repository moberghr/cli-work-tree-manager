import type { DigestResponse, DigestSession } from '../api-types.js';
import { formatWorked } from './work-time-view.js';

/* Pure (the SPA imports it): the Today digest's windows, totals and Markdown,
 * shared by the Today tab and `work digest`. */

/** The windows the Today tab offers. `since` is computed in the browser, so
 *  "today" means the viewer's local midnight. */
export type DigestWindow = 'today' | 'yesterday' | 'week';

export const WINDOW_LABEL: Record<DigestWindow, string> = {
  today: 'Today',
  yesterday: 'Since yesterday',
  week: 'Last 7 days',
};

export function windowStart(w: DigestWindow, now: Date = new Date()): Date {
  const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (w === 'today') return midnight;
  if (w === 'yesterday') return new Date(midnight.getTime() - 24 * 3_600_000);
  return new Date(midnight.getTime() - 6 * 24 * 3_600_000);
}

export const STATE_LABEL: Record<NonNullable<DigestSession['state']>, string> = {
  working: 'working',
  needs_input: 'needs your input',
  idle: 'idle',
};

export function totals(d: DigestResponse): { sessions: number; prompts: number; turns: number; merged: number; workedMs: number } {
  const since = Date.parse(d.since);
  return {
    workedMs: d.sessions.reduce((n, s) => n + (s.workedMs ?? 0), 0),
    sessions: d.sessions.length,
    prompts: d.sessions.reduce((n, s) => n + s.prompts.length + s.morePrompts, 0),
    turns: d.sessions.reduce((n, s) => n + s.turns, 0),
    merged: d.sessions.reduce((n, s) => n + s.prs.filter((p) => p.mergedAt && Date.parse(p.mergedAt) >= since).length, 0),
  };
}

/** The digest as Markdown, for a standup note or a chat message. */
export function digestMarkdown(d: DigestResponse, title: string): string {
  const t = totals(d);
  const lines = [
    `## ${title}`,
    '',
    `${t.sessions} session${t.sessions === 1 ? '' : 's'} · ${t.prompts} prompt${t.prompts === 1 ? '' : 's'} · ${t.turns} turn${t.turns === 1 ? '' : 's'}${t.merged ? ` · ${t.merged} merged` : ''}${t.workedMs ? ` · ~${formatWorked(t.workedMs)} of Claude work` : ''}`,
  ];
  for (const s of d.sessions) {
    lines.push('', `### ${s.target} · ${s.branch}`);
    const facts: string[] = [];
    if (s.state) facts.push(STATE_LABEL[s.state]);
    if (s.turns) facts.push(`${s.turns} turn${s.turns === 1 ? '' : 's'}`);
    if (s.workedMs) facts.push(`~${formatWorked(s.workedMs)} of Claude work`);
    if (s.diffStat?.files) facts.push(`+${s.diffStat.added} −${s.diffStat.deleted} uncommitted`);
    for (const p of s.prs) facts.push(`[#${p.number}](${p.url}) ${p.state.toLowerCase()}`);
    if (s.archivedAt) facts.push('archived');
    if (facts.length) lines.push(facts.join(' · '));
    if (s.prompts.length) {
      lines.push('', 'Asked:');
      if (s.morePrompts) lines.push(`- …${s.morePrompts} earlier`);
      for (const p of s.prompts) lines.push(`- ${p.text}`);
    }
    if (s.turnLabels.length) {
      lines.push('', 'Done:');
      for (const l of s.turnLabels) lines.push(`- ${l}`);
    } else if (s.summary && s.state !== 'working') {
      lines.push('', `Last: ${s.summary}`);
    }
  }
  return lines.join('\n') + '\n';
}
