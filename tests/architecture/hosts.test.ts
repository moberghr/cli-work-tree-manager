import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ASSISTANT_INSTRUCTIONS } from '../../src/core/agents/assistant.js';
import { DEFAULT_PROMPTS } from '../../src/core/sessions/saved-prompts.js';

/**
 * work talks to git hosts through the GitHost adapter (core/hosts/types.ts):
 * what is GitHub's — its CLI, its URLs, its API — lives in
 * src/core/hosts/github/, resolved per repo from its origin (hosts/index.ts).
 * Anything else that ran `gh` or read a github.com URL would be a feature a
 * repo on another host doesn't get (#63).
 */

const ROOT = path.resolve(__dirname, '../..');
const GITHUB_DIR = 'src/core/hosts/github/';
/**
 * The exceptions, each with its reason:
 * - work's own updates: work itself is published on GitHub, whatever host a project is on;
 * - the demo: a made-up world whose repos are on GitHub (its data, not a dependency on it).
 */
const EXCEPT = ['src/core/updates/', 'src/server/demo/'];

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(e.name)) out.push(p);
  }
  return out;
}
const rel = (abs: string) => path.relative(ROOT, abs).split(path.sep).join('/');

/** The code without its comments: a comment may say what GitHub does; the code may not depend on it. */
function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');
}

function offenders(test: RegExp): string[] {
  const out: string[] = [];
  for (const abs of walk(path.join(ROOT, 'src'))) {
    const file = rel(abs);
    if (file.startsWith(GITHUB_DIR) || EXCEPT.some((e) => file.startsWith(e))) continue;
    code(fs.readFileSync(abs, 'utf8'))
      .split('\n')
      .forEach((line, i) => {
        if (test.test(line)) out.push(`${file}:${i + 1}: ${line.trim().slice(0, 120)}`);
      });
  }
  return out;
}

describe('git hosts', () => {
  it("nothing outside GitHub's adapter runs gh", () => {
    // A runner call or spawn whose command is gh, or a tool spec naming it.
    expect(offenders(/\(\s*['"`]gh['"`]\s*,|\bcmd:\s*['"`]gh['"`]/)).toEqual([]);
  });

  it("nothing outside GitHub's adapter reads or writes github.com URLs", () => {
    expect(offenders(/github\.com/i)).toEqual([]);
  });

  it('what every session is told by default names no host: the assistant, the saved prompts', () => {
    for (const text of [ASSISTANT_INSTRUCTIONS, ...DEFAULT_PROMPTS.map((p) => p.prompt)]) {
      expect(text).not.toMatch(/GitHub|`gh |\bgh pr\b/);
    }
  });
});
