import React from 'react';
import { Box, Text } from 'ink';

export interface TerminalPaneProps {
  lines: string[];
  width: number;
  height: number;
  focused: boolean;
  placeholder?: string;
  title?: string;
}

export function TerminalPane({ lines, width, height, focused, placeholder, title }: TerminalPaneProps) {
  const borderColor = focused ? 'cyan' : 'gray';
  const innerWidth = width - 2;
  const contentHeight = height - 2;

  // Direct rendering mode — terminal content is written to stdout directly,
  // so we only render the border frame here.
  const isDirect = lines.length === 1 && lines[0] === '__direct__';

  const content: React.ReactNode[] = [];

  if (isDirect) {
    // Empty rows — actual content is painted directly to stdout
    for (let i = 0; i < contentHeight; i++) {
      content.push(<Text key={i}>{' '.repeat(innerWidth)}</Text>);
    }
  } else if (lines.length === 0 && placeholder) {
    // Center placeholder message
    for (let i = 0; i < contentHeight; i++) {
      const mid = Math.floor(contentHeight / 2);
      if (i === mid) {
        const pad = Math.max(0, Math.floor((innerWidth - placeholder.length) / 2));
        content.push(
          <Text key={i} dimColor>
            {' '.repeat(pad) + placeholder}
          </Text>,
        );
      } else {
        content.push(<Text key={i}>{' '}</Text>);
      }
    }
  } else {
    for (let i = 0; i < contentHeight; i++) {
      if (i < lines.length) {
        content.push(<Text key={i}>{lines[i]}</Text>);
      } else {
        content.push(<Text key={i}>{' '}</Text>);
      }
    }
  }

  return (
    <Box flexDirection="column" width={width}>
      <Text color={borderColor}>{title ? '┌─ ' + title + ' ' + '─'.repeat(Math.max(0, innerWidth - title.length - 3)) + '┐' : '┌' + '─'.repeat(innerWidth) + '┐'}</Text>
      {content.map((row, i) => (
        <Box key={i}>
          <Text color={borderColor}>{'│'}</Text>
          <Box width={innerWidth}>{row}</Box>
          <Text color={borderColor}>{'│'}</Text>
        </Box>
      ))}
      <Text color={borderColor}>{'└' + '─'.repeat(innerWidth) + '┘'}</Text>
    </Box>
  );
}
