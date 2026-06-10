import React from 'react';
import { Box, Text } from 'ink';

export interface StatusBarProps {
  message: string;
  pane: 'sessions' | 'tasks' | 'prs' | 'jira' | 'terminal';
  syncing?: boolean;
}

const PANE_HINTS: Record<StatusBarProps['pane'], string> = {
  sessions: ' tab pane  j/k nav  / filter  enter start  n new  d remove  u rebase  g sync  ? help  q quit ',
  tasks: ' tab pane  j/k nav  enter toggle  a add  e edit  w worktree  d remove  ? help  q quit ',
  prs: ' tab pane  j/k nav  enter checkout  o open  g sync  ? help  q quit ',
  jira: ' tab pane  j/k nav  enter worktree  o open  g sync  ? help  q quit ',
  terminal: ' tab pane  ctrl+] detach  pgup/pgdn scroll ',
};

export const StatusBar = React.memo(function StatusBar({ message, pane, syncing }: StatusBarProps) {
  if (message) {
    return (
      <Box>
        <Text color="yellow"> {message}</Text>
        {syncing && <Box flexGrow={1} />}
        {syncing && <Text color="cyan"> syncing</Text>}
      </Box>
    );
  }

  return (
    <Box>
      <Text dimColor>{PANE_HINTS[pane]}</Text>
      {pane === 'sessions' && (
        <>
          <Text dimColor>{'['}</Text>
          <Text color="green">●</Text>
          <Text dimColor>{' working  '}</Text>
          <Text color="yellow">◆</Text>
          <Text dimColor>{' needs input  '}</Text>
          <Text color="cyan">◇</Text>
          <Text dimColor>{' done  '}</Text>
          <Text dimColor>{'○ stopped]'}</Text>
        </>
      )}
      {syncing && <Box flexGrow={1} />}
      {syncing && <Text color="cyan"> syncing</Text>}
    </Box>
  );
});
