import { describe, it, expect } from 'vitest';
import {
  checkDialog,
  describeToolUse,
  pendingToolUse,
  screenAnchor,
} from '../../src/core/agents/claude/permission.js';
import type { TranscriptEntry } from '../../src/core/agents/claude/transcript.js';

const use = (id: string, name: string, input: unknown): TranscriptEntry => ({
  type: 'assistant',
  message: { content: [{ type: 'tool_use', id, name, input }] },
});
const result = (id: string): TranscriptEntry => ({
  type: 'user',
  message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] },
});
const said = (text: string): TranscriptEntry => ({ type: 'assistant', message: { content: [{ type: 'text', text }] } });
const prompt = (text: string): TranscriptEntry => ({ type: 'user', message: { content: text } });

describe('pendingToolUse', () => {
  it('is the call with no result yet', () => {
    const t = [prompt('run the tests'), use('a', 'Read', { file_path: 'src/x.ts' }), result('a'), said('Running them'), use('b', 'Bash', { command: 'npm test' })];
    expect(pendingToolUse(t)).toEqual({ tool: 'Bash', detail: 'npm test' });
  });

  it('null when every call has its result', () => {
    expect(pendingToolUse([use('a', 'Bash', { command: 'ls' }), result('a')])).toBeNull();
    expect(pendingToolUse([])).toBeNull();
  });

  it('with parallel calls, the first unanswered one (Claude Code asks in order)', () => {
    const t = [prompt('go'), use('a', 'Bash', { command: 'npm test' }), use('b', 'Bash', { command: 'npm run lint' })];
    expect(pendingToolUse(t)?.detail).toBe('npm test');
    expect(pendingToolUse([...t, result('a')])?.detail).toBe('npm run lint');
  });

  it('ignores an unanswered call from an earlier, interrupted turn', () => {
    const t = [use('old', 'Bash', { command: 'rm -rf build' }), prompt('stop, do this instead'), use('new', 'Edit', { file_path: 'src/a.ts' })];
    expect(pendingToolUse(t)).toEqual({ tool: 'Edit', detail: 'src/a.ts' });
  });
});

describe('describeToolUse', () => {
  it('shows what a person needs to judge the call', () => {
    expect(describeToolUse('Bash', { command: 'git push --force', description: 'Push' })).toBe('git push --force');
    expect(describeToolUse('Write', { file_path: '/wt/api/src/a.ts', content: 'x' })).toBe('/wt/api/src/a.ts');
    expect(describeToolUse('WebFetch', { url: 'https://example.com', prompt: 'p' })).toBe('https://example.com');
    expect(describeToolUse('mcp__jira__create', { summary: 'Bug' })).toBe('{"summary":"Bug"}');
  });

  it('keeps a multi-line command on one line, and caps it', () => {
    expect(describeToolUse('Bash', { command: 'cd x\n  npm test' })).toBe('cd x ⏎ npm test');
    expect(describeToolUse('Bash', { command: 'x'.repeat(1000) })).toHaveLength(400);
  });
});

/** Claude Code's permission dialog, as the headless terminal renders it. */
const dialog = (body: string[], cursorOn = 1) =>
  [
    '╭──────────────────────────────────────────╮',
    ...body,
    '│ Do you want to proceed?                  │',
    `│ ${cursorOn === 1 ? '❯' : ' '} 1. Yes                                 │`,
    `│ ${cursorOn === 2 ? '❯' : ' '} 2. Yes, and don't ask again for npm   │`,
    `│ ${cursorOn === 3 ? '❯' : ' '} 3. No, and tell Claude what to do (esc)│`,
    '╰──────────────────────────────────────────╯',
  ].join('\n');

describe('checkDialog', () => {
  const bash = { tool: 'Bash', detail: 'npm test -- invoices' };

  it('ok while the dialog for this request shows with Yes highlighted', () => {
    expect(checkDialog(dialog(['│ Bash command', '│   npm test -- invoices']), bash)).toEqual({ ok: true });
  });

  it('matches a command the terminal wrapped across lines', () => {
    const long = { tool: 'Bash', detail: 'npx vitest run tests/core/permission-request.test.ts --reporter verbose' };
    const screen = dialog(['│   npx vitest run tests/core/permission-', '│   request.test.ts --reporter verbose']);
    expect(checkDialog(screen, long)).toEqual({ ok: true });
  });

  it('refuses when the prompt is gone, is about something else, or Yes is not selected', () => {
    expect(checkDialog('> \n  ? for shortcuts', bash)).toEqual({ ok: false, reason: 'no-dialog' });
    expect(checkDialog(dialog(['│   git push --force']), bash)).toEqual({ ok: false, reason: 'other-request' });
    expect(checkDialog(dialog(['│   npm test -- invoices'], 3), bash)).toEqual({ ok: false, reason: 'not-default' });
  });

  it('file tools are matched by file name (the dialog shows the name, not the path)', () => {
    const edit = { tool: 'Edit', detail: 'C:\\wt\\api\\src\\export.ts' };
    expect(screenAnchor(edit)).toBe('export.ts');
    const screen = dialog(['│ Edit file', '│ src/export.ts']).replace('Do you want to proceed?', 'Do you want to make this edit to export.ts?');
    expect(checkDialog(screen, edit)).toEqual({ ok: true });
    expect(checkDialog(screen.replace(/export\.ts/g, 'routes.ts'), edit)).toEqual({ ok: false, reason: 'other-request' });
  });
});
