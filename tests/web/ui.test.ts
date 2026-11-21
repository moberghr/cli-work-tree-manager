// @vitest-environment jsdom
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  Badge,
  Button,
  Chip,
  Input,
  ListRow,
  PageHeader,
  SectionTitle,
  Segmented,
  Select,
  Tab,
  TextArea,
  ToggleChip,
  badgeClass,
  buttonClass,
  fieldClass,
} from '../../src/web/src/ui/index.js';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** The shared pieces of the web UI: one implementation of each control, on the scale in tokens.css. */
let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});
const render = (el: ReturnType<typeof createElement>) => act(() => root.render(el));

describe('Button', () => {
  it('each kind renders the class the pages already used, and never submits a form unless told to', () => {
    expect(buttonClass()).toBe('wd-btn-secondary');
    expect(buttonClass('primary')).toBe('wd-btn-primary');
    // The main action that destroys something: filled red; a toolbar's may be small like any framed one.
    expect(buttonClass('danger')).toBe('wd-btn-danger');
    expect(buttonClass('danger', { size: 'sm' })).toBe('wd-btn-danger wd-btn-sm');
    // One glyph and no words (a dialog's ×): square, beside the kind it is.
    expect(buttonClass('quiet', { icon: true, className: 'wd-modal-close' })).toBe('wd-topnav-btn wd-btn-icon wd-modal-close');
    expect(buttonClass('row', { danger: true })).toBe('wd-row-action wd-row-action-danger');
    // Danger is a row action's: another kind ignores it.
    expect(buttonClass('primary', { danger: true })).toBe('wd-btn-primary');
    expect(buttonClass('link', { className: 'mine' })).toBe('wd-link-button mine');
    expect(buttonClass('quiet')).toBe('wd-topnav-btn');
    // A link where the blue would shout: quiet grey, or the text around it; only a link takes a tone.
    expect(buttonClass('link', { tone: 'muted' })).toBe('wd-link-button wd-link-button-muted');
    expect(buttonClass('secondary', { tone: 'inherit' })).toBe('wd-btn-secondary');
    render(createElement(Button, { variant: 'primary' }, 'Ship'));
    const b = container.querySelector('button')!;
    expect(b.className).toBe('wd-btn-primary');
    expect(b.getAttribute('type')).toBe('button');
    expect(b.textContent).toBe('Ship');
  });

  it('passes on what a button takes: a click, disabled, a title; a submit when asked', () => {
    const onClick = vi.fn();
    render(createElement(Button, { onClick, title: 'Why', type: 'submit' }, 'Save'));
    const b = container.querySelector('button')!;
    act(() => b.click());
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(b.title).toBe('Why');
    expect(b.getAttribute('type')).toBe('submit');
    render(createElement(Button, { onClick, disabled: true }, 'Save'));
    expect(container.querySelector('button')!.disabled).toBe(true);
  });

  it('a toolbar’s is small: main and secondary take the size, a row’s, quiet or link one has its own', () => {
    expect(buttonClass('secondary', { size: 'sm' })).toBe('wd-btn-secondary wd-btn-sm');
    expect(buttonClass('primary', { size: 'sm', className: 'x' })).toBe('wd-btn-primary wd-btn-sm x');
    expect(buttonClass('row', { size: 'sm' })).toBe('wd-row-action');
    expect(buttonClass('link', { size: 'sm' })).toBe('wd-link-button');
    render(createElement(Button, { size: 'sm', className: 'wd-history-btn' }, 'Changes'));
    expect(container.querySelector('button')!.className).toBe('wd-btn-secondary wd-btn-sm wd-history-btn');
  });
});

describe('Input, TextArea', () => {
  it('a text box: the shared class beside the page’s, every attribute passed on, a ref to the element', () => {
    const onChange = vi.fn();
    const ref = { current: null as HTMLInputElement | null };
    render(createElement(Input, { className: 'wd-web-filter', type: 'search', placeholder: 'Filter files…', value: 'a', onChange, ref }));
    const input = container.querySelector('input')!;
    expect(input.className).toBe('wd-input wd-web-filter');
    expect(input.type).toBe('search');
    expect(input.placeholder).toBe('Filter files…');
    expect(ref.current).toBe(input);
    render(createElement(Input, {}));
    expect(container.querySelector('input')!.type).toBe('text');
  });

  it('a box of several lines carries both classes and its ref', () => {
    const ref = { current: null as HTMLTextAreaElement | null };
    render(createElement(TextArea, { className: 'wd-general-input', placeholder: 'A note', ref }));
    const ta = container.querySelector('textarea')!;
    expect(ta.className).toBe('wd-input wd-textarea wd-general-input');
    expect(ref.current).toBe(ta);
  });

  it('compact in a tight row: the small class, the page’s still beside it', () => {
    expect(fieldClass('', true, 'wd-repos-alias')).toBe('wd-input wd-input-sm wd-repos-alias');
    expect(fieldClass('wd-select', false, undefined)).toBe('wd-input wd-select');
    render(createElement(Input, { compact: true, className: 'wd-repos-alias', 'aria-label': 'Alias' }));
    const input = container.querySelector('input')!;
    expect(input.className).toBe('wd-input wd-input-sm wd-repos-alias');
    // `compact` is ours: it never reaches the element as an attribute.
    expect(input.hasAttribute('compact')).toBe(false);
  });

  it('bare: the search field across a palette, its class and role kept, no frame of its own', () => {
    render(createElement(Input, { bare: true, className: 'wd-switcher-input', role: 'combobox', 'aria-label': 'Go to' }));
    const input = container.querySelector('input')!;
    expect(input.className).toBe('wd-input wd-input-bare wd-switcher-input');
    expect(input.getAttribute('role')).toBe('combobox');
    expect(input.hasAttribute('bare')).toBe(false);
  });
});

describe('Select', () => {
  it('the same box as an Input with its options, its value and change passed on; compact too', () => {
    const onChange = vi.fn();
    render(
      createElement(
        Select,
        { value: 'merge', onChange, 'aria-label': 'Merge method' },
        createElement('option', { value: 'squash' }, 'squash'),
        createElement('option', { value: 'merge' }, 'merge commit'),
      ),
    );
    const sel = container.querySelector('select')!;
    expect(sel.className).toBe('wd-input wd-select');
    expect(sel.value).toBe('merge');
    expect(sel.getAttribute('aria-label')).toBe('Merge method');
    act(() => {
      sel.value = 'squash';
      sel.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(onChange).toHaveBeenCalledTimes(1);
    render(createElement(Select, { compact: true, value: '', onChange }, createElement('option', { value: '' }, '+ add')));
    expect(container.querySelector('select')!.className).toBe('wd-input wd-select wd-input-sm');
  });
});

describe('Segmented', () => {
  it('as tabs: a tablist whose tabs say which is selected; none when the value names none; dimmed, disabled, a class each', () => {
    const onChange = vi.fn();
    const options = [
      { value: 'api', label: 'api', className: 'mine' },
      { value: 'web', label: 'web', muted: true },
      { value: 'cli', label: 'cli', disabled: true },
    ];
    render(createElement(Segmented<string>, { kind: 'tabs', label: 'Repo', value: 'web', onChange, options }));
    const list = container.querySelector('[role="tablist"]')!;
    expect(list.getAttribute('aria-label')).toBe('Repo');
    const [api, web, cli] = [...list.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
    expect(api.getAttribute('aria-selected')).toBe('false');
    expect(api.hasAttribute('aria-pressed')).toBe(false);
    expect(api.className).toBe('wd-segmented-btn mine');
    // The one on is never dimmed (the stylesheet keys the dimming off its not being on).
    expect(web.className).toBe('wd-segmented-btn wd-segmented-btn-on wd-segmented-btn-muted');
    expect(web.getAttribute('aria-selected')).toBe('true');
    expect(cli.disabled).toBe(true);
    act(() => api.click());
    expect(onChange).toHaveBeenCalledWith('api');
    render(createElement(Segmented<string>, { kind: 'tabs', label: 'Repo', value: null, onChange, options }));
    expect(container.querySelectorAll('[aria-selected="true"]')).toHaveLength(0);
    expect(container.querySelectorAll('.wd-segmented-btn-on')).toHaveLength(0);
  });

  it('a named group of choices: the one that is on says so, and a click on another tells its value', () => {
    const onChange = vi.fn();
    render(
      createElement(Segmented<'repo' | 'none'>, {
        label: 'Group the reviews',
        value: 'repo',
        onChange,
        options: [
          { value: 'repo', label: 'Repo' },
          { value: 'none', label: 'None', title: 'One list' },
        ],
      }),
    );
    const group = container.querySelector('[role="group"]')!;
    expect(group.getAttribute('aria-label')).toBe('Group the reviews');
    const [repo, none] = [...group.querySelectorAll('button')];
    expect(repo.className).toBe('wd-segmented-btn wd-segmented-btn-on');
    expect(repo.getAttribute('aria-pressed')).toBe('true');
    expect(none.className).toBe('wd-segmented-btn');
    expect(none.getAttribute('aria-pressed')).toBe('false');
    expect(none.title).toBe('One list');
    act(() => none.click());
    expect(onChange).toHaveBeenCalledWith('none');
  });
});

describe('Badge', () => {
  it('a count is filled in the app’s blue unless told; a tag, a state, a letter are neutral unless told; the page’s class stays', () => {
    expect(badgeClass('count')).toBe('wd-badge wd-badge-count wd-badge-accent');
    expect(badgeClass('count', 'danger')).toBe('wd-badge wd-badge-count wd-badge-danger');
    expect(badgeClass()).toBe('wd-badge wd-badge-tag');
    expect(badgeClass('status', 'review', 'wd-rail-slot-owed')).toBe('wd-badge wd-badge-status wd-badge-review wd-rail-slot-owed');
    expect(badgeClass('letter', 'ok')).toBe('wd-badge wd-badge-letter wd-badge-ok');
    // Merged has its own colour; a draft, a kept row, an archived session are dashed.
    expect(badgeClass('tag', 'merged')).toBe('wd-badge wd-badge-tag wd-badge-merged');
    expect(badgeClass('tag', 'neutral', 'wd-pr-chip', true)).toBe('wd-badge wd-badge-tag wd-badge-dashed wd-pr-chip');
    render(createElement(Badge, { kind: 'count', tone: 'danger', className: 'wd-dash-tab-badge', 'aria-label': '6 need you' }, '6'));
    const b = container.querySelector('span')!;
    expect(b.className).toBe('wd-badge wd-badge-count wd-badge-danger wd-dash-tab-badge');
    expect(b.getAttribute('aria-label')).toBe('6 need you');
    expect(b.textContent).toBe('6');
  });
});

describe('Chip', () => {
  it('a value with its ×: the label says what it takes out; picked and wrong say so; a label round a checkbox', () => {
    const onClick = vi.fn();
    render(
      createElement(
        Chip,
        { className: 'wd-repos-root', remove: { label: 'Stop scanning ~/repos', title: 'Stop scanning this folder', onClick } },
        '~/repos',
      ),
    );
    const chip = container.querySelector('span')!;
    expect(chip.className).toBe('wd-chip wd-repos-root');
    const x = chip.querySelector('button')!;
    expect(x.getAttribute('aria-label')).toBe('Stop scanning ~/repos');
    expect(x.title).toBe('Stop scanning this folder');
    act(() => x.click());
    expect(onClick).toHaveBeenCalledTimes(1);
    render(createElement(Chip, { bad: true, remove: { label: 'Take web out', disabled: true, onClick } }, 'web'));
    expect(container.querySelector('span')!.className).toBe('wd-chip wd-chip-bad');
    expect(container.querySelector('button')!.disabled).toBe(true);
    render(createElement(Chip, { as: 'label', on: true }, createElement('input', { type: 'checkbox', defaultChecked: true }), 'api'));
    const label = container.querySelector('label')!;
    expect(label.className).toBe('wd-chip wd-chip-on');
    expect(label.querySelector('button')).toBeNull();
  });
});

describe('ToggleChip', () => {
  it('a chip you switch: a button that says whether it is on; the page’s class beside the shared one', () => {
    const onClick = vi.fn();
    render(createElement(ToggleChip, { on: true, className: 'wd-start-chip', onClick, title: 'Stop showing only api' }, 'api'));
    const b = container.querySelector('button')!;
    expect(b.getAttribute('aria-pressed')).toBe('true');
    expect(b.className).toBe('wd-chip wd-chip-toggle wd-chip-on wd-start-chip');
    expect(b.getAttribute('type')).toBe('button');
    act(() => b.click());
    expect(onClick).toHaveBeenCalledTimes(1);
    render(createElement(ToggleChip, { on: false }, 'web'));
    expect(container.querySelector('button')!.getAttribute('aria-pressed')).toBe('false');
    expect(container.querySelector('button')!.className).toBe('wd-chip wd-chip-toggle');
  });
});

describe('Tab', () => {
  it('a tab of a strip: role tab, says whether it is on, the page’s class beside the shared one, a click passed on', () => {
    const onClick = vi.fn();
    render(createElement(Tab, { active: true, className: 'wd-session-subtab wd-session-subtab-active', onClick }, 'Diff'));
    const tab = container.querySelector('button')!;
    expect(tab.getAttribute('role')).toBe('tab');
    expect(tab.getAttribute('aria-selected')).toBe('true');
    expect(tab.className).toBe('wd-tab wd-tab-on wd-session-subtab wd-session-subtab-active');
    expect(tab.getAttribute('type')).toBe('button');
    act(() => tab.click());
    expect(onClick).toHaveBeenCalledTimes(1);
    render(createElement(Tab, { active: false }, 'Code'));
    expect(container.querySelector('button')!.className).toBe('wd-tab');
    expect(container.querySelector('button')!.getAttribute('aria-selected')).toBe('false');
  });
});

describe('PageHeader, SectionTitle, ListRow', () => {
  it('a page’s title is its h1, with what it counts beside it and its controls on the right', () => {
    render(
      createElement(PageHeader, { title: 'Reviews', meta: '2 prepared today' }, createElement(Button, { variant: 'link' }, 'Which PRs…')),
    );
    const h1 = container.querySelector('header.wd-tab-header h1')!;
    expect(h1.textContent).toBe('Reviews 2 prepared today');
    expect(h1.querySelector('.wd-tab-header-muted')?.textContent).toBe(' 2 prepared today');
    expect(container.querySelector('.wd-tab-controls .wd-link-button')?.textContent).toBe('Which PRs…');
    // Nothing to count, no controls: neither is rendered.
    render(createElement(PageHeader, { title: 'Tasks', compact: true }));
    expect(container.querySelector('header')!.className).toBe('wd-tab-header wd-tab-header-compact');
    render(createElement(PageHeader, { title: 'Jira' }));
    expect(container.querySelector('.wd-tab-header-muted')).toBeNull();
    expect(container.querySelector('.wd-tab-controls')).toBeNull();
  });

  it('a section’s title is a heading of the level asked', () => {
    render(createElement(SectionTitle, { as: 'h3', meta: '· 2', className: 'wd-reviews-group-head', children: 'api' }));
    const h3 = container.querySelector('h3.wd-section-title.wd-reviews-group-head')!;
    expect(h3.textContent).toBe('api · 2');
    render(createElement(SectionTitle, { children: 'Needs you' }));
    expect(container.querySelector('h2.wd-section-title')?.textContent).toBe('Needs you');
  });

  it('a row you click: its title, the line under it, whether it is the one open, and the page’s own class beside the shared one', () => {
    const onClick = vi.fn();
    render(createElement(ListRow, { title: '#231 · Refunds', meta: 'ready @ana', active: true, className: 'wd-reviews-row', onClick }));
    const row = container.querySelector('button')!;
    expect(row.className).toBe('wd-list-row wd-list-row-active wd-reviews-row');
    expect(row.getAttribute('aria-current')).toBe('true');
    expect(row.querySelector('.wd-list-row-title')?.textContent).toBe('#231 · Refunds');
    expect(row.querySelector('.wd-list-row-meta')?.textContent).toBe('ready @ana');
    act(() => row.click());
    expect(onClick).toHaveBeenCalledTimes(1);
    render(createElement(ListRow, { title: 'x' }));
    expect(container.querySelector('button')!.getAttribute('aria-current')).toBeNull();
    expect(container.querySelector('.wd-list-row-meta')).toBeNull();
  });
});

const SRC = path.resolve(__dirname, '../../src/web/src');
/** Every page stylesheet: the shared ones and each page's own (styles/pages/), not tokens.css or the highlighter's. */
const PAGE_STYLESHEETS = [
  ...['dashboard.css', 'global.css', 'review.css', 'diff.css'].map((f) => `styles/${f}`),
  ...fs
    .readdirSync(path.join(SRC, 'styles/pages'))
    .filter((f) => f.endsWith('.css'))
    .map((f) => `styles/pages/${f}`),
];
/** The shared pieces' classes, their parts and states included (ui.css). */
const SHARED_CLASSES = [
  'wd-btn-primary',
  'wd-btn-secondary',
  'wd-btn-danger',
  'wd-row-action',
  'wd-row-action-danger',
  'wd-link-button',
  'wd-topnav-btn',
  'wd-topnav-btn-on',
  'wd-segmented',
  'wd-segmented-btn',
  'wd-segmented-btn-on',
  'wd-tab',
  'wd-tab-on',
  'wd-badge',
  'wd-badge-count',
  'wd-badge-tag',
  'wd-badge-status',
  'wd-badge-letter',
  'wd-badge-dashed',
  'wd-tab-header',
  'wd-tab-header-muted',
  'wd-tab-header-compact',
  'wd-chip',
  'wd-chip-on',
  'wd-chip-bad',
  'wd-chip-remove',
  'wd-chip-toggle',
  'wd-list-row',
  'wd-list-row-active',
  'wd-list-row-title',
  'wd-list-row-meta',
  'wd-section-title',
  'wd-section-title-meta',
  'wd-btn-sm',
  'wd-btn-icon',
  'wd-segmented-btn-muted',
  'wd-input',
  'wd-textarea',
  'wd-select',
  'wd-input-sm',
  'wd-input-bare',
];
/** What gives a control its look, as against where it sits (margin, width, flex, position). */
const LOOK =
  /^(padding(-[a-z]+)?|font(-[a-z]+)?|line-height|letter-spacing|text-transform|color|background(-[a-z]+)?|border(-[a-z]+)*|box-shadow|height|min-height|max-height|filter|opacity)$/;
const NAMES_SHARED = new RegExp(`\\.(${SHARED_CLASSES.join('|')})(?![\\w-])`);
/** A selector whose subject is every button of a container (`.x button`, `.x button:hover`). */
const BARE_BUTTON = /(^|[\s>+~])button(:[\w-]+(\([^)]*\))?)*$/;

/** `<file> <selector>` of each rule in `css` that gives a shared control (or every button of a container) a look. */
function restylesOfSharedControlsIn(file: string, css: string): string[] {
  const out: string[] = [];
  // Innermost `selector { declarations }` pairs: a rule inside @media is matched by itself.
  for (const m of css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const looks = [...m[2].matchAll(/(?:^|;)\s*([a-z-]+)\s*:/g)].some((d) => LOOK.test(d[1]));
    if (!looks) continue;
    for (const raw of m[1].split(',')) {
      const sel = raw.trim().replace(/\s+/g, ' ');
      if (sel.startsWith('@')) continue;
      // The subject (the last compound) is the control, a bare element inside it (a header's h1), or every
      // button of a container. A shared class earlier in the selector with another class as the subject is a
      // page's own element that happens to sit in one: not the control.
      const last = sel.split(/[\s>+~]+/).pop() ?? '';
      const isElement = /^[a-z][a-z0-9]*(:|\[|$)/.test(last);
      if (NAMES_SHARED.test(last) || (isElement && NAMES_SHARED.test(sel)) || BARE_BUTTON.test(sel)) out.push(`${file} ${sel}`);
    }
  }
  return out;
}
function restylesOfSharedControls(files: string[]): string[] {
  return files.flatMap((rel) => restylesOfSharedControlsIn(path.basename(rel), fs.readFileSync(path.join(SRC, rel), 'utf-8')));
}

describe('one implementation of each control', () => {
  const read = (rel: string) => fs.readFileSync(path.join(SRC, rel), 'utf-8');
  /** The rules that give a class its look (`.name {` or `.name,` at the start of a line), not ones that place it. */
  const defines = (css: string, cls: string) => new RegExp(`^\\.${cls}(\\s*\\{|,|:hover|:disabled)`, 'm').test(css);

  it('the shared controls are styled in ui.css and nowhere else, so a page can place one but not restyle it', () => {
    const ui = read('ui/ui.css');
    const pages = PAGE_STYLESHEETS.map(read);
    for (const cls of [
      'wd-btn-primary',
      'wd-btn-secondary',
      'wd-btn-danger',
      'wd-row-action',
      'wd-link-button',
      'wd-topnav-btn',
      'wd-segmented',
      'wd-segmented-btn',
      'wd-tab',
      'wd-badge',
      'wd-chip',
      'wd-tab-header',
      'wd-list-row',
      'wd-section-title',
      'wd-btn-sm',
      'wd-input',
      'wd-select',
    ]) {
      expect(defines(ui, cls), `${cls} is defined in ui.css`).toBe(true);
      for (const css of pages) expect(defines(css, cls), `${cls} is defined only in ui.css`).toBe(false);
    }
  });

  it('a page rule that reaches a shared control (or every button of a container) only places it: no look of its own', () => {
    // The guard above only sees a rule that starts with the shared class; `.wd-modal button.wd-btn-primary` or
    // `.wd-comment-form button` restyle the control just the same and, loaded later, win. These are the ones
    // that were there when the pieces arrived: each goes when its page is converted, and the list only shrinks
    // (a rule that is gone must leave it). A new one is a new piece, or a variant of one, in ui.css.
    const KNOWN: string[] = [];
    expect(restylesOfSharedControls(PAGE_STYLESHEETS).sort()).toEqual([...KNOWN].sort());
  });

  it('the restyle finder sees a reach through a parent, a bare button, inside @media; not placement or another class', () => {
    const found = restylesOfSharedControlsIn(
      'x.css',
      `.a .wd-btn-primary { background: red; }
       .b button:hover { filter: none; }
       @media (max-width: 1px) { .c .wd-tab-header { padding: 0; } }
       .d .wd-link-button { margin-left: auto; }   /* placement: fine */
       .e .wd-row-action-allow { color: green; }    /* its own class, not the shared one */
       .f button.wd-x span { color: red; }          /* not the button */
       /* .g .wd-seg { color: red; } a comment */`,
    );
    expect(found).toEqual(['x.css .a .wd-btn-primary', 'x.css .b button:hover', 'x.css .c .wd-tab-header']);
  });

  it('ui.css uses the scale: no size, radius or space written as a number of its own', () => {
    const ui = read('ui/ui.css').replace(/\/\*[\s\S]*?\*\//g, '');
    const literal = [...ui.matchAll(/(font-size|border-radius|padding|gap|min-height|margin):\s*([^;]+);/g)]
      .map((m) => `${m[1]}: ${m[2]}`)
      .filter((d) => /\d+px/.test(d.replace(/calc\([^)]*\)/g, '')) && !/^(padding|gap|margin): (0|2px)$/.test(d));
    expect(literal).toEqual([]);
    const tokens = read('styles/tokens.css');
    for (const t of ['--text-sm', '--text-md', '--radius', '--control-h', '--space-3']) expect(tokens).toContain(`${t}:`);
  });

  it('a modifier (small, icon) comes after every kind it changes, so it wins at the same specificity', () => {
    // An icon button was the quiet kind's 13 px until its rule moved below the kinds'.
    const ui = read('ui/ui.css');
    // Where the rule that starts with exactly this selector begins (`.name {` at the start of a line).
    const at = (sel: string) => ui.search(new RegExp('^' + sel.replace('.', '\\.') + ' \\{', 'm'));
    for (const kind of ['.wd-btn-primary', '.wd-btn-danger', '.wd-btn-secondary', '.wd-topnav-btn', '.wd-row-action']) {
      expect(at(kind), kind).toBeGreaterThan(-1);
      expect(at('.wd-btn-icon'), `.wd-btn-icon after ${kind}`).toBeGreaterThan(at(kind));
    }
    for (const kind of ['.wd-btn-primary', '.wd-btn-danger', '.wd-btn-secondary'])
      expect(at('.wd-btn-sm'), `.wd-btn-sm after ${kind}`).toBeGreaterThan(at(kind));
  });

  it('ui.css is loaded before the page stylesheets (a page’s placement rule wins; its look can’t be changed back)', () => {
    const main = read('main.tsx');
    expect(main.indexOf("'./ui/ui.css'")).toBeGreaterThan(main.indexOf("'./styles/global.css'"));
    expect(main.indexOf("'./ui/ui.css'")).toBeLessThan(main.indexOf("'./styles/dashboard.css'"));
  });

  it('every page’s stylesheet is loaded, after dashboard.css (one main.tsx forgot would do nothing)', () => {
    const main = read('main.tsx');
    const pages = PAGE_STYLESHEETS.filter((f) => f.startsWith('styles/pages/'));
    expect(pages).toContain('styles/pages/issues.css');
    for (const f of pages) expect(main.indexOf(`'./${f}'`), f).toBeGreaterThan(main.indexOf("'./styles/dashboard.css'"));
  });
});
