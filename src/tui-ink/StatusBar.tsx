import React from 'react';
import { Box, Text } from 'ink';

export interface StatusBarProps {
  message: string;
  syncing?: boolean;
}

export function StatusBar({ message, syncing }: StatusBarProps) {
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
      <Text dimColor>
        {' tab focus  j/k nav  enter start  n new  d remove  . editor  u rebase  g sync  r refresh  q quit '}
      </Text>
      <Text dimColor>{'['}</Text>
      <Text color="green">●</Text>
      <Text dimColor>{' working  '}</Text>
      <Text color="yellow">◆</Text>
      <Text dimColor>{' needs input  '}</Text>
      <Text dimColor>{'○ stopped]'}</Text>
      {syncing && <Box flexGrow={1} />}
      {syncing && <Text color="cyan"> syncing</Text>}
    </Box>
  );
}
