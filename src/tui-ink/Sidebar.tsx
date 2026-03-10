import React from 'react';
import { Box, Text } from 'ink';
import chalk from 'chalk';
import { timeAgo } from '../utils/format.js';
import type { WorktreeSession } from '../core/history.js';
import type { SessionStatus } from '../tui/session.js';
import type { PullRequestInfo, BranchPrMap } from '../core/pr.js';

export interface SidebarProps {
  sidebarRows: SidebarRow[];
  cursor: number;
  focused: boolean;
  statusMap: Map<string, SessionStatus>;
  conflictCounts: Map<string, number>;
  prMap: BranchPrMap;
  width: number;
  height: number;
  branchInput?: { value: string } | null;
}

export type SidebarRow =
  | { type: 'header'; label: string }
  | { type: 'session'; session: WorktreeSession; sessionIndex: number }
  | { type: 'project'; name: string; isGroup: boolean };

export function buildSessionRows(sessions: WorktreeSession[]): SidebarRow[] {
  if (sessions.length === 0) return [];

  const groups = new Map<string, WorktreeSession[]>();
  for (const s of sessions) {
    if (!groups.has(s.target)) groups.set(s.target, []);
    groups.get(s.target)!.push(s);
  }

  const rows: SidebarRow[] = [];
  let sessionIndex = 0;

  for (const [target, group] of groups) {
    const typeTag = group[0].isGroup ? 'group' : 'repo';
    rows.push({ type: 'header', label: `${target} (${typeTag})` });
    for (const session of group) {
      rows.push({ type: 'session', session, sessionIndex });
      sessionIndex++;
    }
  }

  return rows;
}

export function buildProjectRows(projects: Array<{ name: string; isGroup: boolean }>): SidebarRow[] {
  if (projects.length === 0) return [];
  const rows: SidebarRow[] = [];
  rows.push({ type: 'header', label: 'Select project' });
  for (const p of projects) {
    rows.push({ type: 'project', name: p.name, isGroup: p.isGroup });
  }
  return rows;
}

function sessionKey(s: WorktreeSession): string {
  return `${s.target}:${s.branch}`;
}

function truncate(str: string, max: number): string {
  if (max <= 1) return '';
  return str.length > max ? str.slice(0, max - 1) + '…' : str;
}

/** Strip ANSI SGR and OSC 8 hyperlink sequences to get visible length. */
function visibleLength(str: string): number {
  return str
    .replace(/\x1B\]8;;[^\x07]*\x07/g, '') // OSC 8 hyperlinks
    .replace(/\x1B\[[0-9;]*m/g, '')         // SGR sequences
    .length;
}

/** Pad or truncate an ANSI string to exactly `width` visible characters. */
function fitToWidth(str: string, width: number): string {
  const vis = visibleLength(str);
  if (vis === width) return str;
  if (vis < width) return str + ' '.repeat(width - vis);
  let out = '';
  let count = 0;
  let i = 0;
  while (i < str.length && count < width) {
    if (str[i] === '\x1B') {
      // OSC 8 hyperlink: \x1B]8;;...\x07
      if (str[i + 1] === ']') {
        const end = str.indexOf('\x07', i);
        if (end !== -1) {
          out += str.slice(i, end + 1);
          i = end + 1;
          continue;
        }
      }
      // SGR: \x1B[...m
      const end = str.indexOf('m', i);
      if (end !== -1) {
        out += str.slice(i, end + 1);
        i = end + 1;
        continue;
      }
    }
    out += str[i];
    count++;
    i++;
  }
  out += '\x1B[0m';
  return out;
}

/** Wrap text in an OSC 8 terminal hyperlink. */
function hyperlink(url: string, text: string): string {
  return `\x1B]8;;${url}\x07${text}\x1B]8;;\x07`;
}

function formatSinglePrBadge(pr: PullRequestInfo): string {
  const num = hyperlink(pr.url, chalk.blue(`#${pr.number}`));
  let checks = '';
  if (pr.checksStatus === 'SUCCESS') checks = ' ' + chalk.green('ok');
  else if (pr.checksStatus === 'FAILURE') checks = ' ' + chalk.red('fail');
  else if (pr.checksStatus === 'PENDING') checks = ' ' + chalk.yellow('...');
  const draft = pr.isDraft ? chalk.gray(' draft') : '';
  return `${num}${checks}${draft}`;
}

function singlePrBadgeLength(pr: PullRequestInfo): number {
  const numLen = 1 + String(pr.number).length;
  let checksLen = 0;
  if (pr.checksStatus === 'SUCCESS') checksLen = 3;
  else if (pr.checksStatus === 'FAILURE') checksLen = 5;
  else if (pr.checksStatus === 'PENDING') checksLen = 4;
  const draftLen = pr.isDraft ? 6 : 0;
  return numLen + checksLen + draftLen;
}

function formatPrBadges(prs: PullRequestInfo[]): string {
  return prs.map(formatSinglePrBadge).join(' ');
}

function prBadgesLength(prs: PullRequestInfo[]): number {
  if (prs.length === 0) return 0;
  // Each badge + 1 space separator between them
  return prs.reduce((sum, pr) => sum + singlePrBadgeLength(pr), 0) + (prs.length - 1);
}

export function Sidebar({ sidebarRows, cursor, focused, statusMap, conflictCounts, prMap, width, height, branchInput }: SidebarProps) {
  const borderColor = focused ? 'cyan' : 'gray';
  const innerWidth = width - 2;
  const contentHeight = height - 2;

  const rows: React.ReactNode[] = [];
  let selectableIdx = 0;
  for (let i = 0; i < contentHeight; i++) {
    if (i >= sidebarRows.length) {
      rows.push(<Text key={i}>{' '.repeat(innerWidth)}</Text>);
      continue;
    }

    const row = sidebarRows[i];
    if (row.type === 'header') {
      const label = truncate(row.label, innerWidth - 1);
      const line = fitToWidth(chalk.yellow.bold(` ${label}`), innerWidth);
      rows.push(<Text key={i}>{line}</Text>);
    } else if (row.type === 'session') {
      const s = row.session;
      const sel = selectableIdx === cursor;
      selectableIdx++;
      const key = sessionKey(s);
      const status = statusMap.get(key) ?? 'stopped';

      const marker = sel && focused ? chalk.cyan('›') : ' ';
      let dot: string;
      if (status === 'idle') dot = chalk.yellow('◆');
      else if (status === 'running') dot = chalk.green('●');
      else dot = chalk.gray('○');

      const conflicts = conflictCounts.get(key);
      const conflictStr = conflicts ? chalk.red(` !${conflicts}`) : '';
      const prs = prMap.get(s.branch) ?? [];
      const prStr = prs.length > 0 ? ' ' + formatPrBadges(prs) : '';
      const agoStr = timeAgo(s.lastAccessedAt);
      const conflictLen = conflicts ? 2 + String(conflicts).length : 0;
      const prLen = prs.length > 0 ? 1 + prBadgesLength(prs) : 0;
      const fixedOverhead = 5 + agoStr.length + conflictLen + prLen;
      const branchBudget = Math.max(4, innerWidth - fixedOverhead);

      const branch = chalk.green(truncate(s.branch, branchBudget));
      const ago = chalk.gray(agoStr);

      const line = fitToWidth(`  ${marker}${dot} ${branch}${conflictStr}${prStr} ${ago}`, innerWidth);
      rows.push(<Text key={i}>{line}</Text>);
    } else if (row.type === 'project') {
      const sel = selectableIdx === cursor;
      selectableIdx++;
      const marker = sel && focused ? chalk.cyan('›') : ' ';
      const typeTag = row.isGroup ? chalk.gray('(group)') : chalk.gray('(repo)');
      const name = chalk.magenta(truncate(row.name, innerWidth - 15));

      // Show branch input inline if this row is selected and input is active
      if (branchInput && sel) {
        const prompt = `  ${marker} ${name} ${chalk.cyan('branch:')} `;
        const inputVal = branchInput.value + chalk.gray('█');
        const line = fitToWidth(`${prompt}${inputVal}`, innerWidth);
        rows.push(<Text key={i}>{line}</Text>);
      } else {
        const line = fitToWidth(`  ${marker} ${name} ${typeTag}`, innerWidth);
        rows.push(<Text key={i}>{line}</Text>);
      }
    }
  }

  return (
    <Box flexDirection="column" width={width}>
      <Text color={borderColor}>{'┌' + '─'.repeat(innerWidth) + '┐'}</Text>
      {rows.map((row, i) => (
        <Box key={i}>
          <Text color={borderColor}>│</Text>
          {row}
          <Text color={borderColor}>│</Text>
        </Box>
      ))}
      <Text color={borderColor}>{'└' + '─'.repeat(innerWidth) + '┘'}</Text>
    </Box>
  );
}
