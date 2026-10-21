import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  BLOCK_END,
  BLOCK_START,
  hasInstructionsBlock,
  renderInstructions,
  writeSessionInstructions,
} from '../../../src/core/worktree/session-instructions.js';

const block = (...imports: string[]) => [BLOCK_START, "This session's repos, each a folder here:", '', ...imports, BLOCK_END].join('\n');

describe('renderInstructions', () => {
  it('makes the block alone in an empty file', () => {
    expect(renderInstructions('', ['@api/CLAUDE.md', '@web/CLAUDE.md'])).toBe(`${block('@api/CLAUDE.md', '@web/CLAUDE.md')}\n`);
  });

  it('appends the block after the user text, which is kept', () => {
    expect(renderInstructions('# Mine\n\nKeep this.\n', ['@api/CLAUDE.md'])).toBe(`# Mine\n\nKeep this.\n\n${block('@api/CLAUDE.md')}\n`);
  });

  it('replaces an old block in place, keeping the text above and below', () => {
    const before = `Above.\n\n${block('@old/CLAUDE.md')}\n\nBelow.\n`;
    expect(renderInstructions(before, ['@api/CLAUDE.md', '@docs/CLAUDE.md'])).toBe(
      `Above.\n\n${block('@api/CLAUDE.md', '@docs/CLAUDE.md')}\n\nBelow.\n`,
    );
  });

  it('is stable: rendering its own output again changes nothing', () => {
    const once = renderInstructions('Notes\n', ['@api/CLAUDE.md']);
    expect(renderInstructions(once, ['@api/CLAUDE.md'])).toBe(once);
  });
});

describe('writeSessionInstructions', () => {
  // Claude's import line (its adapter's instructionsImport).
  const at = (rel: string) => `@${rel}`;
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-instr-'));
    for (const repo of ['api', 'web', 'docs']) fs.mkdirSync(path.join(dir, repo));
    fs.writeFileSync(path.join(dir, 'api', 'CLAUDE.md'), '# api\n');
    fs.writeFileSync(path.join(dir, 'docs', 'CLAUDE.md'), '# docs\n');
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('imports only the repos whose folder has the file, and creates the file', () => {
    expect(writeSessionInstructions(dir, ['api', 'web', 'docs'], 'CLAUDE.md', at)).toEqual(['api', 'docs']);
    const text = fs.readFileSync(path.join(dir, 'CLAUDE.md'), 'utf8');
    expect(text).toBe(`${block('@api/CLAUDE.md', '@docs/CLAUDE.md')}\n`);
    expect(text).not.toContain('@web/');
    expect(hasInstructionsBlock(path.join(dir, 'CLAUDE.md'))).toBe(true);
  });

  it("keeps the user's own text when the block is rewritten", () => {
    const file = path.join(dir, 'CLAUDE.md');
    fs.writeFileSync(file, `My notes.\n\n${block('@gone/CLAUDE.md')}\n\nMore notes.\n`);
    writeSessionInstructions(dir, ['api'], 'CLAUDE.md', at);
    expect(fs.readFileSync(file, 'utf8')).toBe(`My notes.\n\n${block('@api/CLAUDE.md')}\n\nMore notes.\n`);
  });

  it('uses the agent file name it is given', () => {
    fs.writeFileSync(path.join(dir, 'web', 'AGENTS.md'), '# web\n');
    expect(writeSessionInstructions(dir, ['api', 'web'], 'AGENTS.md', at)).toEqual(['web']);
    expect(fs.existsSync(path.join(dir, 'AGENTS.md'))).toBe(true);
  });

  it("writes each import in the agent's own syntax", () => {
    writeSessionInstructions(dir, ['api', 'docs'], 'CLAUDE.md', (rel) => `include ${rel}`);
    expect(fs.readFileSync(path.join(dir, 'CLAUDE.md'), 'utf8')).toBe(`${block('include api/CLAUDE.md', 'include docs/CLAUDE.md')}\n`);
  });

  it("never overwrites a file it can't read (only one not there yet counts as empty)", () => {
    // A folder where the file should be: reading it fails with EISDIR, not ENOENT.
    fs.mkdirSync(path.join(dir, 'CLAUDE.md'));
    expect(() => writeSessionInstructions(dir, ['api'], 'CLAUDE.md', at)).toThrow();
    expect(fs.statSync(path.join(dir, 'CLAUDE.md')).isDirectory()).toBe(true);
    expect(() => hasInstructionsBlock(path.join(dir, 'CLAUDE.md'))).toThrow();
  });

  it('a file without the block is not a session import file', () => {
    fs.writeFileSync(path.join(dir, 'CLAUDE.md'), '# a group summary\n');
    expect(hasInstructionsBlock(path.join(dir, 'CLAUDE.md'))).toBe(false);
    expect(hasInstructionsBlock(path.join(dir, 'missing.md'))).toBe(false);
  });
});
