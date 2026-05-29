/**
 * Inline browser-side resources (CSS links, hljs bundle, JS) that get embedded
 * into the rendered HTML. Kept in a separate file so diff-html.ts can focus on
 * structure / templating without ~200 lines of script bodies inline.
 *
 * NOTE: these strings ship verbatim to the browser. No TypeScript or modern
 * syntax is transformed — write them as plain ES5/ES6 JS that runs in
 * evergreen browsers. They are not type-checked.
 */

export const HLJS_CDN_HEAD = `
<link id="wd-hljs-light" rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/styles/github.min.css">
<link id="wd-hljs-dark" rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/styles/github-dark.min.css" disabled>
<script src="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/highlight.min.js"></script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/marked/12.0.2/marked.min.js"></script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/dompurify/3.0.11/purify.min.js"></script>
`;

/** Toggles the appropriate hljs CSS based on the theme chosen by --theme. */
export function hljsThemeSwitchScript(theme: 'light' | 'dark' | 'auto'): string {
  if (theme === 'dark') {
    return `<script>
(function () {
  document.getElementById('wd-hljs-light').disabled = true;
  document.getElementById('wd-hljs-dark').disabled = false;
})();
</script>`;
  }
  if (theme === 'auto') {
    return `<script>
(function () {
  function apply() {
    const dark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    document.getElementById('wd-hljs-light').disabled = dark;
    document.getElementById('wd-hljs-dark').disabled = !dark;
  }
  apply();
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', apply);
})();
</script>`;
  }
  return '';
}

/**
 * Main client behavior: per-section syntax highlighting, filter, scrollspy,
 * tab switching, and per-tab viewed/scroll state. Every `.wd-repo` section is
 * isolated so multi-repo (group) mode doesn't bleed state across tabs.
 */
export const CLIENT_SCRIPT = `
<script>
(function () {
  function highlightAll() {
    if (typeof hljs === 'undefined') return;
    const files = document.querySelectorAll('article.wd-file[data-lang]');
    files.forEach(function (file) {
      const lang = file.getAttribute('data-lang');
      if (!lang || !hljs.getLanguage(lang)) return;
      const cells = file.querySelectorAll('td.wd-content');
      cells.forEach(function (cell) {
        if (cell.classList.contains('wd-empty')) return;
        // Don't clobber word-level intra-line highlighting markup. Paired
        // add/delete rows carry their own <span class="wd-intra-…"> wrappers
        // which would be lost if we replaced innerHTML with hljs output.
        if (cell.querySelector('.wd-intra-add, .wd-intra-del')) return;
        const prefix = cell.querySelector('.wd-prefix');
        const prefixHtml = prefix ? prefix.outerHTML : '';
        const fullText = cell.textContent || '';
        const codeText = prefix
          ? fullText.slice(prefix.textContent.length)
          : fullText;
        if (!codeText || codeText === '\\u00a0') return;
        try {
          const result = hljs.highlight(codeText, {
            language: lang,
            ignoreIllegals: true,
          });
          cell.innerHTML = prefixHtml + result.value;
        } catch (e) { /* skip cells we can't highlight */ }
      });
    });
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', highlightAll);
  } else {
    highlightAll();
  }

  const sections = Array.from(document.querySelectorAll('section.wd-repo'));
  const sectionScrolls = {};
  const sectionState = new WeakMap();

  sections.forEach(function (section) {
    const sidebar = section.querySelector('.wd-sidebar');
    if (!sidebar) return;

    const viewedCountEl = sidebar.querySelector('.wd-viewed-count');
    function updateViewedCount() {
      if (!viewedCountEl) return;
      const viewed = section.querySelectorAll('article.wd-file.wd-viewed').length;
      viewedCountEl.textContent = viewed > 0 ? ' · ' + viewed + ' viewed' : '';
    }

    section.querySelectorAll('article.wd-file').forEach(function (file) {
      const checkbox = file.querySelector('.wd-viewed-checkbox');
      if (!checkbox) return;
      const link = sidebar.querySelector('a[href="#' + file.id + '"]');
      checkbox.addEventListener('change', function () {
        file.classList.toggle('wd-viewed', checkbox.checked);
        if (link) link.classList.toggle('wd-viewed-link', checkbox.checked);
        updateViewedCount();
      });
    });

    const filter = sidebar.querySelector('.wd-filter');
    if (filter) {
      filter.addEventListener('input', function () {
        const q = filter.value.trim().toLowerCase();
        sidebar.querySelectorAll('li.wd-file-item').forEach(function (li) {
          const p = (li.getAttribute('data-path') || '').toLowerCase();
          li.classList.toggle('wd-hidden', !!q && p.indexOf(q) === -1);
        });
        sidebar.querySelectorAll('li.wd-dir').forEach(function (li) {
          const anyVisible = li.querySelector('li.wd-file-item:not(.wd-hidden)');
          li.classList.toggle('wd-hidden', !anyVisible);
        });
      });
    }

    const links = Array.from(sidebar.querySelectorAll('a.wd-file-link'));
    const targets = links
      .map(function (a) {
        const id = a.getAttribute('href').slice(1);
        const el = document.getElementById(id);
        return el ? { link: a, el: el } : null;
      })
      .filter(Boolean)
      .sort(function (a, b) { return a.el.offsetTop - b.el.offsetTop; });

    function setActive(t) {
      targets.forEach(function (other) {
        other.link.classList.toggle('wd-current', other === t);
      });
    }

    let suppressUntil = 0;
    links.forEach(function (a) {
      a.addEventListener('click', function () {
        const t = targets.find(function (x) { return x.link === a; });
        if (!t) return;
        setActive(t);
        suppressUntil = Date.now() + 700;
      });
    });

    function scrollHandler() {
      if (!section.classList.contains('wd-active')) return;
      if (Date.now() < suppressUntil) return;
      const tabsH = parseInt(getComputedStyle(document.body).getPropertyValue('--tabs-h')) || 0;
      let active = null;
      for (let i = 0; i < targets.length; i++) {
        const rect = targets[i].el.getBoundingClientRect();
        if (rect.top <= 60 + tabsH) {
          active = targets[i];
        } else break;
      }
      if (!active) return;
      setActive(active);
      active.link.scrollIntoView({ block: 'nearest' });
    }

    sectionState.set(section, { setActive: setActive, targets: targets, scrollHandler: scrollHandler });
  });

  function activateTab(slug) {
    sections.forEach(function (section) {
      const match = section.getAttribute('data-repo') === slug;
      if (section.classList.contains('wd-active') && !match) {
        sectionScrolls[section.getAttribute('data-repo')] = window.scrollY;
      }
      section.classList.toggle('wd-active', match);
    });
    document.querySelectorAll('.wd-tab').forEach(function (tab) {
      tab.classList.toggle('wd-active', tab.getAttribute('data-repo') === slug);
    });
    const restoredY = sectionScrolls[slug] || 0;
    window.scrollTo(0, restoredY);
    try { sessionStorage.setItem('wd-active-tab', slug); } catch (e) { /* */ }
  }
  document.querySelectorAll('.wd-tab').forEach(function (tab) {
    tab.addEventListener('click', function () {
      activateTab(tab.getAttribute('data-repo'));
    });
  });

  try {
    const lastTab = sessionStorage.getItem('wd-active-tab');
    if (lastTab && document.querySelector('section.wd-repo[data-repo="' + CSS.escape(lastTab) + '"]')) {
      activateTab(lastTab);
    }
  } catch (e) { /* */ }

  window.addEventListener('scroll', function () {
    sections.forEach(function (s) {
      const st = sectionState.get(s);
      if (st) st.scrollHandler();
    });
  }, { passive: true });
})();
</script>`;

/**
 * Comment-mode CSS and UI. Activates only when `<body data-review="true">`.
 * The diff's line-number cells become click targets; clicking one opens an
 * inline composer; submitted comments POST to /api/comments and re-render
 * inline below the target line. "Done & Send" POSTs /api/done.
 */
export const REVIEW_STYLES = `
<style>
  body[data-review="true"] .wd-ln { cursor: pointer; }
  body[data-review="true"] .wd-ln:hover { outline: 2px solid var(--hunk-fg); outline-offset: -2px; }

  .wd-done-bar {
    position: fixed;
    right: 1rem;
    bottom: 1rem;
    z-index: 50;
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 8px 14px;
    border-radius: 999px;
    background: var(--hunk-fg);
    color: #fff;
    box-shadow: 0 4px 16px rgba(0,0,0,0.2);
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    font-size: 13px;
    cursor: pointer;
    border: none;
  }
  .wd-done-bar:hover { filter: brightness(1.1); }
  .wd-done-bar[disabled] { opacity: 0.6; cursor: default; }
  .wd-done-count {
    background: rgba(255,255,255,0.25);
    padding: 1px 8px;
    border-radius: 999px;
    font-size: 11px;
  }
  body:not([data-review="true"]) .wd-done-bar { display: none; }

  .wd-general-pane {
    position: sticky;
    top: var(--tabs-h);
    z-index: 6;
    background: var(--bg);
    border-bottom: 1px solid var(--border);
    padding: 8px 16px;
  }
  body:not([data-review="true"]) .wd-general-pane { display: none; }
  .wd-general-pane summary {
    cursor: pointer;
    font-size: 12px;
    color: var(--muted);
    padding: 4px 0;
    list-style: none;
  }
  .wd-general-pane summary::-webkit-details-marker { display: none; }
  .wd-general-pane summary::before { content: "▸ "; opacity: 0.5; }
  .wd-general-pane details[open] summary::before { content: "▾ "; opacity: 0.5; }
  .wd-general-pane summary:hover { color: var(--fg); }
  .wd-general-pane textarea {
    width: 100%;
    min-height: 60px;
    margin-top: 6px;
    padding: 6px 8px;
    border: 1px solid var(--border);
    border-radius: 4px;
    background: var(--bg);
    color: var(--fg);
    font: inherit;
    font-size: 12px;
    resize: vertical;
    box-sizing: border-box;
  }
  .wd-general-pane-actions {
    display: flex;
    gap: 6px;
    margin-top: 4px;
    justify-content: flex-end;
  }
  .wd-general-pane button {
    padding: 4px 10px;
    border-radius: 4px;
    border: 1px solid var(--hunk-fg);
    background: var(--hunk-fg);
    color: #fff;
    cursor: pointer;
    font-size: 11px;
  }
  .wd-general-pane button:disabled {
    opacity: 0.5;
    cursor: default;
  }
  .wd-general-pane-list { margin-top: 8px; }
  .wd-general-comment {
    padding: 6px 10px;
    margin-top: 4px;
    border-left: 3px solid var(--hunk-fg);
    background: var(--hunk-bg);
    border-radius: 4px;
    font-size: 12px;
    color: var(--fg);
    white-space: pre-wrap;
    word-wrap: break-word;
    display: flex;
    gap: 8px;
    align-items: flex-start;
  }
  .wd-general-comment .wd-comment-delete {
    margin-left: auto;
    flex-shrink: 0;
  }

  .wd-modal-backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.4);
    z-index: 100;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .wd-modal {
    background: var(--bg);
    color: var(--fg);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 18px 20px;
    max-width: 380px;
    box-shadow: 0 8px 32px rgba(0, 0, 0, 0.25);
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  }
  .wd-modal h2 {
    margin: 0 0 8px;
    font-size: 14px;
  }
  .wd-modal p {
    margin: 0 0 14px;
    font-size: 13px;
    color: var(--muted);
  }
  .wd-modal-actions {
    display: flex;
    gap: 8px;
    justify-content: flex-end;
  }
  .wd-modal button {
    padding: 6px 14px;
    border-radius: 6px;
    border: 1px solid var(--border);
    background: var(--sidebar-bg);
    color: var(--fg);
    cursor: pointer;
    font-size: 13px;
    font-family: inherit;
  }
  .wd-modal button.wd-modal-primary {
    background: var(--hunk-fg);
    color: #fff;
    border-color: var(--hunk-fg);
  }
  .wd-modal button:hover { filter: brightness(1.05); }

  .wd-comments-panel {
    border-top: 1px solid var(--border);
    margin-top: 0.5rem;
    padding: 0.4rem 0.75rem;
  }
  .wd-comments-panel-title {
    margin: 0 0 0.4rem;
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--muted);
    font-weight: 600;
  }
  .wd-comments-panel-list { list-style: none; padding: 0; margin: 0; }
  .wd-comments-panel-list li {
    padding: 4px 6px;
    border-radius: 4px;
    cursor: pointer;
    margin: 1px 0;
  }
  .wd-comments-panel-list li:hover { background: var(--hover); }
  .wd-comments-panel-loc {
    font-family: SFMono-Regular, Consolas, "Liberation Mono", monospace;
    font-size: 11px;
    color: var(--hunk-fg);
    margin-bottom: 2px;
  }
  .wd-comments-panel-loc.wd-outdated { color: var(--muted); text-decoration: line-through; }
  .wd-comments-panel-body {
    font-size: 12px;
    color: var(--fg);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .wd-comments-panel-empty { font-size: 11px; color: var(--muted); font-style: italic; }
  .wd-row-flash { outline: 2px solid var(--hunk-fg); outline-offset: -2px; transition: outline 0.3s; }

  .wd-comment-row > td { padding: 0 !important; }
  .wd-comment-row > td.wd-comment-side { background: var(--hunk-bg) !important; }
  .wd-comment-row > td.wd-comment-empty { background: transparent !important; }
  .wd-comment-list {
    margin: 4px 8px;
    padding: 6px 10px;
    background: var(--bg);
    border-left: 3px solid var(--hunk-fg);
    border-radius: 4px;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    font-size: 12px;
  }
  .wd-comment {
    padding: 4px 0;
    border-bottom: 1px solid var(--border);
    white-space: pre-wrap;
    word-wrap: break-word;
  }
  .wd-comment:last-child { border-bottom: none; }
  .wd-comment.wd-comment-outdated { opacity: 0.6; }
  .wd-comment.wd-status-draft {
    border-left: 3px solid var(--status-modified-fg);
    background: var(--status-modified-bg);
    padding-left: 8px;
  }
  .wd-draft-badge {
    display: inline-block;
    background: var(--status-modified-fg);
    color: #fff;
    font-size: 10px;
    font-weight: 700;
    padding: 1px 6px;
    border-radius: 3px;
    margin-bottom: 4px;
  }
  .wd-pending-pill {
    position: fixed;
    right: 1rem;
    bottom: 4.5rem;
    z-index: 50;
    padding: 8px 14px;
    border-radius: 999px;
    background: var(--status-modified-fg);
    color: #fff;
    box-shadow: 0 4px 16px rgba(0,0,0,0.2);
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    font-size: 13px;
    cursor: pointer;
    border: none;
    display: none;
    align-items: center;
    gap: 6px;
  }
  body[data-review="true"] .wd-pending-pill.wd-visible { display: inline-flex; }
  .wd-pending-pill:hover { filter: brightness(1.08); }
  .wd-comment-form-actions button.wd-btn-secondary {
    background: var(--sidebar-bg);
    color: var(--fg);
    border-color: var(--border);
  }
  .wd-comment-author {
    font-size: 10px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--hunk-fg);
    margin-bottom: 2px;
  }
  .wd-comment.wd-author-claude {
    border-left: 3px solid #7c3aed;
    background: rgba(124, 58, 237, 0.07);
    padding-left: 8px;
    border-radius: 0 4px 4px 0;
  }
  .wd-comment.wd-author-claude .wd-comment-author { color: #7c3aed; }
  .wd-comment-reply {
    margin-left: 20px;
    border-top: 1px dashed var(--border);
    padding-top: 6px;
    margin-top: 4px;
  }
  .wd-comment-action-link {
    background: none;
    border: none;
    color: var(--hunk-fg);
    cursor: pointer;
    padding: 0;
    font-size: 11px;
  }
  .wd-comment-outdated-badge {
    display: inline-block;
    background: var(--status-modified-bg);
    color: var(--status-modified-fg);
    font-size: 10px;
    font-weight: 600;
    padding: 1px 6px;
    border-radius: 3px;
    margin-bottom: 4px;
  }
  .wd-comment-body { color: var(--fg); }
  .wd-comment-body p { margin: 0 0 0.4em; }
  .wd-comment-body p:last-child { margin-bottom: 0; }
  .wd-comment-body code {
    background: var(--ln-bg);
    padding: 1px 4px;
    border-radius: 3px;
    font-family: SFMono-Regular, Consolas, "Liberation Mono", monospace;
    font-size: 90%;
  }
  .wd-comment-body pre {
    background: var(--ln-bg);
    padding: 6px 8px;
    border-radius: 4px;
    overflow-x: auto;
    margin: 0.3em 0;
  }
  .wd-comment-body pre code { background: transparent; padding: 0; }
  .wd-comment-body ul, .wd-comment-body ol { margin: 0.3em 0; padding-left: 1.4em; }
  .wd-comment-body blockquote {
    margin: 0.3em 0;
    padding-left: 8px;
    border-left: 3px solid var(--border);
    color: var(--muted);
  }
  .wd-comment-body a { color: var(--hunk-fg); }
  .wd-comment-body h1, .wd-comment-body h2, .wd-comment-body h3 {
    font-size: 1.05em;
    margin: 0.3em 0;
    font-weight: 600;
  }
  .wd-comment-actions {
    margin-top: 2px;
    font-size: 11px;
    color: var(--muted);
    display: flex;
    gap: 8px;
  }
  .wd-comment-delete {
    background: none;
    border: none;
    color: var(--del-fg);
    cursor: pointer;
    padding: 0;
    font-size: 11px;
  }
  .wd-comment-form {
    margin: 4px 8px;
    padding: 6px 10px;
    background: var(--bg);
    border: 1px solid var(--hunk-fg);
    border-radius: 4px;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    font-size: 12px;
  }
  .wd-comment-form textarea {
    width: 100%;
    min-height: 60px;
    border: 1px solid var(--border);
    border-radius: 4px;
    background: var(--bg);
    color: var(--fg);
    padding: 6px 8px;
    font-family: inherit;
    font-size: 12px;
    resize: vertical;
    box-sizing: border-box;
  }
  .wd-comment-form-actions {
    display: flex;
    gap: 6px;
    margin-top: 4px;
    justify-content: flex-end;
  }
  .wd-comment-form button {
    padding: 4px 10px;
    border-radius: 4px;
    border: 1px solid var(--border);
    background: var(--sidebar-bg);
    color: var(--fg);
    cursor: pointer;
    font-size: 11px;
  }
  .wd-comment-form button[type="submit"] {
    background: var(--hunk-fg);
    color: #fff;
    border-color: var(--hunk-fg);
  }
</style>`;

export const REVIEW_SCRIPT = `
<script>
(function () {
  if (document.body.getAttribute('data-review') !== 'true') return;

  // Subscribe to reload events pushed by the server when files change.
  // Comments live server-side so they survive the reload; the browser
  // re-fetches them via /api/comments on the next page load.
  // Defer reload while the user is composing — anywhere a textarea has unsaved
  // text. Covers the inline line composer, the reply composer, and the
  // general-comment composer at the top of the page.
  let reloadPending = false;
  function hasUnsavedText(sel) {
    const els = document.querySelectorAll(sel);
    for (let i = 0; i < els.length; i++) {
      if (els[i].value && els[i].value.trim().length > 0) return true;
    }
    return false;
  }
  function isComposing() {
    return (
      hasUnsavedText('.wd-composer-row textarea') ||
      hasUnsavedText('.wd-reply-form textarea') ||
      hasUnsavedText('.wd-general-input')
    );
  }
  let commentsRefreshPending = false;
  function tryApplyPendingReload() {
    if (reloadPending && !isComposing()) location.reload();
    if (commentsRefreshPending && !isComposing()) {
      commentsRefreshPending = false;
      fetchComments();
    }
  }
  try {
    const es = new EventSource('/events');
    es.addEventListener('reload', function () {
      if (isComposing()) {
        reloadPending = true;
      } else {
        location.reload();
      }
    });
    // Pushed by the server when any client adds/deletes a comment (notably
    // when Claude posts a reply via the API). Cheap refresh — no page reload.
    es.addEventListener('comments-changed', function () {
      if (isComposing()) {
        commentsRefreshPending = true;
      } else {
        fetchComments();
      }
    });
  } catch (e) { /* SSE not supported; user can F5 manually */ }

  let comments = [];

  function fetchComments() {
    return fetch('/api/comments').then(function (r) { return r.json(); })
      .then(function (data) {
        comments = data.comments || [];
        renderAll();
      })
      .catch(function () { /* offline; user can retry */ });
  }

  function postComment(payload) {
    return fetch('/api/comments', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }).then(function (r) { return r.json(); })
      .then(function (data) {
        if (data.comments) {
          comments = data.comments;
          renderAll();
        }
      });
  }

  function deleteComment(id) {
    return fetch('/api/comments/' + id, { method: 'DELETE' })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        comments = data.comments || [];
        renderAll();
      });
  }

  function postDone() {
    fetch('/api/done', { method: 'POST' })
      .then(function () {
        document.body.innerHTML =
          '<div style="font:14px sans-serif; padding:2rem;">' +
          '<h1>Review ended.</h1>' +
          '<p>You can close this tab.</p>' +
          '</div>';
      });
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // Build a map: row-key -> tr element, where row-key identifies a diff line.
  // For unified rows: key = repo:::file:::line:::side
  // For side-by-side rows: each side has its own line number; we generate
  // two keys (one for old, one for new).
  function rowsFor(repo, file, line, side) {
    const matches = [];
    document.querySelectorAll('section.wd-repo[data-repo-name="' + CSS.escape(repo) + '"] article.wd-file[data-path="' + CSS.escape(file) + '"]')
      .forEach(function (article) {
        article.querySelectorAll('tr.wd-row').forEach(function (tr) {
          const oldLn = tr.querySelector('.wd-ln-old');
          const newLn = tr.querySelector('.wd-ln-new');
          const oldNum = oldLn && oldLn.textContent.trim();
          const newNum = newLn && newLn.textContent.trim();
          if (side === 'right' && newNum && Number(newNum) === line) {
            matches.push({ tr: tr, span: tr.querySelectorAll('td').length });
          } else if (side === 'left' && oldNum && Number(oldNum) === line) {
            matches.push({ tr: tr, span: tr.querySelectorAll('td').length });
          }
        });
      });
    return matches;
  }

  function clearRendered() {
    document.querySelectorAll('tr.wd-comment-row').forEach(function (r) { r.remove(); });
  }

  function renderMarkdown(text) {
    if (typeof marked === 'undefined' || typeof DOMPurify === 'undefined') {
      return null;
    }
    try {
      const raw = marked.parse(text, { breaks: true, gfm: true });
      return DOMPurify.sanitize(raw, { USE_PROFILES: { html: true } });
    } catch (e) {
      return null;
    }
  }

  function buildCommentItem(c, currentContent) {
    const item = document.createElement('div');
    item.className = 'wd-comment';
    item.classList.add('wd-author-' + (c.author || 'user'));
    if (c.parentId) item.classList.add('wd-comment-reply');
    if (c.status === 'draft') {
      item.classList.add('wd-status-draft');
      const draftBadge = document.createElement('div');
      draftBadge.className = 'wd-draft-badge';
      draftBadge.textContent = 'PENDING';
      item.appendChild(draftBadge);
    }
    const outdated = c.lineContent !== undefined && c.lineContent !== currentContent;
    if (outdated) {
      item.classList.add('wd-comment-outdated');
      const badge = document.createElement('div');
      badge.className = 'wd-comment-outdated-badge';
      badge.textContent = 'outdated — line has changed since this comment was written';
      item.appendChild(badge);
    }
    if (c.author === 'claude') {
      const a = document.createElement('div');
      a.className = 'wd-comment-author';
      a.textContent = 'Claude';
      item.appendChild(a);
    }
    const body = document.createElement('div');
    body.className = 'wd-comment-body';
    const html = renderMarkdown(c.body);
    if (html) {
      body.innerHTML = html;
    } else {
      body.textContent = c.body;
    }
    item.appendChild(body);
    const actions = document.createElement('div');
    actions.className = 'wd-comment-actions';
    // Every comment can be replied to — including replies themselves. A
    // reply to a reply targets the same parent so the thread stays flat
    // (no nested indentation; matches GitHub PR review threads).
    const reply = document.createElement('button');
    reply.className = 'wd-comment-action-link';
    reply.textContent = 'reply';
    reply.addEventListener('click', function () {
      const target = c.parentId
        ? comments.find(function (x) { return x.id === c.parentId; }) || c
        : c;
      openReplyComposer(target, item);
    });
    actions.appendChild(reply);
    const del = document.createElement('button');
    del.className = 'wd-comment-delete';
    del.textContent = 'delete';
    del.addEventListener('click', function () { deleteComment(c.id); });
    actions.appendChild(del);
    item.appendChild(actions);
    return item;
  }

  function openReplyComposer(parent, anchorEl) {
    const existing = anchorEl.parentNode.querySelector('.wd-reply-form');
    if (existing) { existing.querySelector('textarea').focus(); return; }
    const form = document.createElement('div');
    form.className = 'wd-comment-form wd-reply-form';
    form.innerHTML =
      '<textarea placeholder="Reply…"></textarea>' +
      '<div class="wd-comment-form-actions">' +
      '<button type="button" data-action="cancel">Cancel</button>' +
      '<button type="submit" data-action="save">Reply (Ctrl+Enter)</button>' +
      '</div>';
    anchorEl.parentNode.insertBefore(form, anchorEl.nextSibling);
    const textarea = form.querySelector('textarea');
    setTimeout(function () { textarea.focus(); }, 0);
    function save() {
      const text = textarea.value.trim();
      if (!text) { form.remove(); tryApplyPendingReload(); return; }
      postComment({ parentId: parent.id, body: text });
      form.remove();
      tryApplyPendingReload();
    }
    function cancel() { form.remove(); tryApplyPendingReload(); }
    form.querySelector('[data-action="save"]').addEventListener('click', save);
    form.querySelector('[data-action="cancel"]').addEventListener('click', cancel);
    textarea.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        save();
      } else if (e.key === 'Escape') {
        cancel();
      }
    });
  }

  function renderGeneralList() {
    const listEl = document.querySelector('.wd-general-pane-list');
    if (!listEl) return;
    listEl.innerHTML = '';
    // General comments have no anchor, so no "outdated" check applies.
    const topLevel = comments.filter(function (c) {
      return c.side === 'general' && !c.parentId;
    });
    topLevel.forEach(function (parent) {
      const wrapper = document.createElement('div');
      wrapper.className = 'wd-comment-list';
      wrapper.appendChild(buildCommentItem(parent, undefined));
      const replies = comments
        .filter(function (c) { return c.parentId === parent.id; })
        .sort(function (a, b) { return a.createdAt.localeCompare(b.createdAt); });
      replies.forEach(function (r) {
        wrapper.appendChild(buildCommentItem(r, undefined));
      });
      listEl.appendChild(wrapper);
    });
  }

  function renderCommentsPanels() {

    // For each repo section, fill its sidebar comments panel with the
    // line-anchored comments belonging to that repo.
    document.querySelectorAll('section.wd-repo').forEach(function (section) {
      const repoName = section.getAttribute('data-repo-name') || '';
      const list = section.querySelector('.wd-comments-panel-list');
      const countEl = section.querySelector('.wd-comments-panel-count');
      if (!list || !countEl) return;
      // Top-level comments anchored to this repo, plus general comments
      // (which don't belong to any repo but apply to the whole review).
      const repoComments = comments.filter(function (c) {
        if (c.parentId) return false;
        if (c.side === 'general') return true;
        return c.repo === repoName;
      });
      countEl.textContent = '(' + repoComments.length + ')';
      list.innerHTML = '';
      if (repoComments.length === 0) {
        const empty = document.createElement('li');
        empty.className = 'wd-comments-panel-empty';
        empty.textContent = 'No comments yet.';
        list.appendChild(empty);
        return;
      }
      repoComments.forEach(function (c) {
        const li = document.createElement('li');
        const loc = document.createElement('div');
        loc.className = 'wd-comments-panel-loc';
        if (c.side === 'general') {
          loc.textContent = 'General';
        } else {
          loc.textContent = c.file + ':' + c.line;
          const rows = rowsFor(c.repo, c.file, c.line, c.side);
          if (rows.length && c.lineContent !== undefined) {
            const cur = contentAt(rows[0].tr, c.side);
            if (cur !== c.lineContent) loc.classList.add('wd-outdated');
          }
        }
        const body = document.createElement('div');
        body.className = 'wd-comments-panel-body';
        body.textContent = c.body;
        li.appendChild(loc);
        li.appendChild(body);
        li.addEventListener('click', function () {
          if (c.side === 'general') {
            // General comments live in the collapsible pane at the top.
            // Open it if collapsed, then scroll the panel into view.
            const pane = document.querySelector('.wd-general-pane');
            const details = pane && pane.querySelector('details');
            if (details && !details.open) details.open = true;
            if (pane) pane.scrollIntoView({ behavior: 'smooth', block: 'start' });
            return;
          }
          const rows = rowsFor(c.repo, c.file, c.line, c.side);
          if (!rows.length) return;
          const lineTr = rows[0].tr;
          const commentTr = lineTr.nextElementSibling;
          const target = (commentTr && commentTr.classList.contains('wd-comment-row'))
            ? commentTr
            : lineTr;
          target.scrollIntoView({ behavior: 'smooth', block: 'center' });
          target.classList.add('wd-row-flash');
          setTimeout(function () { target.classList.remove('wd-row-flash'); }, 1200);
        });
        list.appendChild(li);
      });
    });
  }

  function renderAll() {
    clearRendered();
    renderGeneralList();
    renderCommentsPanels();
    // Group ONLY top-level comments by line anchor; replies sit under their parent.
    const grouped = new Map();
    comments.forEach(function (c) {
      if (c.parentId) return; // replies are rendered under their parent below
      if (c.side === 'general') return;
      const key = c.repo + '|' + c.file + '|' + c.line + '|' + c.side;
      const arr = grouped.get(key) || [];
      arr.push(c);
      grouped.set(key, arr);
    });
    grouped.forEach(function (arr, key) {
      const [repo, file, line, side] = key.split('|');
      const rows = rowsFor(repo, file, Number(line), side);
      if (!rows.length) return;
      const tr = rows[0].tr;
      const cells = rows[0].span;
      const currentContent = contentAt(tr, side);
      const newTr = document.createElement('tr');
      newTr.className = 'wd-comment-row';
      const list = document.createElement('div');
      list.className = 'wd-comment-list';
      arr.forEach(function (parent) {
        list.appendChild(buildCommentItem(parent, currentContent));
        // Append replies (sorted oldest-first) under this parent.
        const replies = comments
          .filter(function (c) { return c.parentId === parent.id; })
          .sort(function (a, b) { return a.createdAt.localeCompare(b.createdAt); });
        replies.forEach(function (r) {
          list.appendChild(buildCommentItem(r, currentContent));
        });
      });
      // 4 cells = side-by-side: place list under just the left or right half.
      // 3 cells = unified: full-width.
      if (cells === 4) {
        const left = document.createElement('td');
        const right = document.createElement('td');
        left.colSpan = 2;
        right.colSpan = 2;
        if (side === 'left') {
          left.className = 'wd-comment-side';
          right.className = 'wd-comment-empty';
          left.appendChild(list);
        } else {
          left.className = 'wd-comment-empty';
          right.className = 'wd-comment-side';
          right.appendChild(list);
        }
        newTr.appendChild(left);
        newTr.appendChild(right);
      } else {
        const td = document.createElement('td');
        td.colSpan = cells;
        td.className = 'wd-comment-side';
        td.appendChild(list);
        newTr.appendChild(td);
      }
      tr.parentNode.insertBefore(newTr, tr.nextSibling);
    });
    // Update done counter — only published comments count toward the total
    // that gets sent to the consumer.
    const published = comments.filter(function (c) { return c.status === 'published'; });
    const counter = document.querySelector('.wd-done-count');
    if (counter) counter.textContent = String(published.length);
    // Update pending-review pill: visible only when any drafts exist.
    const drafts = comments.filter(function (c) { return c.status === 'draft'; });
    const pill = document.querySelector('.wd-pending-pill');
    const pillCount = document.querySelector('.wd-pending-count');
    if (pill && pillCount) {
      if (drafts.length > 0) {
        pill.classList.add('wd-visible');
        pillCount.textContent = '(' + drafts.length + ')';
      } else {
        pill.classList.remove('wd-visible');
      }
    }
  }

  function hasDrafts() {
    return comments.some(function (c) { return c.status === 'draft'; });
  }

  function openComposer(tr, repo, file, line, side, cells, lineContent) {
    // Close any existing composer first.
    document.querySelectorAll('tr.wd-composer-row').forEach(function (r) { r.remove(); });
    const newTr = document.createElement('tr');
    newTr.className = 'wd-composer-row';
    const form = document.createElement('div');
    form.className = 'wd-comment-form';
    const reviewLabel = hasDrafts() ? 'Add to review' : 'Start review';
    form.innerHTML =
      '<div style="font-size:11px;color:var(--muted);margin-bottom:4px;">' +
      escapeHtml(repo) + ' / ' + escapeHtml(file) + ' : line ' + line + ' (' + side + ')' +
      '</div>' +
      '<textarea placeholder="Leave a review comment..." autofocus></textarea>' +
      '<div class="wd-comment-form-actions">' +
      '<button type="button" data-action="cancel">Cancel</button>' +
      '<button type="button" class="wd-btn-secondary" data-action="draft">' + reviewLabel + '</button>' +
      '<button type="submit" data-action="save">Comment (Ctrl+Enter)</button>' +
      '</div>';
    // Scope the composer to just the side it was opened on (side-by-side mode).
    if (cells === 4) {
      const left = document.createElement('td');
      const right = document.createElement('td');
      left.colSpan = 2;
      right.colSpan = 2;
      if (side === 'left') {
        left.className = 'wd-comment-side';
        right.className = 'wd-comment-empty';
        left.appendChild(form);
      } else {
        left.className = 'wd-comment-empty';
        right.className = 'wd-comment-side';
        right.appendChild(form);
      }
      newTr.appendChild(left);
      newTr.appendChild(right);
    } else {
      const td = document.createElement('td');
      td.colSpan = cells;
      td.className = 'wd-comment-side';
      td.appendChild(form);
      newTr.appendChild(td);
    }
    tr.parentNode.insertBefore(newTr, tr.nextSibling);
    const textarea = form.querySelector('textarea');
    setTimeout(function () { textarea.focus(); }, 0);
    function submit(status) {
      const text = textarea.value.trim();
      if (!text) { newTr.remove(); tryApplyPendingReload(); return; }
      postComment({
        repo: repo, file: file, line: line, side: side,
        body: text, lineContent: lineContent, status: status,
      });
      newTr.remove();
      tryApplyPendingReload();
    }
    function cancel() { newTr.remove(); tryApplyPendingReload(); }
    form.querySelector('[data-action="save"]').addEventListener('click', function () { submit('published'); });
    form.querySelector('[data-action="draft"]').addEventListener('click', function () { submit('draft'); });
    form.querySelector('[data-action="cancel"]').addEventListener('click', cancel);
    textarea.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        submit('published');
      } else if (e.key === 'Escape') {
        cancel();
      }
    });
  }

  // Helper: get the raw text of a row's content cell on a given side.
  function contentAt(tr, side) {
    const cells = tr.querySelectorAll('td');
    if (cells.length === 4) {
      // side-by-side: 0=ln-old, 1=content-old, 2=ln-new, 3=content-new
      const cell = side === 'left' ? cells[1] : cells[3];
      return cell ? cell.textContent : '';
    }
    if (cells.length === 3) {
      // unified: 0=ln-old, 1=ln-new, 2=content
      return cells[2] ? cells[2].textContent : '';
    }
    return '';
  }

  // Wire up line-number clicks.
  document.querySelectorAll('section.wd-repo').forEach(function (section) {
    const repo = section.getAttribute('data-repo-name') || '';
    section.querySelectorAll('article.wd-file').forEach(function (article) {
      const file = article.getAttribute('data-path') || '';
      article.querySelectorAll('tr.wd-row').forEach(function (tr) {
        const td = Array.from(tr.children);
        const cells = td.length;
        tr.querySelectorAll('.wd-ln').forEach(function (ln) {
          ln.addEventListener('click', function (e) {
            e.stopPropagation();
            const text = ln.textContent.trim();
            if (!text) return;
            const line = Number(text);
            if (!Number.isFinite(line)) return;
            const side = ln.classList.contains('wd-ln-new') ? 'right' : 'left';
            const lineContent = contentAt(tr, side);
            openComposer(tr, repo, file, line, side, cells, lineContent);
          });
        });
      });
    });
  });

  function confirmDone(publishedCount, draftCount) {
    return new Promise(function (resolve) {
      const backdrop = document.createElement('div');
      backdrop.className = 'wd-modal-backdrop';
      const modal = document.createElement('div');
      modal.className = 'wd-modal';
      // Body copy adapts to the published/draft mix.
      let body;
      if (draftCount > 0) {
        body =
          '<p><strong style="color:var(--status-modified-fg)">You have ' + draftCount +
          ' pending comment' + (draftCount === 1 ? '' : 's') +
          '.</strong> They have not been sent yet and will be lost if you end the review now.</p>' +
          (publishedCount > 0
            ? '<p style="color:var(--muted);font-size:12px;">' + publishedCount + ' comment' +
              (publishedCount === 1 ? ' was' : 's were') +
              ' already delivered.</p>'
            : '');
      } else if (publishedCount === 0) {
        body = '<p>You have left no comments. Closing the session will exit wd with no further action.</p>';
      } else {
        body = '<p>Your ' + publishedCount + ' comment' + (publishedCount === 1 ? '' : 's') +
          ' ' + (publishedCount === 1 ? 'has' : 'have') +
          ' already been delivered. Closing the session will exit wd. You can then close the tab.</p>';
      }
      const submitButton = draftCount > 0
        ? '<button type="button" data-action="submit-then-end">Submit pending then end</button>'
        : '';
      modal.innerHTML =
        '<h2>End review?</h2>' + body +
        '<div class="wd-modal-actions">' +
        '<button type="button" data-action="cancel">Cancel</button>' +
        submitButton +
        '<button type="button" class="wd-modal-primary" data-action="ok">' +
        (draftCount > 0 ? 'End anyway (discard drafts)' : 'End review') +
        '</button>' +
        '</div>';
      backdrop.appendChild(modal);
      document.body.appendChild(backdrop);
      function cleanup(value) {
        document.body.removeChild(backdrop);
        document.removeEventListener('keydown', onKey);
        resolve(value);
      }
      function onKey(e) {
        if (e.key === 'Escape') cleanup({ action: 'cancel' });
      }
      modal.querySelector('[data-action="ok"]').addEventListener('click', function () { cleanup({ action: 'end' }); });
      const submitBtn = modal.querySelector('[data-action="submit-then-end"]');
      if (submitBtn) submitBtn.addEventListener('click', function () { cleanup({ action: 'submit-then-end' }); });
      modal.querySelector('[data-action="cancel"]').addEventListener('click', function () { cleanup({ action: 'cancel' }); });
      backdrop.addEventListener('click', function (e) { if (e.target === backdrop) cleanup({ action: 'cancel' }); });
      document.addEventListener('keydown', onKey);
      const primary = modal.querySelector('.wd-modal-primary');
      setTimeout(function () { primary.focus(); }, 0);
    });
  }

  // Wire up the general-comment composer.
  const generalInput = document.querySelector('.wd-general-input');
  const generalSubmit = document.querySelector('.wd-general-submit');
  const generalDraft = document.querySelector('.wd-general-draft');
  if (generalInput && generalSubmit) {
    function updateGeneralState() {
      const empty = !generalInput.value.trim();
      generalSubmit.disabled = empty;
      if (generalDraft) {
        generalDraft.disabled = empty;
        generalDraft.textContent = hasDrafts() ? 'Add to review' : 'Start review';
      }
    }
    generalInput.addEventListener('input', function () {
      updateGeneralState();
      if (!generalInput.value.trim()) tryApplyPendingReload();
    });
    function submitGeneral(status) {
      const text = generalInput.value.trim();
      if (!text) return;
      postComment({ repo: '', file: '', line: 0, side: 'general', body: text, status: status });
      generalInput.value = '';
      updateGeneralState();
      tryApplyPendingReload();
    }
    generalSubmit.addEventListener('click', function () { submitGeneral('published'); });
    if (generalDraft) {
      generalDraft.addEventListener('click', function () { submitGeneral('draft'); });
    }
    generalInput.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        submitGeneral('published');
      }
    });
  }

  function openSubmitReviewModal(draftCount) {
    return new Promise(function (resolve) {
      const backdrop = document.createElement('div');
      backdrop.className = 'wd-modal-backdrop';
      const modal = document.createElement('div');
      modal.className = 'wd-modal';
      modal.style.maxWidth = '460px';
      modal.innerHTML =
        '<h2>Submit your review</h2>' +
        '<p>Sending ' + draftCount + ' pending comment' + (draftCount === 1 ? '' : 's') +
        '. Add a summary if you like, then click Submit to send everything to Claude.</p>' +
        '<textarea style="width:100%;min-height:80px;padding:6px 8px;border:1px solid var(--border);border-radius:4px;background:var(--bg);color:var(--fg);font:inherit;font-size:12px;resize:vertical;box-sizing:border-box;" placeholder="Optional summary…"></textarea>' +
        '<div class="wd-modal-actions" style="margin-top:10px;">' +
        '<button type="button" data-action="discard">Discard drafts</button>' +
        '<button type="button" data-action="cancel">Cancel</button>' +
        '<button type="button" class="wd-modal-primary" data-action="submit">Submit review</button>' +
        '</div>';
      backdrop.appendChild(modal);
      document.body.appendChild(backdrop);
      const textarea = modal.querySelector('textarea');
      function cleanup(value) {
        document.body.removeChild(backdrop);
        document.removeEventListener('keydown', onKey);
        resolve(value);
      }
      function onKey(e) {
        if (e.key === 'Escape') cleanup({ action: 'cancel' });
      }
      modal.querySelector('[data-action="submit"]').addEventListener('click', function () {
        cleanup({ action: 'submit', summary: textarea.value.trim() });
      });
      modal.querySelector('[data-action="discard"]').addEventListener('click', function () {
        if (confirm('Discard all ' + draftCount + ' pending comment' + (draftCount === 1 ? '' : 's') + '?')) {
          cleanup({ action: 'discard' });
        }
      });
      modal.querySelector('[data-action="cancel"]').addEventListener('click', function () { cleanup({ action: 'cancel' }); });
      backdrop.addEventListener('click', function (e) { if (e.target === backdrop) cleanup({ action: 'cancel' }); });
      document.addEventListener('keydown', onKey);
      setTimeout(function () { textarea.focus(); }, 0);
    });
  }

  function submitReview(summary) {
    return fetch('/api/submit-review', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ summary: summary || '' }),
    }).then(function (r) { return r.json(); })
      .then(function (data) {
        if (data.comments) {
          comments = data.comments;
          renderAll();
        }
      });
  }

  function discardReview() {
    return fetch('/api/discard-review', { method: 'POST' })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (data.comments) {
          comments = data.comments;
          renderAll();
        }
      });
  }

  const pendingPill = document.querySelector('.wd-pending-pill');
  if (pendingPill) {
    pendingPill.addEventListener('click', async function () {
      const drafts = comments.filter(function (c) { return c.status === 'draft'; });
      if (drafts.length === 0) return;
      const result = await openSubmitReviewModal(drafts.length);
      if (result.action === 'submit') {
        await submitReview(result.summary);
      } else if (result.action === 'discard') {
        await discardReview();
      }
    });
  }

  // Wire up End review button.
  const doneBtn = document.querySelector('.wd-done-bar');
  if (doneBtn) {
    doneBtn.addEventListener('click', async function () {
      const publishedCount = comments.filter(function (c) { return c.status === 'published'; }).length;
      const draftCount = comments.filter(function (c) { return c.status === 'draft'; }).length;
      const result = await confirmDone(publishedCount, draftCount);
      if (result.action === 'cancel') return;
      if (result.action === 'submit-then-end') {
        doneBtn.setAttribute('disabled', 'true');
        doneBtn.textContent = 'Submitting…';
        await submitReview('');
      }
      doneBtn.setAttribute('disabled', 'true');
      doneBtn.textContent = 'Closing...';
      postDone();
    });
  }

  fetchComments();
})();
</script>`;

/**
 * Saves the viewed-checkbox set and scroll position to sessionStorage on
 * page unload, and restores them on load. Lets the diff survive an F5 (or
 * a regen by the watcher daemon) without losing review state.
 */
export const STATE_PRESERVATION_SCRIPT = `
<script>
(function () {
  try {
    const raw = sessionStorage.getItem('wd-live-state');
    if (raw) {
      const state = JSON.parse(raw);
      if (state && Array.isArray(state.viewed)) {
        state.viewed.forEach(function (key) {
          const f = document.querySelector(
            'article.wd-file[data-viewed-key="' + CSS.escape(key) + '"]',
          );
          if (!f) return;
          const cb = f.querySelector('.wd-viewed-checkbox');
          if (cb) {
            cb.checked = true;
            cb.dispatchEvent(new Event('change'));
          }
        });
      }
      if (typeof state.scrollY === 'number') {
        window.scrollTo(0, state.scrollY);
      }
    }
  } catch (e) { /* ignore */ }

  function saveState() {
    try {
      const viewed = Array.from(
        document.querySelectorAll('.wd-viewed-checkbox:checked'),
      ).map(function (cb) {
        const a = cb.closest('article.wd-file');
        return a ? a.getAttribute('data-viewed-key') : null;
      }).filter(Boolean);
      sessionStorage.setItem('wd-live-state', JSON.stringify({
        viewed: viewed,
        scrollY: window.scrollY,
      }));
    } catch (e) { /* ignore */ }
  }
  window.addEventListener('beforeunload', saveState);
})();
</script>`;
