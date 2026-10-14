import { spawn } from 'node:child_process';
import type { WorktreeSession } from '../sessions/history.js';
import type { CodeSymbol, CodeTextHit } from '../api-types.js';
import type { PreparedSymbol } from './code-symbols.js';
import { codeRoots } from './code-browse.js';
import { declarationOf, ignoresCase, matchSymbols, MAX_LINE_CHARS, parseGrepLine, prepareSymbols } from './code-symbols.js';

export { declarationOf, matchSymbols, nameScore, parseGrepLine } from './code-symbols.js';

/**
 * Searching a session's code, as Visual Studio's Ctrl+T does: inside the
 * files (`git grep` over what the Code tab lists — never build output or
 * what git ignores) and by name (types and members, from a declaration
 * index built by one `git grep` and kept in memory). A text search over a
 * repo of 5,000 C# files takes about 0.2 s, the index about 0.7 s. The
 * index is a fast reading of declarations by pattern, not a compiler's: a
 * declaration split over lines can be missed.
 */

/** At most this many matching lines come back (git is stopped there). */
export const MAX_TEXT_HITS = 300;
/** An index older than this is rebuilt in the background; the old one answers meanwhile. */
const INDEX_STALE_MS = 60_000;

/** Run git and hand each output line to `onLine` until it says stop; an abort stops git. */
export function gitLines(
  cwd: string,
  args: string[],
  onLine: (line: string) => boolean | void,
  signal?: AbortSignal,
): Promise<{ status: number | null; stopped: boolean }> {
  // Given up on already (a newer keystroke came while this one waited): git isn't started.
  if (signal?.aborted) return Promise.resolve({ status: null, stopped: true });
  return new Promise((resolve) => {
    let stopped = false;
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn('git', args, { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
      resolve({ status: null, stopped: false });
      return;
    }
    const stop = () => {
      stopped = true;
      child.kill();
    };
    signal?.addEventListener('abort', stop, { once: true });
    let rest = '';
    child.stdout?.setEncoding('utf-8');
    child.stdout?.on('data', (d: string) => {
      if (stopped) return;
      const parts = (rest + d).split('\n');
      rest = parts.pop() ?? '';
      for (const line of parts) {
        if (onLine(line.replace(/\r$/, '')) === false) {
          stop();
          return;
        }
      }
    });
    child.on('error', () => resolve({ status: null, stopped }));
    child.on('close', (code) => {
      signal?.removeEventListener('abort', stop);
      if (!stopped && rest) onLine(rest.replace(/\r$/, ''));
      resolve({ status: code, stopped });
    });
  });
}

/** Lines in the session's files with `query` in them (plain text, not a pattern), every repo, at most MAX_TEXT_HITS. */
export async function searchText(
  s: Pick<WorktreeSession, 'paths'>,
  query: string,
  signal?: AbortSignal,
): Promise<{ hits: CodeTextHit[]; truncated: boolean }> {
  const hits: CodeTextHit[] = [];
  let truncated = false;
  for (const { name, root } of codeRoots(s)) {
    if (hits.length >= MAX_TEXT_HITS) break;
    const args = ['grep', '-n', '-I', '--untracked', '--no-color', '--full-name', ...(ignoresCase(query) ? ['-i'] : []), '-F', '-e', query];
    await gitLines(
      root,
      args,
      (line) => {
        const p = parseGrepLine(line);
        if (!p) return;
        if (hits.length >= MAX_TEXT_HITS) {
          truncated = true;
          return false;
        }
        hits.push({
          repo: name,
          path: p.path,
          line: p.line,
          text: p.text.length > MAX_LINE_CHARS ? p.text.slice(0, MAX_LINE_CHARS) + '…' : p.text,
        });
      },
      signal,
    );
  }
  return { hits, truncated };
}

/** Lines that may declare something: a keyword before a space, or an UPPER_CASE name assigned at a line's start (a Python constant). */
const SCAN =
  '(class|record|struct|interface|enum|function|def|public|private|protected|internal|export)[[:space:]]|^[A-Z][A-Z0-9_]*[[:space:]]*[:=]';
const SCAN_FILES = ['*.cs', '*.cshtml', '*.razor', '*.ts', '*.tsx', '*.js', '*.jsx', '*.mjs', '*.cjs', '*.mts', '*.cts', '*.py', '*.pyi'];

/** Every declaration in a repo: one git grep for lines that may hold one, read with declarationOf. */
export async function buildSymbolIndex(repo: string, root: string): Promise<CodeSymbol[]> {
  const out: CodeSymbol[] = [];
  await gitLines(root, ['grep', '-n', '-I', '--untracked', '--no-color', '--full-name', '-E', '-e', SCAN, '--', ...SCAN_FILES], (line) => {
    const p = parseGrepLine(line);
    if (!p) return;
    const d = declarationOf(p.path, p.text);
    if (d) out.push({ name: d.name, kind: d.kind, repo, path: p.path, line: p.line, text: p.text.trim().slice(0, MAX_LINE_CHARS) });
  });
  return out;
}

const indexes = new Map<string, { at: number; symbols: Promise<PreparedSymbol[]>; building: boolean }>();

/** A repo's declarations, ready to match: the cached index, rebuilt in the background once stale (the old one answers meanwhile). */
export function symbolIndex(repo: string, root: string, now = Date.now(), build = buildSymbolIndex): Promise<PreparedSymbol[]> {
  const hit = indexes.get(root);
  if (!hit) {
    const symbols = build(repo, root).then(prepareSymbols);
    indexes.set(root, { at: now, symbols, building: false });
    // A failed build isn't kept: the next search tries again.
    symbols.catch(() => indexes.delete(root));
    return symbols;
  }
  if (now - hit.at > INDEX_STALE_MS && !hit.building) {
    hit.building = true;
    void build(repo, root).then(
      (fresh) => indexes.set(root, { at: Date.now(), symbols: Promise.resolve(prepareSymbols(fresh)), building: false }),
      () => void (hit.building = false),
    );
  }
  return hit.symbols;
}

/** Tests: forget the indexes. */
export function clearSymbolIndexes(): void {
  indexes.clear();
}

/** Declarations across the session's repos matching `query`. */
export async function searchSymbols(s: Pick<WorktreeSession, 'paths'>, query: string): Promise<CodeSymbol[]> {
  const all = await Promise.all(codeRoots(s).map(({ name, root }) => symbolIndex(name, root).catch(() => [])));
  return matchSymbols(all.flat(), query);
}
