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
