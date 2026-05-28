import type {
  FileStatus,
  Hunk,
  HunkLine,
  ParsedFile,
} from './diff-parse.js';
import {
  CLIENT_SCRIPT,
  HLJS_CDN_HEAD,
  REVIEW_SCRIPT,
  REVIEW_STYLES,
  STATE_PRESERVATION_SCRIPT,
  hljsThemeSwitchScript,
} from './diff-html-scripts.js';

export interface RepoData {
  /** Display name (used as tab label and as the repo's slug in keys). */
  name: string;
  files: ParsedFile[];
}

export interface RenderOptions {
  /** "side" = side-by-side, "line" = unified. */
  style?: 'side' | 'line';
  /** Hard theme; "auto" follows OS preference. */
  theme?: 'light' | 'dark' | 'auto';
  /** Page title (shown in the browser tab). */
  title?: string;
  /** Heading shown above the sidebar tree (e.g. "vs main (uncommitted)"). */
  subtitle?: string;
  /** When true, embed a client that persists viewed-checkbox / scroll state
   *  across reloads via sessionStorage. */
  liveReload?: boolean;
  /** When set, this repo's tab is initially active. Matches RepoData.name. */
  activeRepo?: string | null;
  /** Review mode: include comment UI + Done button. Browser POSTs to the
   *  comment server's endpoints. */
  review?: boolean;
}

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'repo';
}

interface TreeNode {
  name: string;
  children: Map<string, TreeNode>;
  files: { name: string; file: ParsedFile; index: number }[];
}

const STATUS_LETTER: Record<FileStatus, string> = {
  added: 'A',
  deleted: 'D',
  modified: 'M',
  renamed: 'R',
  binary: 'B',
};

// Map file extension to highlight.js language identifier. Only languages in
// the "common" hljs bundle are mapped — others fall through to no highlight.
const EXT_TO_LANG: Record<string, string> = {
  ts: 'typescript', tsx: 'typescript', mts: 'typescript', cts: 'typescript',
  js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
  json: 'json',
  py: 'python', pyi: 'python',
  rb: 'ruby',
  go: 'go',
  rs: 'rust',
  java: 'java',
  kt: 'kotlin', kts: 'kotlin',
  swift: 'swift',
  cs: 'csharp',
  c: 'c', h: 'c',
  cpp: 'cpp', cc: 'cpp', cxx: 'cpp', hpp: 'cpp', hh: 'cpp', hxx: 'cpp',
  php: 'php',
  sh: 'bash', bash: 'bash', zsh: 'bash',
  ps1: 'powershell', psm1: 'powershell',
  yaml: 'yaml', yml: 'yaml',
  toml: 'ini', ini: 'ini',
  xml: 'xml', html: 'xml', htm: 'xml', svg: 'xml',
  css: 'css', scss: 'scss', sass: 'scss', less: 'less',
  md: 'markdown', markdown: 'markdown',
  sql: 'sql',
  dockerfile: 'dockerfile',
  lua: 'lua',
  r: 'r',
  dart: 'dart',
  scala: 'scala',
  vue: 'javascript',
};

function languageForPath(path: string): string {
  const base = path.split('/').pop() ?? '';
  if (base.toLowerCase() === 'dockerfile') return 'dockerfile';
  const dot = base.lastIndexOf('.');
  if (dot === -1) return '';
  const ext = base.slice(dot + 1).toLowerCase();
  return EXT_TO_LANG[ext] ?? '';
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function anchorFor(index: number): string {
  return `wd-file-${index}`;
}

function buildTree(files: ParsedFile[], startIndex = 0): TreeNode {
  const root: TreeNode = { name: '', children: new Map(), files: [] };
  files.forEach((f, i) => {
    const index = startIndex + i;
    const parts = f.path.split('/').filter(Boolean);
    const dirs = parts.slice(0, -1);
    const filename = parts[parts.length - 1] ?? f.path;
    let node = root;
    for (const dir of dirs) {
      let child = node.children.get(dir);
      if (!child) {
        child = { name: dir, children: new Map(), files: [] };
        node.children.set(dir, child);
      }
      node = child;
    }
    node.files.push({ name: filename, file: f, index });
  });
  return root;
}

function renderTree(node: TreeNode): string {
  type Entry =
    | { kind: 'dir'; name: string; html: string }
    | { kind: 'file'; name: string; html: string };
  const entries: Entry[] = [];

  for (const child of node.children.values()) {
    entries.push({
      kind: 'dir',
      name: child.name,
      html: `<li class="wd-dir"><details open><summary><span class="wd-caret"></span>${escapeHtml(child.name)}</summary>${renderTree(child)}</details></li>`,
    });
  }
  for (const f of node.files) {
    const { file, index } = f;
    const stats =
      file.added || file.deleted
        ? `<span class="wd-stats"><span class="wd-add">+${file.added}</span> <span class="wd-del">-${file.deleted}</span></span>`
        : '';
    entries.push({
      kind: 'file',
      name: f.name,
      html: `<li class="wd-file-item" data-path="${escapeHtml(file.path)}"><a href="#${anchorFor(index)}" class="wd-file-link wd-status-${file.status}"><span class="wd-status-badge">${STATUS_LETTER[file.status]}</span><span class="wd-name">${escapeHtml(f.name)}</span>${stats}</a></li>`,
    });
  }

  entries.sort((a, b) =>
    a.name.toLowerCase().localeCompare(b.name.toLowerCase()),
  );
  return `<ul>${entries.map((e) => e.html).join('')}</ul>`;
}

interface SideRow {
  oldNum: number | null;
  oldContent: string;
  oldKind: 'context' | 'delete' | 'empty';
  newNum: number | null;
  newContent: string;
  newKind: 'context' | 'add' | 'empty';
}

/**
 * Pair adjacent `-` and `+` lines into side-by-side rows. Unpaired lines
 * (e.g. 3 deletes and 1 add) render as half-empty rows on the side that
 * ran out.
 */
function pairLines(lines: HunkLine[]): SideRow[] {
  const rows: SideRow[] = [];
  let dels: HunkLine[] = [];
  let adds: HunkLine[] = [];

  const flush = () => {
    const max = Math.max(dels.length, adds.length);
    for (let i = 0; i < max; i++) {
      const d = dels[i];
      const a = adds[i];
      rows.push({
        oldNum: d ? d.oldNum : null,
        oldContent: d ? d.content : '',
        oldKind: d ? 'delete' : 'empty',
        newNum: a ? a.newNum : null,
        newContent: a ? a.content : '',
        newKind: a ? 'add' : 'empty',
      });
    }
    dels = [];
    adds = [];
  };

  for (const line of lines) {
    if (line.kind === 'no-newline') continue;
    if (line.kind === 'delete') {
      dels.push(line);
    } else if (line.kind === 'add') {
      adds.push(line);
    } else {
      flush();
      rows.push({
        oldNum: line.oldNum,
        oldContent: line.content,
        oldKind: 'context',
        newNum: line.newNum,
        newContent: line.content,
        newKind: 'context',
      });
    }
  }
  flush();
  return rows;
}

function renderHunkSide(hunk: Hunk): string {
  const header =
    hunk.context || hunk.context === ''
      ? `<tr class="wd-hunk-row"><td colspan="4" class="wd-hunk-context">@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@${hunk.context ? ' ' + escapeHtml(hunk.context) : ''}</td></tr>`
      : '';
  const rows = pairLines(hunk.lines)
    .map(
      (r) =>
        `<tr class="wd-row"><td class="wd-ln wd-ln-old wd-${r.oldKind}">${r.oldNum ?? ''}</td><td class="wd-content wd-${r.oldKind}">${escapeHtml(r.oldContent) || '&nbsp;'}</td><td class="wd-ln wd-ln-new wd-${r.newKind}">${r.newNum ?? ''}</td><td class="wd-content wd-${r.newKind}">${escapeHtml(r.newContent) || '&nbsp;'}</td></tr>`,
    )
    .join('');
  return header + rows;
}

function renderHunkUnified(hunk: Hunk): string {
  const header = `<tr class="wd-hunk-row"><td colspan="3" class="wd-hunk-context">@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@${hunk.context ? ' ' + escapeHtml(hunk.context) : ''}</td></tr>`;
  const rows = hunk.lines
    .filter((l) => l.kind !== 'no-newline')
    .map((l) => {
      const cls =
        l.kind === 'add'
          ? 'wd-add'
          : l.kind === 'delete'
            ? 'wd-delete'
            : 'wd-context';
      const prefix = l.kind === 'add' ? '+' : l.kind === 'delete' ? '-' : ' ';
      const body = l.content
        ? `<span class="wd-prefix">${prefix}</span>${escapeHtml(l.content)}`
        : `<span class="wd-prefix">${prefix}</span>&nbsp;`;
      return `<tr class="wd-row"><td class="wd-ln wd-ln-old">${l.oldNum ?? ''}</td><td class="wd-ln wd-ln-new">${l.newNum ?? ''}</td><td class="wd-content ${cls}">${body}</td></tr>`;
    })
    .join('');
  return header + rows;
}

function renderFile(
  file: ParsedFile,
  index: number,
  style: 'side' | 'line',
  repoSlug: string,
): string {
  const badge = STATUS_LETTER[file.status];
  const stats =
    file.added || file.deleted
      ? `<span class="wd-file-stats"><span class="wd-add">+${file.added}</span> <span class="wd-del">-${file.deleted}</span></span>`
      : '';
  const renamed =
    file.status === 'renamed' && file.oldPath !== file.newPath
      ? `<span class="wd-rename">${escapeHtml(file.oldPath)} → ${escapeHtml(file.newPath)}</span>`
      : '';
  const titlePath = renamed ? '' : escapeHtml(file.path);

  let body: string;
  if (file.isBinary) {
    body = `<div class="wd-binary">Binary file</div>`;
  } else if (file.hunks.length === 0) {
    body = `<div class="wd-binary">No content changes</div>`;
  } else {
    const tableCls =
      style === 'side' ? 'wd-diff-table wd-side' : 'wd-diff-table wd-unified';
    // colgroup pins the column widths so `table-layout: fixed` works even
    // though our hunk-context row uses `colspan` to span all columns.
    const colgroup =
      style === 'side'
        ? '<colgroup><col class="wd-col-ln"><col class="wd-col-content"><col class="wd-col-ln"><col class="wd-col-content"></colgroup>'
        : '<colgroup><col class="wd-col-ln"><col class="wd-col-ln"><col class="wd-col-content"></colgroup>';
    const hunksHtml = file.hunks
      .map((h) => (style === 'side' ? renderHunkSide(h) : renderHunkUnified(h)))
      .join('');
    body = `<table class="${tableCls}">${colgroup}<tbody>${hunksHtml}</tbody></table>`;
  }

  const lang = file.isBinary ? '' : languageForPath(file.path);
  const langAttr = lang ? ` data-lang="${lang}"` : '';

  const viewedKey = `${repoSlug}::${file.path}`;
  return `<article class="wd-file" id="${anchorFor(index)}" data-status="${file.status}" data-path="${escapeHtml(file.path)}" data-viewed-key="${escapeHtml(viewedKey)}"${langAttr}>
    <header class="wd-file-header">
      <span class="wd-file-badge wd-status-${file.status}">${badge}</span>
      <span class="wd-file-path">${titlePath}${renamed}</span>
      ${stats}
      <label class="wd-viewed-label" title="Mark this file as reviewed and collapse it">
        <input type="checkbox" class="wd-viewed-checkbox" />
        Viewed
      </label>
    </header>
    ${body}
  </article>`;
}

const LIGHT_VARS = `
  --bg: #fff;
  --fg: #24292f;
  --border: #d0d7de;
  --muted: #57606a;
  --sidebar-bg: #f6f8fa;
  --header-bg: #f6f8fa;
  --ln-bg: #f6f8fa;
  --ln-fg: #8b949e;
  --add-bg: #e6ffec;
  --add-line-bg: #ccffd8;
  --del-bg: #ffebe9;
  --del-line-bg: #ffd7d5;
  --add-fg: #1a7f37;
  --del-fg: #cf222e;
  --empty-bg: #f6f8fa;
  --hunk-bg: #ddf4ff;
  --hunk-fg: #0969da;
  --hover: #eaeef2;
  --current: #ddf4ff;
  --status-added-bg: #dafbe1;
  --status-added-fg: #1a7f37;
  --status-deleted-bg: #ffebe9;
  --status-deleted-fg: #cf222e;
  --status-modified-bg: #fff8c5;
  --status-modified-fg: #9a6700;
  --status-renamed-bg: #ddf4ff;
  --status-renamed-fg: #0969da;
  --status-binary-bg: #eaeef2;
  --status-binary-fg: #57606a;
`;

const DARK_VARS = `
  --bg: #0d1117;
  --fg: #c9d1d9;
  --border: #30363d;
  --muted: #8b949e;
  --sidebar-bg: #161b22;
  --header-bg: #161b22;
  --ln-bg: #161b22;
  --ln-fg: #6e7681;
  --add-bg: rgba(46,160,67,0.15);
  --add-line-bg: rgba(46,160,67,0.3);
  --del-bg: rgba(248,81,73,0.15);
  --del-line-bg: rgba(248,81,73,0.3);
  --add-fg: #3fb950;
  --del-fg: #f85149;
  --empty-bg: rgba(110,118,129,0.1);
  --hunk-bg: rgba(56,139,253,0.15);
  --hunk-fg: #58a6ff;
  --hover: #21262d;
  --current: rgba(31,111,235,0.2);
  --status-added-bg: rgba(46,160,67,0.2);
  --status-added-fg: #3fb950;
  --status-deleted-bg: rgba(248,81,73,0.2);
  --status-deleted-fg: #f85149;
  --status-modified-bg: rgba(210,153,34,0.2);
  --status-modified-fg: #d29922;
  --status-renamed-bg: rgba(56,139,253,0.2);
  --status-renamed-fg: #58a6ff;
  --status-binary-bg: #30363d;
  --status-binary-fg: #8b949e;
`;

function themeBlock(theme: 'light' | 'dark' | 'auto'): string {
  if (theme === 'dark') return `:root {${DARK_VARS}}`;
  if (theme === 'light') return `:root {${LIGHT_VARS}}`;
  return `:root {${LIGHT_VARS}}\n@media (prefers-color-scheme: dark) { :root {${DARK_VARS}} }`;
}

const BASE_STYLES = `
  * { box-sizing: border-box; }
  :root { --tabs-h: 0px; }
  html, body { background: var(--bg); color: var(--fg); }
  body {
    margin: 0;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    min-height: 100vh;
  }
  body.wd-has-tabs { --tabs-h: 38px; }

  .wd-tabs {
    position: sticky;
    top: 0;
    z-index: 20;
    display: flex;
    gap: 4px;
    padding: 6px 8px;
    background: var(--bg);
    border-bottom: 1px solid var(--border);
    overflow-x: auto;
    white-space: nowrap;
  }
  body:not(.wd-has-tabs) .wd-tabs { display: none; }
  .wd-tab {
    flex-shrink: 0;
    padding: 4px 12px;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--sidebar-bg);
    color: var(--fg);
    cursor: pointer;
    font-family: inherit;
    font-size: 12px;
    display: inline-flex;
    align-items: center;
    gap: 6px;
  }
  .wd-tab:hover { background: var(--hover); }
  .wd-tab.wd-active { background: var(--current); border-color: var(--hunk-fg); color: var(--hunk-fg); }
  .wd-tab-count { font-size: 11px; color: var(--muted); }
  .wd-tab.wd-active .wd-tab-count { color: inherit; opacity: 0.8; }
  .wd-tab-stats { font-size: 11px; }
  .wd-tab-stats .wd-add { color: var(--add-fg); }
  .wd-tab-stats .wd-del { color: var(--del-fg); }

  .wd-repo {
    display: grid;
    grid-template-columns: 320px 1fr;
    min-height: calc(100vh - var(--tabs-h));
  }
  .wd-repo:not(.wd-active) { display: none; }

  .wd-sidebar {
    position: sticky;
    top: var(--tabs-h);
    height: calc(100vh - var(--tabs-h));
    overflow-y: auto;
    border-right: 1px solid var(--border);
    background: var(--sidebar-bg);
    font-size: 13px;
    padding: 0.5rem 0;
  }
  .wd-sidebar-header {
    padding: 0.25rem 0.75rem 0.5rem;
    border-bottom: 1px solid var(--border);
    margin-bottom: 0.5rem;
  }
  .wd-sidebar-title {
    margin: 0 0 0.4rem;
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--muted);
    font-weight: 600;
  }
  .wd-sidebar-subtitle {
    margin: 0 0 0.5rem;
    font-size: 11px;
    color: var(--muted);
  }
  .wd-filter {
    width: 100%;
    padding: 4px 8px;
    border: 1px solid var(--border);
    border-radius: 6px;
    font-size: 12px;
    background: var(--bg);
    color: var(--fg);
  }
  .wd-tree { padding: 0 0.4rem; }
  .wd-sidebar ul { list-style: none; padding-left: 14px; margin: 0; }
  .wd-tree > ul { padding-left: 0.25rem; }
  .wd-sidebar a.wd-file-link {
    color: var(--fg);
    text-decoration: none;
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 2px 6px;
    border-radius: 4px;
    white-space: nowrap;
    overflow: hidden;
  }
  .wd-sidebar a.wd-file-link:hover { background: var(--hover); }
  .wd-sidebar a.wd-file-link.wd-current { background: var(--current); }
  .wd-sidebar .wd-name { overflow: hidden; text-overflow: ellipsis; flex: 1; min-width: 0; }
  .wd-sidebar .wd-stats { font-size: 11px; color: var(--muted); flex-shrink: 0; }
  .wd-sidebar .wd-add { color: var(--add-fg); }
  .wd-sidebar .wd-del { color: var(--del-fg); }
  .wd-sidebar summary {
    cursor: pointer;
    padding: 2px 4px;
    border-radius: 4px;
    user-select: none;
    font-weight: 500;
    display: flex;
    align-items: center;
    gap: 4px;
    list-style: none;
  }
  .wd-sidebar summary::-webkit-details-marker { display: none; }
  .wd-sidebar summary:hover { background: var(--hover); }
  .wd-sidebar .wd-caret {
    display: inline-block;
    width: 0; height: 0;
    border-left: 4px solid currentColor;
    border-top: 4px solid transparent;
    border-bottom: 4px solid transparent;
    transition: transform 0.1s;
    margin-right: 2px;
    opacity: 0.6;
  }
  .wd-sidebar details[open] > summary .wd-caret { transform: rotate(90deg); }
  .wd-sidebar li.wd-hidden { display: none; }

  .wd-status-badge {
    width: 16px; height: 16px; flex-shrink: 0;
    display: inline-flex; align-items: center; justify-content: center;
    font-size: 10px; font-weight: 700; border-radius: 3px;
  }
  .wd-status-added .wd-status-badge,
  .wd-file-badge.wd-status-added { background: var(--status-added-bg); color: var(--status-added-fg); }
  .wd-status-deleted .wd-status-badge,
  .wd-file-badge.wd-status-deleted { background: var(--status-deleted-bg); color: var(--status-deleted-fg); }
  .wd-status-modified .wd-status-badge,
  .wd-file-badge.wd-status-modified { background: var(--status-modified-bg); color: var(--status-modified-fg); }
  .wd-status-renamed .wd-status-badge,
  .wd-file-badge.wd-status-renamed { background: var(--status-renamed-bg); color: var(--status-renamed-fg); }
  .wd-status-binary .wd-status-badge,
  .wd-file-badge.wd-status-binary { background: var(--status-binary-bg); color: var(--status-binary-fg); }

  .wd-main { min-width: 0; padding: 0.75rem 1rem; }

  .wd-file {
    border: 1px solid var(--border);
    border-radius: 6px;
    margin-bottom: 1rem;
    scroll-margin-top: 4px;
    background: var(--bg);
  }
  /* The header sticks to the top of the viewport while scrolling through
     this file. overflow: hidden on .wd-file would kill sticky, so we leave
     it off and round the corners on the header / table separately. */
  .wd-file-header {
    position: sticky;
    top: var(--tabs-h);
    z-index: 5;
    background: var(--header-bg);
    padding: 0.4rem 0.75rem;
    border-bottom: 1px solid var(--border);
    border-top-left-radius: 6px;
    border-top-right-radius: 6px;
    display: flex;
    align-items: center;
    gap: 0.5rem;
    font-size: 13px;
  }
  .wd-viewed-label {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    font-size: 11px;
    color: var(--muted);
    cursor: pointer;
    user-select: none;
    flex-shrink: 0;
    padding: 2px 6px;
    border-radius: 4px;
  }
  .wd-viewed-label:hover { background: var(--hover); }
  .wd-viewed-label input { margin: 0; cursor: pointer; }
  .wd-file.wd-viewed > :not(.wd-file-header) { display: none; }
  .wd-file.wd-viewed { border-color: var(--border); }
  .wd-file.wd-viewed .wd-file-header {
    border-bottom: none;
    border-radius: 6px;
    opacity: 0.6;
  }
  .wd-sidebar a.wd-file-link.wd-viewed-link {
    opacity: 0.5;
    text-decoration: line-through;
    text-decoration-color: var(--muted);
  }
  .wd-file-badge {
    width: 20px; height: 20px;
    display: inline-flex; align-items: center; justify-content: center;
    font-size: 11px; font-weight: 700; border-radius: 4px;
    flex-shrink: 0;
  }
  .wd-file-path {
    font-family: SFMono-Regular, Consolas, "Liberation Mono", monospace;
    font-weight: 500;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    flex: 1;
    min-width: 0;
  }
  .wd-file-stats { font-size: 12px; flex-shrink: 0; }
  .wd-file-stats .wd-add { color: var(--add-fg); }
  .wd-file-stats .wd-del { color: var(--del-fg); }
  .wd-rename { font-style: italic; color: var(--muted); }

  .wd-binary { padding: 0.75rem; font-style: italic; color: var(--muted); }

  .wd-diff-table {
    width: 100%;
    border-collapse: collapse;
    table-layout: fixed;
    font-family: SFMono-Regular, Consolas, "Liberation Mono", monospace;
    font-size: 12px;
    line-height: 1.5;
  }
  .wd-diff-table td {
    padding: 0 6px;
    vertical-align: top;
    white-space: pre-wrap;
    word-break: break-word;
  }
  .wd-ln {
    background: var(--ln-bg);
    color: var(--ln-fg);
    text-align: right;
    font-size: 11px;
    user-select: none;
    border-right: 1px solid var(--border);
  }
  .wd-side .wd-col-ln { width: 50px; }
  .wd-side .wd-col-content { width: calc(50% - 50px); }
  .wd-unified .wd-col-ln { width: 50px; }
  .wd-unified .wd-col-content { width: calc(100% - 100px); }

  /* Background by line kind — applies to both line-number and content cells. */
  .wd-add { background: var(--add-bg); }
  .wd-delete { background: var(--del-bg); }
  .wd-empty { background: var(--empty-bg); }
  .wd-ln.wd-context { background: var(--ln-bg); }

  .wd-hunk-context {
    background: var(--hunk-bg);
    color: var(--hunk-fg);
    padding: 4px 8px !important;
    border-top: 1px solid var(--border);
    border-bottom: 1px solid var(--border);
    font-size: 11px;
    white-space: pre;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .wd-prefix {
    display: inline-block;
    width: 1ch;
    color: var(--muted);
    user-select: none;
    margin-right: 4px;
  }
  /* Make hljs colors inherit our diff backgrounds so syntax highlighting
     doesn't recolor the add/delete row tints. */
  .wd-content .hljs { background: transparent; padding: 0; color: inherit; }
`;


function renderRepoSection(
  repo: RepoData,
  slug: string,
  startIndex: number,
  isActive: boolean,
  style: 'side' | 'line',
  subtitle: string,
): string {
  const tree = buildTree(repo.files, startIndex);
  const treeHtml = renderTree(tree);
  const filesHtml = repo.files
    .map((f, i) => renderFile(f, startIndex + i, style, slug))
    .join('');
  const subtitleHtml = subtitle
    ? `<p class="wd-sidebar-subtitle">${escapeHtml(subtitle)}</p>`
    : '';
  return `<section class="wd-repo${isActive ? ' wd-active' : ''}" data-repo="${escapeHtml(slug)}" data-repo-name="${escapeHtml(repo.name)}">
  <aside class="wd-sidebar">
    <div class="wd-sidebar-header">
      <h3 class="wd-sidebar-title">Files changed (${repo.files.length})<span class="wd-viewed-count"></span></h3>
      ${subtitleHtml}
      <input class="wd-filter" type="search" placeholder="Filter files..." />
    </div>
    <div class="wd-tree">${treeHtml}</div>
    <div class="wd-comments-panel">
      <h3 class="wd-comments-panel-title">Comments <span class="wd-comments-panel-count">(0)</span></h3>
      <ul class="wd-comments-panel-list"></ul>
    </div>
  </aside>
  <main class="wd-main">${filesHtml}</main>
</section>`;
}

function renderTabs(
  repos: { name: string; slug: string; added: number; deleted: number; count: number }[],
  activeSlug: string,
): string {
  const tabs = repos
    .map(
      (r) => `<button type="button" class="wd-tab${r.slug === activeSlug ? ' wd-active' : ''}" data-repo="${escapeHtml(r.slug)}">
        ${escapeHtml(r.name)}
        <span class="wd-tab-count">(${r.count})</span>
        <span class="wd-tab-stats"><span class="wd-add">+${r.added}</span> <span class="wd-del">-${r.deleted}</span></span>
      </button>`,
    )
    .join('');
  return `<nav class="wd-tabs">${tabs}</nav>`;
}

export function renderDiffHtml(
  repos: RepoData[],
  options: RenderOptions = {},
): string {
  const style = options.style ?? 'side';
  const theme = options.theme ?? 'light';
  const title = options.title ?? 'Diff';
  const subtitle = options.subtitle ?? '';
  const liveReload = options.liveReload ?? false;
  const review = options.review ?? false;

  // Skip repos with no changes — empty tabs are noise. If everything is
  // empty, we still render a single empty section so the page isn't blank.
  const nonEmpty = repos.filter((r) => r.files.length > 0);
  const renderRepos = nonEmpty.length > 0 ? nonEmpty : repos.slice(0, 1);

  // Resolve initial active tab: requested repo if present, otherwise first.
  const wantedActive = options.activeRepo ?? null;
  const activeIdx = wantedActive
    ? Math.max(0, renderRepos.findIndex((r) => r.name === wantedActive))
    : 0;

  // Two repos with the same basename (e.g. `foo/core` and `bar/core` in
  // a monorepo group) would slugify identically and collide in the DOM.
  // Suffix duplicates with -2, -3, ... in insertion order.
  const usedSlugs = new Set<string>();
  function uniqueSlug(name: string): string {
    const base = slugify(name);
    if (!usedSlugs.has(base)) {
      usedSlugs.add(base);
      return base;
    }
    for (let i = 2; ; i++) {
      const candidate = `${base}-${i}`;
      if (!usedSlugs.has(candidate)) {
        usedSlugs.add(candidate);
        return candidate;
      }
    }
  }
  const repoMeta = renderRepos.map((r) => ({
    name: r.name,
    slug: uniqueSlug(r.name),
    added: r.files.reduce((s, f) => s + f.added, 0),
    deleted: r.files.reduce((s, f) => s + f.deleted, 0),
    count: r.files.length,
  }));

  let runningIndex = 0;
  const sectionsHtml = renderRepos
    .map((repo, i) => {
      const html = renderRepoSection(
        repo,
        repoMeta[i].slug,
        runningIndex,
        i === activeIdx,
        style,
        subtitle,
      );
      runningIndex += repo.files.length;
      return html;
    })
    .join('');

  const hasTabs = renderRepos.length > 1;
  const bodyClass = hasTabs ? 'wd-has-tabs' : '';
  const tabsHtml = hasTabs ? renderTabs(repoMeta, repoMeta[activeIdx].slug) : '';

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${escapeHtml(title)}</title>
<style>${themeBlock(theme)}\n${BASE_STYLES}</style>
${HLJS_CDN_HEAD}
${hljsThemeSwitchScript(theme)}
${review ? REVIEW_STYLES : ''}
</head>
<body class="${bodyClass}"${review ? ' data-review="true"' : ''}>
${tabsHtml}
${review ? `<section class="wd-general-pane">
  <details>
    <summary>General review note (not tied to any line)</summary>
    <textarea class="wd-general-input" placeholder="A high-level comment for Claude…"></textarea>
    <div class="wd-general-pane-actions">
      <button type="button" class="wd-general-submit" disabled>Send (Ctrl+Enter)</button>
    </div>
    <div class="wd-general-pane-list"></div>
  </details>
</section>` : ''}
${sectionsHtml}
${review ? '<button class="wd-done-bar" type="button">End review <span class="wd-done-count">0</span></button>' : ''}
${CLIENT_SCRIPT}
${review ? REVIEW_SCRIPT : ''}
${liveReload ? STATE_PRESERVATION_SCRIPT : ''}
</body>
</html>`;
}
