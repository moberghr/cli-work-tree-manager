import React from 'react';
import { Box, Text } from 'ink';

export interface HelpOverlayProps {
  width: number;
  height: number;
}

type HelpLine = { type: 'section'; label: string } | { type: 'key'; keys: string; desc: string } | { type: 'blank' };

const HELP: HelpLine[] = [
  { type: 'section', label: 'Navigation' },
  { type: 'key', keys: 'tab', desc: 'cycle pane focus' },
  { type: 'key', keys: 'j/k or ↑/↓', desc: 'move cursor' },
  { type: 'key', keys: 'ctrl+d / ctrl+u', desc: 'half-page down / up' },
  { type: 'key', keys: 'pgup / pgdn', desc: 'page up / down' },
  { type: 'key', keys: 'mouse', desc: 'wheel scrolls, click focuses + selects' },
  { type: 'blank' },
  { type: 'section', label: 'Worktrees pane' },
  { type: 'key', keys: 'enter', desc: 'start / show session' },
  { type: 'key', keys: '/', desc: 'filter sessions (enter keeps, esc clears)' },
  { type: 'key', keys: 'n', desc: 'new worktree' },
  { type: 'key', keys: 'd', desc: 'remove worktree (press d again to confirm)' },
  { type: 'key', keys: '.', desc: 'open in editor' },
  { type: 'key', keys: 'u', desc: 'rebase onto main' },
  { type: 'blank' },
  { type: 'section', label: 'Pull Requests / Jira panes' },
  { type: 'key', keys: 'enter', desc: 'checkout PR / create worktree for issue' },
  { type: 'key', keys: 'o', desc: 'open in browser' },
  { type: 'blank' },
  { type: 'section', label: 'Tasks pane' },
  { type: 'key', keys: 'enter or x', desc: 'toggle done' },
  { type: 'key', keys: 'a / e / d', desc: 'add / edit / remove task' },
  { type: 'key', keys: 'w', desc: 'create worktree from task' },
  { type: 'blank' },
  { type: 'section', label: 'Terminal' },
  { type: 'key', keys: 'ctrl+]', desc: 'detach back to sidebar' },
  { type: 'key', keys: 'pgup / pgdn', desc: 'scroll history (typing resumes live)' },
  { type: 'blank' },
  { type: 'section', label: 'Global' },
  { type: 'key', keys: 'g / G', desc: 'sync focused pane / sync everything' },
  { type: 'key', keys: 'r', desc: 'refresh all panes' },
  { type: 'key', keys: '?', desc: 'toggle this help' },
  { type: 'key', keys: 'q or ctrl+c', desc: 'quit' },
];

export const HelpOverlay = React.memo(function HelpOverlay({ width, height }: HelpOverlayProps) {
  const innerWidth = width - 2;
  const contentHeight = height - 2;
  const title = 'Help — press ? or esc to close';
  const topBorder = '┌─ ' + title + ' ' + '─'.repeat(Math.max(0, innerWidth - title.length - 3)) + '┐';

  const rows: React.ReactNode[] = [];
  for (let i = 0; i < contentHeight; i++) {
    const line = HELP[i];
    if (!line || line.type === 'blank') {
      rows.push(<Text key={i}>{' '.repeat(innerWidth)}</Text>);
      continue;
    }
    if (line.type === 'section') {
      rows.push(
        <Box key={i} width={innerWidth}>
          <Text color="yellow" bold>{' ' + line.label}</Text>
        </Box>,
      );
      continue;
    }
    rows.push(
      <Box key={i} width={innerWidth}>
        <Text color="cyan">{'   ' + line.keys.padEnd(18)}</Text>
        <Text>{line.desc}</Text>
      </Box>,
    );
  }

  return (
    <Box flexDirection="column" width={width}>
      <Text color="cyan">{topBorder}</Text>
      {rows.map((row, i) => (
        <Box key={i}>
          <Text color="cyan">│</Text>
          {row}
          <Text color="cyan">│</Text>
        </Box>
      ))}
      <Text color="cyan">{'└' + '─'.repeat(innerWidth) + '┘'}</Text>
    </Box>
  );
});
