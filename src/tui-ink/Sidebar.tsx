import React from 'react';
import { Box, Text } from 'ink';
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
  mergedSet: Set<string>;
  prMap: BranchPrMap;
  width: number;
  height: number;
  branchInput?: { value: string } | null;
}

export type SidebarRow =
  | { type: 'header'; label: string }
  | { type: 'session'; session: WorktreeSession }
  | { type: 'project'; name: string; isGroup: boolean };

export function buildSessionRows(sessions: WorktreeSession[]): SidebarRow[] {
  if (sessions.length === 0) return [];

  const groups = new Map<string, WorktreeSession[]>();
  for (const s of sessions) {
    if (!groups.has(s.target)) groups.set(s.target, []);
    groups.get(s.target)!.push(s);
  }

  const rows: SidebarRow[] = [];

  for (const [target, group] of groups) {
    const typeTag = group[0].isGroup ? 'group' : 'repo';
    rows.push({ type: 'header', label: `${target} (${typeTag})` });
    for (const session of group) {
      rows.push({ type: 'session', session });
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

/** Wrap text in an OSC 8 terminal hyperlink. */
function hyperlink(url: string, text: string): string {
  return `\x1B]8;;${url}\x07${text}\x1B]8;;\x07`;
}

function singlePrBadgeLength(pr: PullRequestInfo): number {
  const numLen = 1 + String(pr.number).length;
  let checksLen = 0;
  if (pr.checksStatus === 'SUCCESS') checksLen = 2;
  else if (pr.checksStatus === 'FAILURE') checksLen = 2;
  else if (pr.checksStatus === 'PENDING') checksLen = 2;
  const draftLen = pr.isDraft ? 6 : 0;
  return numLen + checksLen + draftLen;
}

function prBadgesLength(prs: PullRequestInfo[]): number {
  if (prs.length === 0) return 0;
  return prs.reduce((sum, pr) => sum + singlePrBadgeLength(pr), 0) + (prs.length - 1);
}

function PrBadge({ pr }: { pr: PullRequestInfo }): React.ReactElement {
  return (
    <>
      <Text color="blue">{hyperlink(pr.url, `#${pr.number}`)}</Text>
      {pr.checksStatus === 'SUCCESS' && <Text color="green"> ✓</Text>}
      {pr.checksStatus === 'FAILURE' && <Text color="red"> ✗</Text>}
      {pr.checksStatus === 'PENDING' && <Text color="yellow"> ●</Text>}
      {pr.isDraft && <Text dimColor> draft</Text>}
    </>
  );
}

function EmptyRow({ width }: { width: number }): React.ReactElement {
  return <Text>{' '.repeat(width)}</Text>;
}

function HeaderRow({ label, width }: { label: string; width: number }): React.ReactElement {
  const text = ` ${truncate(label, width - 3)} `;
  const lineLen = Math.max(0, width - text.length);
  return (
    <Box width={width}>
      <Text color="yellow" bold>{text}</Text>
      <Text dimColor>{'─'.repeat(lineLen)}</Text>
    </Box>
  );
}

function SessionRow({
  session: s,
  selected,
  focused,
  status,
  conflicts,
  merged,
  prs,
  width,
}: {
  session: WorktreeSession;
  selected: boolean;
  focused: boolean;
  status: SessionStatus;
  conflicts: number;
  merged: boolean;
  prs: PullRequestInfo[];
  width: number;
}): React.ReactElement {
  const dotChar = status === 'idle' ? '◆' : status === 'running' ? '●' : '○';
  const dotColor = status === 'idle' ? 'yellow' : status === 'running' ? 'green' : 'gray';
  const agoStr = timeAgo(s.lastAccessedAt);

  const mergedLen = merged ? 8 : 0; // " merged"
  const conflictLen = conflicts > 0 ? 2 + String(conflicts).length : 0;
  const prLen = prs.length > 0 ? 1 + prBadgesLength(prs) : 0;
  const fixedOverhead = 5 + agoStr.length + mergedLen + conflictLen + prLen;
  const branchBudget = Math.max(4, width - fixedOverhead);

  return (
    <Box width={width}>
      <Text>  </Text>
      <Text color={selected && focused ? 'cyan' : undefined}>{selected && focused ? '›' : ' '}</Text>
      <Text color={dotColor}>{dotChar}</Text>
      <Text> </Text>
      <Text color="green">{truncate(s.branch, branchBudget)}</Text>
      {merged && <Text color="magenta"> merged</Text>}
      {conflicts > 0 && <Text color="red"> !{conflicts}</Text>}
      {prs.map((pr, i) => (
        <React.Fragment key={i}>
          <Text> </Text>
          <PrBadge pr={pr} />
        </React.Fragment>
      ))}
      <Box flexGrow={1} />
      <Text dimColor>{agoStr}</Text>
    </Box>
  );
}

function ProjectRow({
  name,
  isGroup,
  selected,
  focused,
  branchInput,
  width,
}: {
  name: string;
  isGroup: boolean;
  selected: boolean;
  focused: boolean;
  branchInput?: { value: string } | null;
  width: number;
}): React.ReactElement {
  const marker = selected && focused ? '›' : ' ';

  if (branchInput && selected) {
    return (
      <Box width={width}>
        <Text>  </Text>
        <Text color="cyan">{marker}</Text>
        <Text> </Text>
        <Text color="magenta">{truncate(name, width - 15)}</Text>
        <Text> </Text>
        <Text color="cyan">branch:</Text>
        <Text> {branchInput.value}</Text>
        <Text dimColor>█</Text>
      </Box>
    );
  }

  return (
    <Box width={width}>
      <Text>  </Text>
      <Text color={selected && focused ? 'cyan' : undefined}>{marker}</Text>
      <Text> </Text>
      <Text color="magenta">{truncate(name, width - 15)}</Text>
      <Text> </Text>
      <Text dimColor>{isGroup ? '(group)' : '(repo)'}</Text>
    </Box>
  );
}

export function Sidebar({ sidebarRows, cursor, focused, statusMap, conflictCounts, mergedSet, prMap, width, height, branchInput }: SidebarProps) {
  const borderColor = focused ? 'cyan' : 'gray';
  const innerWidth = width - 2;
  const contentHeight = height - 2;

  const rows: React.ReactNode[] = [];
  let selectableIdx = 0;
  for (let i = 0; i < contentHeight; i++) {
    if (i >= sidebarRows.length) {
      rows.push(<EmptyRow key={i} width={innerWidth} />);
      continue;
    }

    const row = sidebarRows[i];
    if (row.type === 'header') {
      rows.push(<HeaderRow key={i} label={row.label} width={innerWidth} />);
    } else if (row.type === 'session') {
      const s = row.session;
      const sel = selectableIdx === cursor;
      selectableIdx++;
      const key = sessionKey(s);

      rows.push(
        <SessionRow
          key={i}
          session={s}
          selected={sel}
          focused={focused}
          status={statusMap.get(key) ?? 'stopped'}
          conflicts={conflictCounts.get(key) ?? 0}
          merged={mergedSet.has(key)}
          prs={prMap.get(s.branch) ?? []}
          width={innerWidth}
        />,
      );
    } else if (row.type === 'project') {
      const sel = selectableIdx === cursor;
      selectableIdx++;

      rows.push(
        <ProjectRow
          key={i}
          name={row.name}
          isGroup={row.isGroup}
          selected={sel}
          focused={focused}
          branchInput={branchInput}
          width={innerWidth}
        />,
      );
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
