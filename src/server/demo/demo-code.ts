import type { ParsedFile } from '../../core/diff/diff-parse.js';
import type { CodeFileWire, CodeFilesWire, CodeSearchWire, CodeSymbol, CodeTextHit } from '../../core/api-types.js';
import { declarationOf, ignoresCase, matchSymbols } from '../../core/worktree/code-symbols.js';

/**
 * The Code tab in the demo: each repo's files are its changed ones (their
 * new side, from the scenario's diffs) and a few made-up ones every project
 * has. No disk.
 */

const COMMON: Record<string, string> = {
  'README.md': '# {repo}\n\nThe {repo} service of the demo shop.\n\n## Running it\n\n```sh\nnpm install\nnpm run dev\n```\n',
  'package.json': '{\n  "name": "{repo}",\n  "private": true,\n  "scripts": {\n    "dev": "vite",\n    "test": "vitest run"\n  }\n}\n',
  '.gitignore': 'node_modules\ndist\n.env.local\n',
  'src/index.ts': "export { start } from './server';\n",
  'src/server.ts':
    "import { createServer } from 'node:http';\n\n/** Start the {repo} server on PORT (3000 by default). */\nexport function start(port = Number(process.env.PORT ?? 3000)) {\n  return createServer((req, res) => {\n    res.end('ok');\n  }).listen(port);\n}\n",
};

export interface DemoRepoFiles {
  name: string;
  /** Changed files with their new side. */
  changed: ParsedFile[];
}

/** A changed file's text as the diff shows it: its new side, lines in order. */
export function newSide(f: ParsedFile): string {
  const lines: string[] = [];
  for (const h of f.hunks) for (const l of h.lines) if (l.kind === 'add' || l.kind === 'context') lines.push(l.content);
  // A diff's last newline reads as one more (empty) line.
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines.join('\n') + '\n';
}

export function demoCodeFiles(repos: DemoRepoFiles[], group: boolean): CodeFilesWire {
  return {
    group,
    rootFiles: group ? ['CLAUDE.md'] : [],
    repos: repos.map((r) => {
      const changed = r.changed.filter((f) => f.status !== 'deleted').map((f) => f.path);
      return { name: r.name, files: [...new Set([...Object.keys(COMMON), ...changed])].sort(), changed: changed.sort(), truncated: false };
    }),
  };
}

export function demoCodeFile(repos: DemoRepoFiles[], group: boolean, repo: string, path: string): CodeFileWire | null {
  if (repo === '') {
    if (!group || path !== 'CLAUDE.md') return null;
    const text = `# Group instructions\n\nRepos: ${repos.map((r) => r.name).join(', ')}.\n`;
    return { repo, path, size: text.length, text };
  }
  const r = repos.find((x) => x.name === repo);
  if (!r) return null;
  const changed = r.changed.find((f) => f.path === path && f.status !== 'deleted');
  const text = changed ? newSide(changed) : COMMON[path]?.replace(/\{repo\}/g, repo);
  return text === undefined ? null : { repo, path, size: text.length, text };
}

/** The Code tab's search over the demo's files: by name (their declarations) and inside them. */
export function demoCodeSearch(repos: DemoRepoFiles[], group: boolean, query: string): CodeSearchWire {
  const q = query.trim();
  if (q.length < 2) return { query: q, symbols: [], text: [], truncated: false };
  const symbols: CodeSymbol[] = [];
  const text: CodeTextHit[] = [];
  const fold = (x: string) => (ignoresCase(q) ? x.toLowerCase() : x);
  for (const r of demoCodeFiles(repos, group).repos) {
    for (const path of r.files) {
      const lines = (demoCodeFile(repos, group, r.name, path)?.text ?? '').split('\n');
      lines.forEach((line, i) => {
        const d = declarationOf(path, line);
        if (d) symbols.push({ ...d, repo: r.name, path, line: i + 1, text: line.trim() });
        if (fold(line).includes(fold(q))) text.push({ repo: r.name, path, line: i + 1, text: line });
      });
    }
  }
  return { query: q, symbols: matchSymbols(symbols, q), text, truncated: false };
}
