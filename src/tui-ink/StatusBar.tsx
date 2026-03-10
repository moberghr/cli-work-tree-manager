import React from 'react';
import { Box, Text } from 'ink';
import chalk from 'chalk';

export interface StatusBarProps {
  message: string;
}

export function StatusBar({ message }: StatusBarProps) {
  if (message) {
    return (
      <Box>
        <Text color="yellow"> {message}</Text>
      </Box>
    );
  }

  return (
    <Box>
      <Text dimColor>
        {' tab focus  j/k nav  enter start  d remove  r refresh  q quit  '}
      </Text>
      <Text>{chalk.green('●')}</Text>
      <Text dimColor>{' working  '}</Text>
      <Text>{chalk.yellow('◆')}</Text>
      <Text dimColor>{' needs input  '}</Text>
      <Text dimColor>{'○ stopped'}</Text>
    </Box>
  );
}
