import React from 'react';
import { Box, Text } from 'ink';
import chalk from 'chalk';
import { timeAgo } from '../utils/format.js';
import type { WorktreeSession } from '../core/history.js';
import type { SessionStatus } from '../tui/session.js';

export interface SidebarProps {
  sessions: WorktreeSession[];
  sidebarRows: SidebarRow[];
  cursor: number;
  focused: boolean;
  statusMap: Map<string, SessionStatus>;
  width: number;
  height: number;
}

export type SidebarRow =
  | { type: 'header'; label: string }
  | { type: 'session'; session: WorktreeSession; sessionIndex: number };

export function buildSidebarRows(sessions: WorktreeSession[]): SidebarRow[] {
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

function sessionKey(s: WorktreeSession): string {
  return `${s.target}:${s.branch}`;
}

function truncate(str: string, max: number): string {
  if (max <= 1) return '';
  return str.length > max ? str.slice(0, max - 1) + '…' : str;
}

function visibleLength(str: string): number {
  return str.replace(/\x1B\[[0-9;]*m/g, '').length;
}

/** Pad or truncate an ANSI string to exactly `width` visible characters. */
function fitToWidth(str: string, width: number): string {
  const vis = visibleLength(str);
  if (vis === width) return str;
  if (vis < width) return str + ' '.repeat(width - vis);
  // Truncate respecting ANSI codes
  let out = '';
  let count = 0;
  let i = 0;
  while (i < str.length && count < width) {
    if (str[i] === '\x1B') {
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

export function Sidebar({ sidebarRows, cursor, focused, statusMap, width, height }: SidebarProps) {
  const borderColor = focused ? 'cyan' : 'gray';
  const innerWidth = width - 2;
  const contentHeight = height - 2;

  const rows: React.ReactNode[] = [];
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
    } else {
      const s = row.session;
      const sel = row.sessionIndex === cursor;
      const key = sessionKey(s);
      const status = statusMap.get(key) ?? 'stopped';

      const marker = sel && focused ? chalk.cyan('›') : ' ';
      let dot: string;
      if (status === 'idle') dot = chalk.yellow('◆');
      else if (status === 'running') dot = chalk.green('●');
      else dot = chalk.gray('○');

      const agoStr = timeAgo(s.lastAccessedAt);
      // Fixed chars: "  " + marker + dot + " " + " " + ago
      const fixedOverhead = 5 + agoStr.length;
      const branchBudget = Math.max(4, innerWidth - fixedOverhead);

      const branch = chalk.green(truncate(s.branch, branchBudget));
      const ago = chalk.gray(agoStr);

      const line = fitToWidth(`  ${marker}${dot} ${branch} ${ago}`, innerWidth);
      rows.push(<Text key={i}>{line}</Text>);
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
