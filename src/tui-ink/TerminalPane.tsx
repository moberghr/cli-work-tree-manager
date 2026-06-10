import React from 'react';
import { Box, Text } from 'ink';

export interface TerminalPaneProps {
  lines: string[];
  width: number;
  height: number;
  focused: boolean;
  placeholder?: string;
  title?: string;
  /** Lines scrolled back from the live bottom. >0 pauses live updates. */
  scrollback?: number;
}

export const TerminalPane = React.memo(function TerminalPane({ lines, width, height, focused, placeholder, title, scrollback }: TerminalPaneProps) {
  const borderColor = focused ? 'cyan' : 'gray';
  const innerWidth = width - 2;
  const contentHeight = height - 2;

  const content: React.ReactNode[] = [];

  if (lines.length === 0 && placeholder) {
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

  // When scrolled back, surface it in the title so a paused pane doesn't
  // look like a hung session.
  const scrolledTitle =
    scrollback && scrollback > 0
      ? `${title ?? 'Terminal'} ─ ↑${scrollback} paused (pgdn/type to resume)`
      : title;
  const topBorder = scrolledTitle
    ? '┌─ ' + scrolledTitle + ' ' + '─'.repeat(Math.max(0, innerWidth - scrolledTitle.length - 3)) + '┐'
    : '┌' + '─'.repeat(innerWidth) + '┐';

  return (
    <Box flexDirection="column" width={width}>
      <Text color={scrollback && scrollback > 0 ? 'yellow' : borderColor}>{topBorder}</Text>
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
});
