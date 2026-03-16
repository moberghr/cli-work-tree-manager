import React from 'react';
import { Box, Text } from 'ink';
import { timeAgo } from '../utils/format.js';
import type { WorktreeSession } from '../core/history.js';
import type { SessionStatus } from '../tui/session.js';
import type { PullRequestInfo, BranchPrMap } from '../core/pr.js';
import type { JiraIssue } from '../core/jira.js';
import type { Task } from '../core/tasks.js';

export interface SidebarProps {
  sidebarRows: SidebarRow[];
  cursor: number;
  focused: boolean;
  statusMap: Map<string, SessionStatus>;
  conflictCounts: Map<string, number>;
  mergedSet: Set<string>;
  prMap: BranchPrMap;
  activeKey: string | null;
  width: number;
  height: number;
  branchInput?: { value: string } | null;
}

export interface PrPaneProps {
  prRows: SidebarRow[];
  cursor: number;
  focused: boolean;
  localBranches: Set<string>;
  width: number;
  height: number;
}

export interface JiraPaneProps {
  jiraRows: SidebarRow[];
  cursor: number;
  focused: boolean;
  width: number;
  height: number;
}

export interface TaskPaneProps {
  taskRows: SidebarRow[];
  cursor: number;
  focused: boolean;
  width: number;
  height: number;
  taskInput?: string | null;
}

export type SidebarRow =
  | { type: 'header'; label: string }
  | { type: 'session'; session: WorktreeSession }
  | { type: 'project'; name: string; isGroup: boolean }
  | { type: 'pr'; pr: PullRequestInfo }
  | { type: 'jira'; issue: JiraIssue }
  | { type: 'task'; task: Task };

export function buildSessionRows(sessions: WorktreeSession[], statusMap?: Map<string, SessionStatus>): SidebarRow[] {
  if (sessions.length === 0) return [];

  const rows: SidebarRow[] = [];

  // Split into active (running/idle PTY) and inactive sessions
  const active: WorktreeSession[] = [];
  const inactive: WorktreeSession[] = [];
  for (const s of sessions) {
    const key = `${s.target}:${s.branch}`;
    const status = statusMap?.get(key);
    if (status === 'running' || status === 'idle') {
      active.push(s);
    } else {
      inactive.push(s);
    }
  }

  // Active sessions first (flat list, no grouping needed)
  if (active.length > 0) {
    rows.push({ type: 'header', label: 'Active' });
    for (const session of active) {
      rows.push({ type: 'session', session });
    }
  }

  // Inactive sessions grouped by target
  if (inactive.length > 0) {
    const groups = new Map<string, WorktreeSession[]>();
    for (const s of inactive) {
      if (!groups.has(s.target)) groups.set(s.target, []);
      groups.get(s.target)!.push(s);
    }

    for (const [target, group] of groups) {
      const typeTag = group[0].isGroup ? 'group' : 'repo';
      rows.push({ type: 'header', label: `${target} (${typeTag})` });
      for (const session of group) {
        rows.push({ type: 'session', session });
      }
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

export function buildJiraRows(issues: JiraIssue[]): SidebarRow[] {
  if (issues.length === 0) return [{ type: 'header', label: 'No Jira issues' }];

  // Group by status
  const byStatus = new Map<string, JiraIssue[]>();
  for (const issue of issues) {
    const status = issue.status || 'Unknown';
    if (!byStatus.has(status)) byStatus.set(status, []);
    byStatus.get(status)!.push(issue);
  }

  // Sort statuses: To Do first, then In Progress, then alphabetical
  const statusOrder = (s: string) => {
    const lower = s.toLowerCase();
    if (lower === 'to do') return 0;
    if (lower.includes('progress')) return 1;
    if (lower.includes('review')) return 2;
    return 3;
  };
  const sortedStatuses = [...byStatus.keys()].sort((a, b) => statusOrder(a) - statusOrder(b) || a.localeCompare(b));

  const rows: SidebarRow[] = [];
  for (const status of sortedStatuses) {
    rows.push({ type: 'header', label: status });
    for (const issue of byStatus.get(status)!) {
      rows.push({ type: 'jira', issue });
    }
  }
  return rows;
}

export function buildTaskRows(tasks: Task[]): SidebarRow[] {
  const open = tasks.filter((t) => !t.done);
  const done = tasks.filter((t) => t.done);
  if (open.length === 0 && done.length === 0) return [{ type: 'header', label: 'No tasks' }];

  const rows: SidebarRow[] = [];
  if (open.length > 0) {
    for (const task of open) {
      rows.push({ type: 'task', task });
    }
  }
  if (done.length > 0) {
    rows.push({ type: 'header', label: `Done (${done.length})` });
    for (const task of done) {
      rows.push({ type: 'task', task });
    }
  }
  return rows;
}

export function buildPrRows(prMap: BranchPrMap): SidebarRow[] {
  // Collect all PRs, grouped by repoAlias
  const byRepo = new Map<string, PullRequestInfo[]>();
  for (const prs of prMap.values()) {
    for (const pr of prs) {
      if (!byRepo.has(pr.repoAlias)) byRepo.set(pr.repoAlias, []);
      byRepo.get(pr.repoAlias)!.push(pr);
    }
  }

  if (byRepo.size === 0) return [{ type: 'header', label: 'No open PRs' }];

  const rows: SidebarRow[] = [];
  // Deduplicate PRs by number+repo
  const seen = new Set<string>();
  for (const [repo, prs] of byRepo) {
    rows.push({ type: 'header', label: repo });
    for (const pr of prs) {
      const key = `${repo}:${pr.number}`;
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push({ type: 'pr', pr });
    }
  }

  return rows;
}

export function countSelectable(rows: SidebarRow[]): number {
  return rows.filter((r) => r.type !== 'header').length;
}

export function cursorToRow(rows: SidebarRow[], cursor: number): SidebarRow | undefined {
  let idx = 0;
  for (const row of rows) {
    if (row.type === 'header') continue;
    if (idx === cursor) return row;
    idx++;
  }
  return undefined;
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

function ownershipLen(pr: PullRequestInfo): number {
  if (pr.isMine) return 2;
  if (pr.myReview !== 'NONE') return 2;
  return 0;
}

function singlePrBadgeLength(pr: PullRequestInfo): number {
  return 1 + String(pr.number).length;
}

function prBadgesLength(prs: PullRequestInfo[]): number {
  if (prs.length === 0) return 0;
  return prs.reduce((sum, pr) => sum + singlePrBadgeLength(pr), 0) + (prs.length - 1);
}

function PrBadge({ pr }: { pr: PullRequestInfo }): React.ReactElement {
  return (
    <Text color="blue">{hyperlink(pr.url, `#${pr.number}`)}</Text>
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
  active,
  width,
}: {
  session: WorktreeSession;
  selected: boolean;
  focused: boolean;
  status: SessionStatus;
  conflicts: number;
  merged: boolean;
  prs: PullRequestInfo[];
  active: boolean;
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

  const cursor = selected && focused ? '›' : active ? '▸' : ' ';
  const cursorColor = selected && focused ? 'cyan' : active ? 'green' : undefined;

  return (
    <Box width={width}>
      <Text>  </Text>
      <Text color={cursorColor}>{cursor}</Text>
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

function PrListRow({
  pr,
  selected,
  focused,
  local,
  width,
}: {
  pr: PullRequestInfo;
  selected: boolean;
  focused: boolean;
  local: boolean;
  width: number;
}): React.ReactElement {
  const marker = selected && focused ? '›' : ' ';
  const numStr = `#${pr.number}`;
  const checksChar = pr.checksStatus === 'SUCCESS' ? '✓' : pr.checksStatus === 'FAILURE' ? '✗' : pr.checksStatus === 'PENDING' ? '●' : '';
  const checksColor = pr.checksStatus === 'SUCCESS' ? 'green' : pr.checksStatus === 'FAILURE' ? 'red' : 'yellow';
  const checksLen = checksChar ? 2 : 0;
  const rvwLen = ownershipLen(pr);
  const localLen = local ? 6 : 0; // " local"
  const fixedOverhead = 4 + numStr.length + checksLen + rvwLen + localLen;
  const branchBudget = Math.max(4, width - fixedOverhead);
  const branchColor = pr.isDraft ? undefined : 'green';

  return (
    <Box width={width}>
      <Text>  </Text>
      <Text color={selected && focused ? 'cyan' : undefined}>{marker}</Text>
      <Text> </Text>
      <Text color={branchColor} dimColor={pr.isDraft}>{truncate(pr.branch, branchBudget)}</Text>
      {local && <Text color="cyan"> local</Text>}
      <Box flexGrow={1} />
      {pr.isMine && <Text color="magenta">★ </Text>}
      {!pr.isMine && pr.myReview === 'APPROVED' && <Text color="green">✔ </Text>}
      {!pr.isMine && (pr.myReview === 'CHANGES_REQUESTED' || pr.myReview === 'COMMENTED') && <Text color="red">✎ </Text>}
      <Text color={pr.isDraft ? undefined : 'blue'} dimColor={pr.isDraft}>{hyperlink(pr.url, numStr)}</Text>
      {checksChar && <Text color={checksColor}> {checksChar}</Text>}
    </Box>
  );
}

/** Bordered pane that renders rows inside a box frame. */
function BorderedPane({
  rows: sidebarRows,
  cursor,
  focused,
  borderColor,
  title,
  width,
  height,
  renderRow,
}: {
  rows: SidebarRow[];
  cursor: number;
  focused: boolean;
  borderColor: string;
  title?: string;
  width: number;
  height: number;
  renderRow: (row: SidebarRow, idx: number, selected: boolean) => React.ReactNode;
}): React.ReactElement {
  const innerWidth = width - 2;
  const contentHeight = height - 2;

  // Find the row index of the cursor-selected item so we can scroll to it
  let cursorRowIdx = 0;
  let selectableCount = 0;
  for (let i = 0; i < sidebarRows.length; i++) {
    if (sidebarRows[i].type !== 'header') {
      if (selectableCount === cursor) {
        cursorRowIdx = i;
        break;
      }
      selectableCount++;
    }
  }

  // Compute scroll offset to keep cursor visible (with 1-row margin)
  let scrollOffset = 0;
  if (sidebarRows.length > contentHeight) {
    if (cursorRowIdx >= contentHeight - 1) {
      scrollOffset = Math.min(
        cursorRowIdx - contentHeight + 2,
        sidebarRows.length - contentHeight,
      );
    }
  }

  const rendered: React.ReactNode[] = [];
  let selectableIdx = 0;
  // Count selectables before the visible window to get the right index
  for (let i = 0; i < scrollOffset; i++) {
    if (sidebarRows[i].type !== 'header') selectableIdx++;
  }
  for (let i = 0; i < contentHeight; i++) {
    const rowIdx = scrollOffset + i;
    if (rowIdx >= sidebarRows.length) {
      rendered.push(<EmptyRow key={i} width={innerWidth} />);
      continue;
    }
    const row = sidebarRows[rowIdx];
    if (row.type === 'header') {
      rendered.push(<HeaderRow key={i} label={row.label} width={innerWidth} />);
    } else {
      const sel = selectableIdx === cursor;
      selectableIdx++;
      rendered.push(renderRow(row, rowIdx, sel));
    }
  }

  const topBorder = title
    ? '┌─ ' + title + ' ' + '─'.repeat(Math.max(0, innerWidth - title.length - 3)) + '┐'
    : '┌' + '─'.repeat(innerWidth) + '┐';

  return (
    <Box flexDirection="column" width={width}>
      <Text color={borderColor}>{topBorder}</Text>
      {rendered.map((row, i) => (
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

export function Sidebar({ sidebarRows, cursor, focused, statusMap, conflictCounts, mergedSet, prMap, activeKey, width, height, branchInput }: SidebarProps) {
  const borderColor = focused ? 'cyan' : 'gray';
  const innerWidth = width - 2;

  return (
    <BorderedPane
      rows={sidebarRows}
      cursor={cursor}
      focused={focused}
      borderColor={borderColor}
      title="Worktrees"
      width={width}
      height={height}
      renderRow={(row, i, sel) => {
        if (row.type === 'session') {
          const s = row.session;
          const key = sessionKey(s);
          return (
            <SessionRow
              key={i}
              session={s}
              selected={sel}
              focused={focused}
              status={statusMap.get(key) ?? 'stopped'}
              conflicts={conflictCounts.get(key) ?? 0}
              merged={mergedSet.has(key)}
              prs={prMap.get(s.branch) ?? []}
              active={key === activeKey}
              width={innerWidth}
            />
          );
        }
        if (row.type === 'project') {
          return (
            <ProjectRow
              key={i}
              name={row.name}
              isGroup={row.isGroup}
              selected={sel}
              focused={focused}
              branchInput={branchInput}
              width={innerWidth}
            />
          );
        }
        return <EmptyRow key={i} width={innerWidth} />;
      }}
    />
  );
}

function statusColor(status: string): string | undefined {
  const lower = status.toLowerCase();
  if (lower.includes('progress') || lower.includes('review')) return 'cyan';
  if (lower.includes('done') || lower.includes('closed')) return 'green';
  return 'yellow';
}

function JiraListRow({
  issue,
  selected,
  focused,
  width,
}: {
  issue: JiraIssue;
  selected: boolean;
  focused: boolean;
  width: number;
}): React.ReactElement {
  const marker = selected && focused ? '›' : ' ';
  const keyLen = issue.key.length;
  const summaryBudget = Math.max(4, width - keyLen - 5);

  return (
    <Box width={width}>
      <Text>  </Text>
      <Text color={selected && focused ? 'cyan' : undefined}>{marker}</Text>
      <Text> </Text>
      <Text color={statusColor(issue.status)}>{issue.url ? hyperlink(issue.url, issue.key) : issue.key}</Text>
      <Text> </Text>
      <Text>{truncate(issue.summary, summaryBudget)}</Text>
    </Box>
  );
}

export function PrPane({ prRows, cursor, focused, localBranches, width, height }: PrPaneProps) {
  const borderColor = focused ? 'cyan' : 'gray';
  const innerWidth = width - 2;

  return (
    <BorderedPane
      rows={prRows}
      cursor={cursor}
      focused={focused}
      borderColor={borderColor}
      title="Pull Requests"
      width={width}
      height={height}
      renderRow={(row, i, sel) => {
        if (row.type === 'pr') {
          return (
            <PrListRow
              key={i}
              pr={row.pr}
              selected={sel}
              focused={focused}
              local={localBranches.has(row.pr.branch)}
              width={innerWidth}
            />
          );
        }
        return <EmptyRow key={i} width={innerWidth} />;
      }}
    />
  );
}

function TaskListRow({
  task,
  selected,
  focused,
  width,
}: {
  task: Task;
  selected: boolean;
  focused: boolean;
  width: number;
}): React.ReactElement {
  const marker = selected && focused ? '›' : ' ';
  const check = task.done ? '✓' : '○';
  const checkColor = task.done ? 'green' : 'gray';
  const idStr = `#${task.id}`;
  const textBudget = Math.max(4, width - idStr.length - 7);

  return (
    <Box width={width}>
      <Text>  </Text>
      <Text color={selected && focused ? 'cyan' : undefined}>{marker}</Text>
      <Text color={checkColor}>{check}</Text>
      <Text> </Text>
      <Text dimColor={task.done} strikethrough={task.done}>{truncate(task.text, textBudget)}</Text>
      <Box flexGrow={1} />
      <Text dimColor>{idStr}</Text>
    </Box>
  );
}

function TaskInputRow({ value, width }: { value: string; width: number }): React.ReactElement {
  const budget = Math.max(4, width - 8);
  return (
    <Box width={width}>
      <Text>  </Text>
      <Text color="cyan">+ </Text>
      <Text>{truncate(value, budget)}</Text>
      <Text dimColor>█</Text>
    </Box>
  );
}

export function TaskPane({ taskRows, cursor, focused, width, height, taskInput }: TaskPaneProps) {
  const borderColor = focused ? 'cyan' : 'gray';
  const innerWidth = width - 2;
  const contentHeight = height - 2;

  // If input is active, render it manually at the top
  if (taskInput !== null && taskInput !== undefined) {
    const rendered: React.ReactNode[] = [];
    rendered.push(<TaskInputRow key="input" value={taskInput} width={innerWidth} />);

    let selectableIdx = 0;
    for (let i = 0; i < contentHeight - 1 && i < taskRows.length; i++) {
      const row = taskRows[i];
      if (row.type === 'header') {
        rendered.push(<HeaderRow key={`r${i}`} label={row.label} width={innerWidth} />);
      } else if (row.type === 'task') {
        rendered.push(
          <TaskListRow key={`r${i}`} task={row.task} selected={false} focused={false} width={innerWidth} />,
        );
        selectableIdx++;
      }
    }
    while (rendered.length < contentHeight) {
      rendered.push(<EmptyRow key={`e${rendered.length}`} width={innerWidth} />);
    }

    const title = 'Tasks';
    const topBorder = '┌─ ' + title + ' ' + '─'.repeat(Math.max(0, innerWidth - title.length - 3)) + '┐';

    return (
      <Box flexDirection="column" width={width}>
        <Text color={borderColor}>{topBorder}</Text>
        {rendered.map((row, i) => (
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

  return (
    <BorderedPane
      rows={taskRows}
      cursor={cursor}
      focused={focused}
      borderColor={borderColor}
      title="Tasks"
      width={width}
      height={height}
      renderRow={(row, i, sel) => {
        if (row.type === 'task') {
          return (
            <TaskListRow
              key={i}
              task={row.task}
              selected={sel}
              focused={focused}
              width={innerWidth}
            />
          );
        }
        return <EmptyRow key={i} width={innerWidth} />;
      }}
    />
  );
}

export function JiraPane({ jiraRows, cursor, focused, width, height }: JiraPaneProps) {
  const borderColor = focused ? 'cyan' : 'gray';
  const innerWidth = width - 2;

  return (
    <BorderedPane
      rows={jiraRows}
      cursor={cursor}
      focused={focused}
      borderColor={borderColor}
      title="Jira"
      width={width}
      height={height}
      renderRow={(row, i, sel) => {
        if (row.type === 'jira') {
          return (
            <JiraListRow
              key={i}
              issue={row.issue}
              selected={sel}
              focused={focused}
              width={innerWidth}
            />
          );
        }
        return <EmptyRow key={i} width={innerWidth} />;
      }}
    />
  );
}
