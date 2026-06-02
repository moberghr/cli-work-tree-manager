import fs from 'node:fs';
import path from 'node:path';
import { computeDiff } from './diff-pipeline.js';
import { resolveWebRoot } from './web-static.js';
import type { RepoSpec } from './repo-spec.js';

export type DiffBase = 'uncommitted' | 'branch';

export interface DiffPayload {
  repos: {
    name: string;
    root: string;
    files: ReturnType<typeof computeDiff>;
  }[];
  /** The ref the diff was computed against (HEAD for uncommitted, e.g.
   *  `origin/main` for branch). */
  resolvedBase: string;
}

export interface StaticBootData {
  context: {
    mode: 'review';
    scopeLabel: string;
    repos: { name: string }[];
    readOnly: true;
    staticMode: true;
    /** Which tab the SPA opens on. The user can toggle to the other one
     *  in-browser; both diffs are inlined. */
    initialBase: DiffBase;
  };
  /** Both scopes, computed ahead of time. The SPA picks one based on
   *  the toggle and re-uses the other when the user clicks across. */
  diffs: {
    uncommitted: DiffPayload;
    branch?: DiffPayload;
  };
  /** Legacy single-scope payload for backward compatibility with any
   *  earlier static HTML. Mirrors diffs[initialBase] so an older client
   *  that only looks at `diff` still renders. */
  diff: DiffPayload;
}

export interface RenderStaticOptions {
  scopeLabel: string;
  /** Always computed (default tab). */
  uncommitted: RepoSpec[];
  /** Optional branch-scope specs. When provided, the SPA gains a
   *  "Since branch" tab. The resolvedBase shows up next to the file
   *  count and in the empty state. */
  branch?: { specs: RepoSpec[]; resolvedBase: string };
  /** Which tab opens by default. Defaults to 'uncommitted' or, when
   *  branch specs are provided AND uncommitted has nothing to show,
   *  the caller can set this to 'branch'. */
  initialBase?: DiffBase;
}

function buildDiff(specs: RepoSpec[], resolvedBase: string): DiffPayload {
  return {
    repos: specs.map((r) => ({
      name: r.name,
      root: r.root,
      files: computeDiff({ root: r.root, diffArg: r.diffArg }),
    })),
    resolvedBase,
  };
}

/**
 * Build a self-contained HTML file from the React SPA bundle. Reads the
 * built `dist/web/index.html`, inlines the JS/CSS as <script>/<style>, and
 * injects the boot data so the SPA can render without a server.
 *
 * Computes both diff scopes (Uncommitted vs Since branch) when branch
 * specs are provided so the toggle works entirely client-side — no
 * fetch needed, file:// works.
 */
export function renderStatic(opts: RenderStaticOptions): string {
  const webRoot = resolveWebRoot();
  if (!webRoot) {
    throw new Error('Could not find dist/web/. Run `npm run build` first.');
  }
  const shellPath = path.join(webRoot, 'index.html');
  let shell = fs.readFileSync(shellPath, 'utf-8');

  const uncommitted = buildDiff(opts.uncommitted, 'HEAD');
  const branch = opts.branch
    ? buildDiff(opts.branch.specs, opts.branch.resolvedBase)
    : undefined;
  const initialBase: DiffBase = opts.initialBase ?? 'uncommitted';
  const initial = initialBase === 'branch' && branch ? branch : uncommitted;

  const boot: StaticBootData = {
    context: {
      mode: 'review',
      scopeLabel: opts.scopeLabel,
      repos: opts.uncommitted.map((r) => ({ name: r.name })),
      readOnly: true,
      staticMode: true,
      initialBase: branch ? initialBase : 'uncommitted',
    },
    diffs: { uncommitted, branch },
    diff: initial,
  };

  // ORDER MATTERS: inject the boot script BEFORE inlining the bundle. The
  // SPA bundle contains literal `</head>` substrings (HTML template helpers
  // inside react-dom / marked / etc.), so replacing `</head>` *after*
  // inlining matches the wrong occurrence and splices JSON into JavaScript.
  // See tests/core/static-renderer.test.ts for the regression test.
  const bootJson = escapeForScriptTag(JSON.stringify(boot));
  const bootScript = `<script>window.__WD_BOOT__=${bootJson};</script>`;
  // String.prototype.replace interprets `$&`, `$'`, `$\``, `$1`, `$$` in
  // the replacement string. The boot JSON can absolutely contain `$'` —
  // e.g. a shell regex like `'^(None)?$'` — which would silently splice
  // the substring AFTER `</head>` (the SPA's body) into the middle of
  // our JSON. Use a function callback so the replacement is taken
  // verbatim, no $-substitution. (This bit us in real CI logs.)
  shell = shell.replace(/<\/head>/i, () => `${bootScript}</head>`);

  // Inline external CSS/JS so the file works over file:// with no server.
  // Same `</tag` escape rule as the JS inliner — a literal `</style` in
  // the CSS bundle (CSS-in-JS comment strings, minifier quirks) would
  // close the wrapping <style> tag early and dump the rest into HTML.
  shell = shell.replace(
    /<link rel="stylesheet"[^>]*href="([^"]+)"[^>]*>/g,
    (_match, href) => {
      const css = readAsset(webRoot, href);
      if (!css) return '';
      const escaped = css.replace(/<\/style/gi, '<\\/style');
      return `<style>${escaped}</style>`;
    },
  );
  shell = shell.replace(
    /<script\b[^>]*\bsrc="([^"]+)"[^>]*><\/script>/g,
    (_match, src) => {
      const js = readAsset(webRoot, src);
      if (!js) return '';
      // Any literal `</script>` inside the bundle would terminate the outer
      // <script> tag early. Browsers match `</script` case-insensitively
      // with optional whitespace, so escape that form.
      const escaped = js.replace(/<\/script/gi, '<\\/script');
      return `<script type="module">${escaped}</script>`;
    },
  );

  return shell;
}

/**
 * Make a JSON payload safe to embed as a literal value inside a `<script>`
 * tag in HTML. JSON itself is fine, but several characters break when it's
 * inlined as JS source:
 *
 *   1. `</script` (case-insensitive) — closes the wrapping tag.
 *   2. `<!--` — flips the HTML parser into "script data escaped" state.
 *      Combined with a later `<script` / `-->` it can hide code from the
 *      parser; a defensive escape is cheaper than reasoning about it.
 *   3. U+2028 (LINE SEPARATOR) and U+2029 (PARAGRAPH SEPARATOR) — legal
 *      inside JSON strings, but treated as line terminators inside JS
 *      string literals on older engines. JSON.stringify emits them raw.
 *
 * Patterns use \uXXXX escapes (not literal characters) so esbuild doesn't
 * interpret them as regex line terminators at parse time.
 */
export function escapeForScriptTag(json: string): string {
  // We escape the leading `<` of any HTML-sensitive opener (`</script`,
  // `<!--`) as `<` instead of `\/` or `\!`. `<` is the
  // strict-JSON form of `<`, so the output is parsable as JSON AND safe
  // to embed in a <script> tag.
  //
  // U+2028/U+2029: legal in JSON strings but treated as line terminators
  // inside legacy JS string literals. Escape both. RegExp constructor
  // avoids putting a literal line-separator in the source file (esbuild
  // refuses, and they're invisible in diffs).
  //
  // Raw control chars (LF/CR/NUL/etc.): we've seen JSON.stringify output
  // in the wild that somehow contains raw newlines mid-string (cause
  // still under investigation — likely something upstream that hands us
  // a pre-built string masquerading as a JSON fragment). JSON.parse
  // rejects raw control chars in strings, so the SPA crashes with
  // "Bad control character" or "failed to fetch". Belt-and-suspenders:
  // re-escape every raw control char so the output is always valid JSON
  // regardless of what produced it.
  const LS_RE = new RegExp('\\u2028', 'g');
  const PS_RE = new RegExp('\\u2029', 'g');
  return json
    .replace(/<(\/script|!--)/gi, '\\u003c$1')
    .replace(LS_RE, '\\u2028')
    .replace(PS_RE, '\\u2029')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, (c) => {
      // Skip \t (0x09), \n (0x0a), \r (0x0d) — those are handled below
      // as proper JSON escapes so the parser keeps the line breaks
      // visible if they were intentional.
      return '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0');
    })
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r');
}

function readAsset(webRoot: string, urlPath: string): string | null {
  // Strip query string and leading slash; resolve under webRoot.
  const clean = urlPath.split('?')[0].replace(/^\//, '');
  const full = path.join(webRoot, clean);
  // Guard against path traversal even though the shell controls the URLs.
  if (!path.normalize(full).startsWith(path.normalize(webRoot))) return null;
  try {
    return fs.readFileSync(full, 'utf-8');
  } catch {
    return null;
  }
}
