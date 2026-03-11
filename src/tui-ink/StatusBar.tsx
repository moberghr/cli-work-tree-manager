import React from 'react';
import { Box, Text } from 'ink';

export interface StatusBarProps {
  message: string;
  pane: 'sessions' | 'tasks' | 'prs' | 'jira' | 'terminal';
  syncing?: boolean;
}

const PANE_HINTS: Record<StatusBarProps['pane'], string> = {
  sessions: ' tab pane  j/k nav  enter start  n new  d remove  . editor  u rebase  g sync  G sync all  q quit ',
  tasks: ' tab pane  j/k nav  enter toggle  a add  e edit  w worktree  d remove  g sync  G sync all  q quit ',
  prs: ' tab pane  j/k nav  enter checkout  g sync  G sync all  q quit ',
  jira: ' tab pane  j/k nav  enter worktree  g sync  G sync all  q quit ',
  terminal: ' tab pane  ctrl+] detach ',
};

export function StatusBar({ message, pane, syncing }: StatusBarProps) {
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
          <Text dimColor>{'○ stopped]'}</Text>
        </>
      )}
      {syncing && <Box flexGrow={1} />}
      {syncing && <Text color="cyan"> syncing</Text>}
    </Box>
  );
}
