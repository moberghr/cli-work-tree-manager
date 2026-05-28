interface FileEntry {
  path: string;
  anchor: string;
  added: number;
  deleted: number;
  status: 'modified' | 'added' | 'deleted' | 'renamed' | 'moved' | 'unknown';
}

interface TreeNode {
  name: string;
  children: Map<string, TreeNode>;
  files: { name: string; entry: FileEntry }[];
}

const SCRIPT_RE = /<script[\s\S]*?<\/script>/gi;
const FILE_LIST_LINE_OPEN_RE =
  /<li\s[^>]*\bclass="[^"]*\bd2h-file-list-line\b[^"]*"[^>]*>/gi;
const ANCHOR_RE = /<a[^>]*\bhref="(#d2h-[^"]+)"[^>]*\bclass="[^"]*\bd2h-file-name\b[^"]*"[^>]*>([^<]+)<\/a>/i;
const ADDED_RE = /<span[^>]*\bclass="[^"]*\bd2h-lines-added\b[^"]*"[^>]*>\s*\+?(\d+)\s*<\/span>/i;
const DELETED_RE = /<span[^>]*\bclass="[^"]*\bd2h-lines-deleted\b[^"]*"[^>]*>\s*-?(\d+)\s*<\/span>/i;
const ICON_CLASS_RE = /<svg[^>]*\bclass="[^"]*\bd2h-icon\s+d2h-([a-z]+)\b[^"]*"/i;

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function statusFromIcon(cls: string): FileEntry['status'] {
  switch (cls) {
    case 'changed':
      return 'modified';
    case 'added':
      return 'added';
    case 'deleted':
      return 'deleted';
    case 'renamed':
      return 'renamed';
    case 'moved':
      return 'moved';
    default:
      return 'unknown';
  }
}

function statusLetter(s: FileEntry['status']): string {
  switch (s) {
    case 'added': return 'A';
    case 'deleted': return 'D';
    case 'renamed': return 'R';
    case 'moved': return 'M';
    case 'modified': return 'M';
    default: return '·';
  }
}

function scriptRanges(html: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  let sm: RegExpExecArray | null;
  SCRIPT_RE.lastIndex = 0;
  while ((sm = SCRIPT_RE.exec(html)) !== null) {
    ranges.push([sm.index, sm.index + sm[0].length]);
  }
  return ranges;
}

function isInRanges(pos: number, ranges: Array<[number, number]>): boolean {
  return ranges.some(([s, e]) => pos >= s && pos < e);
}

function parseFiles(html: string): FileEntry[] {
  const ranges = scriptRanges(html);
  const files: FileEntry[] = [];
  FILE_LIST_LINE_OPEN_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = FILE_LIST_LINE_OPEN_RE.exec(html)) !== null) {
    if (isInRanges(m.index, ranges)) continue;
    const bodyStart = m.index + m[0].length;
    const closeIdx = html.indexOf('</li>', bodyStart);
    if (closeIdx === -1) continue;
    const body = html.slice(bodyStart, closeIdx);
    const anchorMatch = body.match(ANCHOR_RE);
    if (!anchorMatch) continue;
    const addedMatch = body.match(ADDED_RE);
    const deletedMatch = body.match(DELETED_RE);
    const iconMatch = body.match(ICON_CLASS_RE);
    files.push({
      anchor: anchorMatch[1],
      path: anchorMatch[2].trim(),
      added: addedMatch ? Number(addedMatch[1]) : 0,
      deleted: deletedMatch ? Number(deletedMatch[1]) : 0,
      status: iconMatch ? statusFromIcon(iconMatch[1]) : 'unknown',
    });
  }
  return files;
}

function buildTree(files: FileEntry[]): TreeNode {
  const root: TreeNode = { name: '', children: new Map(), files: [] };
  for (const file of files) {
    const parts = file.path.split('/').filter(Boolean);
    const dirs = parts.slice(0, -1);
    const filename = parts[parts.length - 1] ?? file.path;
    let node = root;
    for (const dir of dirs) {
      let child = node.children.get(dir);
      if (!child) {
        child = { name: dir, children: new Map(), files: [] };
        node.children.set(dir, child);
      }
      node = child;
    }
    node.files.push({ name: filename, entry: file });
  }
  return root;
}

function renderTree(node: TreeNode): string {
  // Merge dirs and files into a single alphabetically-sorted list so the
  // tree order matches the diff order. Compared case-insensitive.
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
    const { entry } = f;
    const stats =
      entry.added || entry.deleted
        ? `<span class="wd-stats"><span class="wd-add">+${entry.added}</span> <span class="wd-del">-${entry.deleted}</span></span>`
        : '';
    entries.push({
      kind: 'file',
      name: f.name,
      html: `<li class="wd-file" data-path="${escapeHtml(entry.path)}"><a href="${escapeHtml(entry.anchor)}" class="wd-file-link wd-status-${entry.status}"><span class="wd-status-badge">${statusLetter(entry.status)}</span><span class="wd-name">${escapeHtml(f.name)}</span>${stats}</a></li>`,
    });
  }

  entries.sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
  return `<ul>${entries.map((e) => e.html).join('')}</ul>`;
}

const DARK_VARS = `
  :root {
    --wd-bg: #0d1117;
    --wd-fg: #c9d1d9;
    --wd-border: #30363d;
    --wd-sidebar-bg: #161b22;
    --wd-muted: #8b949e;
    --wd-dir: #c9d1d9;
    --wd-hover: #21262d;
    --wd-current: #1f6feb33;
    --wd-add: #3fb950;
    --wd-del: #f85149;
    --wd-status-bg: #30363d;
    --wd-status-fg: #c9d1d9;
  }
`;

function injectedStyles(theme: 'light' | 'dark' | 'auto'): string {
  const themeBlock =
    theme === 'dark'
      ? `<style>${DARK_VARS}</style>`
      : theme === 'auto'
        ? `<style>@media (prefers-color-scheme: dark) {${DARK_VARS}}</style>`
        : '';
  return `${themeBlock}
<style>
  html, body { background: var(--wd-bg, #fff); }
  body {
    display: grid !important;
    grid-template-columns: 320px 1fr;
    margin: 0 !important;
    min-height: 100vh;
    text-align: left !important;
  }
  body h1 { display: none; }
  .d2h-file-list-wrapper { display: none !important; }
  .wd-sidebar {
    position: sticky;
    top: 0;
    height: 100vh;
    overflow-y: auto;
    border-right: 1px solid var(--wd-border, #d0d7de);
    padding: 0.5rem 0;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    font-size: 13px;
    background: var(--wd-sidebar-bg, #f6f8fa);
    box-sizing: border-box;
    text-align: left;
  }
  .wd-sidebar-header {
    padding: 0.25rem 0.75rem 0.5rem;
    border-bottom: 1px solid var(--wd-border, #d0d7de);
    margin-bottom: 0.5rem;
  }
  .wd-sidebar-title {
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--wd-muted, #57606a);
    margin: 0 0 0.4rem;
    font-weight: 600;
  }
  .wd-filter {
    width: 100%;
    padding: 4px 8px;
    border: 1px solid var(--wd-border, #d0d7de);
    border-radius: 6px;
    font-size: 12px;
    background: var(--wd-bg, #fff);
    color: var(--wd-fg, #24292f);
    box-sizing: border-box;
  }
  .wd-sidebar ul { list-style: none; padding-left: 14px; margin: 0; }
  .wd-sidebar > .wd-tree > ul { padding-left: 0.25rem; }
  .wd-sidebar .wd-tree { padding: 0 0.4rem; }
  .wd-sidebar a.wd-file-link {
    color: var(--wd-fg, #24292f);
    text-decoration: none;
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 2px 6px;
    border-radius: 4px;
    white-space: nowrap;
    overflow: hidden;
  }
  .wd-sidebar a.wd-file-link:hover { background: var(--wd-hover, #eaeef2); }
  .wd-sidebar a.wd-file-link.wd-current { background: var(--wd-current, #ddf4ff); }
  .wd-sidebar .wd-name { overflow: hidden; text-overflow: ellipsis; flex: 1; min-width: 0; }
  .wd-sidebar .wd-stats { font-size: 11px; color: var(--wd-muted, #57606a); flex-shrink: 0; }
  .wd-sidebar .wd-add { color: var(--wd-add, #1a7f37); }
  .wd-sidebar .wd-del { color: var(--wd-del, #cf222e); }
  .wd-sidebar .wd-status-badge {
    width: 16px; height: 16px; flex-shrink: 0;
    display: inline-flex; align-items: center; justify-content: center;
    font-size: 10px; font-weight: 700; border-radius: 3px;
    background: var(--wd-status-bg, #d0d7de); color: var(--wd-status-fg, #24292f);
  }
  .wd-status-added .wd-status-badge { background: #dafbe1; color: #1a7f37; }
  .wd-status-deleted .wd-status-badge { background: #ffebe9; color: #cf222e; }
  .wd-status-modified .wd-status-badge { background: #fff8c5; color: #9a6700; }
  .wd-status-renamed .wd-status-badge, .wd-status-moved .wd-status-badge {
    background: #ddf4ff; color: #0969da;
  }
  .wd-sidebar summary {
    cursor: pointer;
    padding: 2px 4px;
    border-radius: 4px;
    user-select: none;
    color: var(--wd-dir, #24292f);
    font-weight: 500;
    list-style: none;
    display: flex;
    align-items: center;
    gap: 4px;
  }
  .wd-sidebar summary::-webkit-details-marker { display: none; }
  .wd-sidebar summary:hover { background: var(--wd-hover, #eaeef2); }
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
  .wd-main { min-width: 0; padding: 0 0.75rem; }
  .d2h-file-wrapper { scroll-margin-top: 8px; }
  .d2h-file-header { position: sticky; top: 0; z-index: 5; }
</style>`;
}

function clientScript(): string {
  return `
<script>
(function () {
  const sidebar = document.querySelector('.wd-sidebar');
  if (!sidebar) return;

  // Filter: hide files whose path doesn't match. Hide empty dirs.
  const filter = sidebar.querySelector('.wd-filter');
  if (filter) {
    filter.addEventListener('input', function () {
      const q = filter.value.trim().toLowerCase();
      const files = sidebar.querySelectorAll('li.wd-file');
      files.forEach(function (li) {
        const path = (li.getAttribute('data-path') || '').toLowerCase();
        const match = !q || path.indexOf(q) !== -1;
        li.classList.toggle('wd-hidden', !match);
      });
      // Hide dirs with no visible children.
      const dirs = sidebar.querySelectorAll('li.wd-dir');
      dirs.forEach(function (li) {
        const anyVisible = li.querySelector('li.wd-file:not(.wd-hidden)');
        li.classList.toggle('wd-hidden', !anyVisible);
      });
    });
  }

  // Scrollspy + click handling: clicks set the highlight immediately;
  // scrollspy takes over once the user actually scrolls. Targets are sorted
  // by document position because sidebar order (tree) does not match diff order.
  const links = Array.from(sidebar.querySelectorAll('a.wd-file-link'));
  const targets = links
    .map(function (a) {
      const id = a.getAttribute('href').slice(1);
      const el = document.getElementById(id);
      return el ? { link: a, el: el } : null;
    })
    .filter(Boolean)
    .sort(function (a, b) {
      return a.el.offsetTop - b.el.offsetTop;
    });

  function setActive(t) {
    targets.forEach(function (other) {
      other.link.classList.toggle('wd-current', other === t);
    });
  }

  // When the user clicks a file in the sidebar, that file is "current"
  // regardless of where the browser ends up scrolling — important at the
  // bottom of the document where the viewport can't advance further.
  let suppressScrollspyUntil = 0;
  links.forEach(function (a) {
    a.addEventListener('click', function () {
      const t = targets.find(function (x) { return x.link === a; });
      if (!t) return;
      setActive(t);
      suppressScrollspyUntil = Date.now() + 700;
    });
  });

  function updateCurrent() {
    if (Date.now() < suppressScrollspyUntil) return;
    let active = null;
    for (let i = 0; i < targets.length; i++) {
      const rect = targets[i].el.getBoundingClientRect();
      if (rect.top <= 60) active = targets[i];
      else break;
    }
    if (!active) return;
    setActive(active);
    active.link.scrollIntoView({ block: 'nearest' });
  }

  window.addEventListener('scroll', updateCurrent, { passive: true });
  updateCurrent();
})();
</script>`;
}

/**
 * Post-process diff2html HTML output:
 *  - Parse the existing summary panel for file list (anchor + line stats + status).
 *  - Strip the default page title and summary panel.
 *  - Inject a left sidebar with filterable file tree, line stats, and scrollspy.
 *  - Pin per-file headers to top of viewport while scrolling.
 */
export function augmentDiffHtml(
  html: string,
  theme: 'light' | 'dark' | 'auto' = 'light',
): string {
  const files = parseFiles(html);
  if (files.length === 0) return html;

  const tree = buildTree(files);
  const treeHtml = renderTree(tree);

  // CSS hides the original h1 + summary panel — stripping them from the HTML
  // is risky because diff2html's minified script bundle embeds the same
  // class/tag patterns as template strings.
  let out = html.replace(/<\/head>/i, `${injectedStyles(theme)}</head>`);

  const sidebar = `<aside class="wd-sidebar">
    <div class="wd-sidebar-header">
      <h3 class="wd-sidebar-title">Files changed (${files.length})</h3>
      <input class="wd-filter" type="search" placeholder="Filter files..." />
    </div>
    <div class="wd-tree">${treeHtml}</div>
  </aside><div class="wd-main">`;
  out = out.replace(/<body([^>]*)>/i, `<body$1>${sidebar}`);
  out = out.replace(/<\/body>/i, `</div>${clientScript()}</body>`);

  return out;
}
