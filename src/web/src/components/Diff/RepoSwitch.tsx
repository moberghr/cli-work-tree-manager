import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type Ref } from 'react';
import { repoMenuSections, repoMoreButton, repoPills, type RepoMoreButton, type RepoSwitchItem } from '../../state/diff-view.js';

interface Props {
  /** Every repo of the session, in its order (repoSwitch). */
  items: RepoSwitchItem[];
  /** The repo on screen. */
  active: string | null;
  onPick: (name: string) => void;
}

/** What the line leaves the switch, each pill's width, and the list button's (its gap included). */
interface Measure {
  room: number;
  widths: Record<string, number>;
  more: number;
}

/** The pills' segmented border (1px a side), and a pixel spare for rounding. */
const GROUP_BORDER = 2;
const SLACK = 1;

/**
 * A group's repos in the Diff toolbar: a pill each while they all fit, as always; when they don't (a group of many,
 * or a narrow window), the ones with changes in this pick and the one on screen, as many as fit, and a button
 * listing every repo, with a search. It only ever takes the room the rest of the line leaves it, so the scope tabs,
 * the picker, what's shown and Split/Unified keep theirs.
 */
export function RepoSwitch({ items, active, onPick }: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const measureRef = useRef<HTMLDivElement>(null);
  // Not laid out (a test's DOM, a hidden tab): no measuring, every repo a pill.
  const [canMeasure, setCanMeasure] = useState(false);
  const [measure, setMeasure] = useState<Measure | null>(null);

  const remeasure = () => {
    const wrap = wrapRef.current;
    const toolbar = wrap?.closest<HTMLElement>('[role="toolbar"]');
    if (!wrap || !toolbar || toolbar.clientWidth === 0 || typeof ResizeObserver === 'undefined') return;
    if (!canMeasure) {
      setCanMeasure(true);
      return;
    }
    const box = measureRef.current;
    if (!box) return;
    const widths: Record<string, number> = {};
    for (const el of box.querySelectorAll<HTMLElement>('[data-repo]')) widths[el.dataset.repo!] = el.getBoundingClientRect().width;
    const moreBtn = box.querySelector<HTMLElement>('[data-more]');
    const next: Measure = {
      room: roomFor(wrap, toolbar) - GROUP_BORDER - SLACK,
      widths,
      more: (moreBtn?.getBoundingClientRect().width ?? 0) + px(getComputedStyle(wrap).columnGap),
    };
    setMeasure((prev) => (prev && sameMeasure(prev, next) ? prev : next));
  };
  const remeasureRef = useRef(remeasure);
  remeasureRef.current = remeasure;
  // After every render: the rest of the line (what's shown, the picker's label, the update chip) moves with the diff.
  useLayoutEffect(() => {
    remeasureRef.current();
  });
  useEffect(() => {
    if (!canMeasure) return;
    const toolbar = wrapRef.current?.closest<HTMLElement>('[role="toolbar"]');
    const ro = new ResizeObserver(() => remeasureRef.current());
    if (toolbar) ro.observe(toolbar);
    if (measureRef.current) ro.observe(measureRef.current); // the names' widths, once the font is in
    return () => ro.disconnect();
  }, [canMeasure]);

  const fit = measure ? repoPills(items, active, measure.room, (n) => measure.widths[n] ?? 0, measure.more) : { pills: items, more: false };

  return (
    <div ref={wrapRef} className="wd-diff-repo-switch-wrap">
      {fit.pills.length > 0 && (
        <div className="wd-web-diff-scope wd-diff-repo-switch" role="tablist" aria-label="Repo">
          {fit.pills.map((r) => {
            const on = r.name === active;
            return (
              <button
                key={r.name}
                type="button"
                role="tab"
                aria-selected={on}
                className={pillClass(r, on)}
                onClick={() => onPick(r.name)}
                title={repoTitle(r)}
              >
                <PillText repo={r} />
              </button>
            );
          })}
        </div>
      )}
      {fit.more && <RepoMenu items={items} active={active} button={repoMoreButton(items, fit.pills, active)} onPick={onPick} />}
      {canMeasure && (
        // Every repo as a pill, out of sight: what each would take (bold, as the one on screen is).
        <div className="wd-diff-repo-measure" aria-hidden="true" inert>
          <div ref={measureRef} className="wd-diff-repo-measure-row">
            <div className="wd-web-diff-scope">
              {items.map((r) => (
                <button key={r.name} type="button" tabIndex={-1} className={pillClass(r, true)} data-repo={r.name}>
                  <PillText repo={r} />
                </button>
              ))}
            </div>
            <MoreButtonBody button={{ label: `+${items.length}`, current: false, hidden: items.length, hiddenChanged: 1 }} data-more />
          </div>
        </div>
      )}
    </div>
  );
}

function pillClass(r: RepoSwitchItem, on: boolean): string {
  return 'wd-web-diff-scope-btn' + (on ? ' wd-web-diff-scope-btn-active' : '') + (r.files === 0 ? ' wd-diff-repo-empty' : '');
}

function PillText({ repo }: { repo: RepoSwitchItem }) {
  return (
    <>
      {repo.name}
      {repo.files !== null && <span className="wd-web-tab-count"> {repo.files}</span>}
    </>
  );
}

function repoTitle(r: RepoSwitchItem): string {
  if (r.files === null) return `${r.name}: not in this pick (a commit is one repo's) — shows its branch`;
  if (r.files === 0) return `${r.name}: no changes here`;
  return `${r.name}: ${r.files} file${r.files === 1 ? '' : 's'} +${r.added} −${r.deleted}`;
}

/** The list's button, as shown and as measured. */
function MoreButtonBody({
  button,
  open,
  onClick,
  title,
  buttonRef,
  ...rest
}: {
  button: RepoMoreButton;
  open?: boolean;
  onClick?: () => void;
  title?: string;
  buttonRef?: Ref<HTMLButtonElement>;
  'data-more'?: boolean;
}) {
  return (
    <button
      ref={buttonRef}
      type="button"
      className={'wd-diff-repo-more-btn' + (button.current ? ' wd-diff-repo-more-current' : '')}
      aria-haspopup="listbox"
      aria-expanded={open}
      onClick={onClick}
      title={title}
      tabIndex={onClick ? undefined : -1}
      {...rest}
    >
      <span className="wd-diff-repo-more-label">{button.label}</span>
      {button.hiddenChanged > 0 && <span className="wd-diff-repo-more-dot" aria-hidden="true" />}
      <span className="wd-checkpoint-caret" aria-hidden="true">
        ▾
      </span>
    </button>
  );
}

/** "+12 ▾": every repo of the group, the ones with changes first, found by typing part of a name. */
function RepoMenu({
  items,
  active,
  button,
  onPick,
}: {
  items: RepoSwitchItem[];
  active: string | null;
  button: RepoMoreButton;
  onPick: (name: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  // The row Enter picks (↑/↓, or the mouse).
  const [cursor, setCursor] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listId = useId();
  const sections = useMemo(() => repoMenuSections(items, query), [items, query]);
  const rows = sections.flatMap((s) => s.repos);

  const close = (refocus: boolean) => {
    setOpen(false);
    setQuery('');
    if (refocus) buttonRef.current?.focus();
  };
  const pick = (name: string) => {
    onPick(name);
    close(true);
  };
  const toggle = () => {
    if (open) return close(false);
    const all = repoMenuSections(items, '').flatMap((s) => s.repos);
    setCursor(
      Math.max(
        0,
        all.findIndex((r) => r.name === active),
      ),
    );
    setOpen(true);
  };

  // Close on a click elsewhere or Escape, like the Changes picker.
  useEffect(() => {
    if (!open) return;
    inputRef.current?.focus();
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) close(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault(); // used: closing this, not leaving full screen as well
      close(true);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);
  useEffect(() => {
    if (open) document.getElementById(`${listId}-${cursor}`)?.scrollIntoView?.({ block: 'nearest' });
  }, [open, cursor, listId]);

  const onScreen = items.find((r) => r.name === active);
  const title =
    button.current && onScreen
      ? `${repoTitle(onScreen)} — pick another of the ${items.length} repos`
      : `${button.hidden} more repo${button.hidden === 1 ? '' : 's'}${button.hiddenChanged ? `, ${button.hiddenChanged} with changes` : ''} — find one by name`;

  return (
    <div ref={rootRef} className="wd-diff-repo-more" data-popover>
      <MoreButtonBody button={button} open={open} onClick={toggle} title={title} buttonRef={buttonRef} />
      {open && (
        <div className="wd-checkpoint-pop wd-diff-repo-pop">
          <div className="wd-checkpoint-pop-header">
            <input
              ref={inputRef}
              type="text"
              className="wd-diff-repo-search"
              role="combobox"
              aria-expanded
              aria-controls={listId}
              aria-autocomplete="list"
              aria-activedescendant={rows[cursor] ? `${listId}-${cursor}` : undefined}
              aria-label="Find a repo"
              placeholder={`Find a repo (${items.length})…`}
              autoComplete="off"
              spellCheck={false}
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setCursor(0);
              }}
              onKeyDown={(e) => {
                if (e.key === 'ArrowDown') {
                  e.preventDefault();
                  setCursor((i) => Math.min(i + 1, rows.length - 1));
                } else if (e.key === 'ArrowUp') {
                  e.preventDefault();
                  setCursor((i) => Math.max(i - 1, 0));
                } else if (e.key === 'Enter') {
                  e.preventDefault();
                  if (rows[cursor]) pick(rows[cursor].name);
                }
              }}
            />
          </div>
          <div id={listId} role="listbox" aria-label="Repos">
            {sections.map((s) => (
              <div key={s.title || 'all'} role="group" aria-label={s.title || undefined}>
                {s.title && (
                  <div className="wd-history-section">
                    {s.title} · {s.repos.length}
                  </div>
                )}
                {s.repos.map((r) => {
                  const i = rows.indexOf(r);
                  return (
                    <button
                      key={r.name}
                      id={`${listId}-${i}`}
                      type="button"
                      role="option"
                      aria-selected={r.name === active}
                      tabIndex={-1}
                      className={
                        'wd-checkpoint-pop-row wd-diff-repo-row' +
                        (i === cursor ? ' wd-diff-repo-row-cursor' : '') +
                        (r.name === active ? ' wd-diff-repo-row-on' : '') +
                        ((r.files ?? 0) > 0 ? '' : ' wd-diff-repo-row-quiet')
                      }
                      title={repoTitle(r)}
                      // The search keeps the focus (and the keys); the click picks.
                      onMouseDown={(e) => e.preventDefault()}
                      onMouseMove={() => i !== cursor && setCursor(i)}
                      onClick={() => pick(r.name)}
                    >
                      <span className="wd-diff-repo-row-mark" aria-hidden="true">
                        {r.name === active ? '✓' : ''}
                      </span>
                      <span className="wd-checkpoint-pop-label">{r.name}</span>
                      {r.files !== null && r.files > 0 && (
                        <span className="wd-diff-repo-row-stats">
                          {r.files} file{r.files === 1 ? '' : 's'}{' '}
                          <span className="wd-tab-stats">
                            <span className="wd-add">+{r.added}</span> <span className="wd-del">−{r.deleted}</span>
                          </span>
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            ))}
            {rows.length === 0 && <p className="wd-history-empty">No repo matches “{query}”</p>}
          </div>
        </div>
      )}
    </div>
  );
}

const px = (v: string) => parseFloat(v) || 0;

/** The children that take room on a flex line (not an absolutely placed one: the loading bar, the measurer). */
function inFlow(parent: HTMLElement): HTMLElement[] {
  return [...parent.children].filter((c): c is HTMLElement => {
    if (!(c instanceof HTMLElement)) return false;
    const cs = getComputedStyle(c);
    return cs.display !== 'none' && cs.position !== 'absolute' && cs.position !== 'fixed';
  });
}

/** What a piece of the line needs: its width — or, for one that grows into the free space, what its own pieces hold. */
function needOf(el: HTMLElement): number {
  const cs = getComputedStyle(el);
  if (px(cs.flexGrow) === 0) return el.getBoundingClientRect().width;
  const kids = inFlow(el);
  // scrollWidth: an ellipsized piece ("vs origin/main") needs its whole text, however squeezed it is now.
  const held = kids.reduce((s, k) => s + Math.max(k.getBoundingClientRect().width, k.scrollWidth), 0);
  return (
    held +
    px(cs.columnGap) * Math.max(0, kids.length - 1) +
    px(cs.paddingLeft) +
    px(cs.paddingRight) +
    px(cs.borderLeftWidth) +
    px(cs.borderRightWidth)
  );
}

/**
 * How wide the switch may be: its toolbar's width less what everything else on the line needs, at every level up
 * to it — read from what the others hold, never from the switch's own width, so showing more or fewer pills can't
 * change the answer (no back and forth).
 */
function roomFor(el: HTMLElement, toolbar: HTMLElement): number {
  const tcs = getComputedStyle(toolbar);
  let room = toolbar.clientWidth - px(tcs.paddingLeft) - px(tcs.paddingRight);
  let node = el;
  while (node !== toolbar && node.parentElement) {
    const parent = node.parentElement;
    const cs = getComputedStyle(parent);
    const kids = inFlow(parent);
    room -= px(cs.columnGap) * Math.max(0, kids.length - 1);
    if (parent !== toolbar) room -= px(cs.paddingLeft) + px(cs.paddingRight) + px(cs.borderLeftWidth) + px(cs.borderRightWidth);
    for (const k of kids) if (k !== node) room -= needOf(k);
    node = parent;
  }
  return Math.floor(room);
}

function sameMeasure(a: Measure, b: Measure): boolean {
  const close = (x: number, y: number) => Math.abs(x - y) < 0.5;
  const keys = Object.keys(b.widths);
  return (
    close(a.room, b.room) &&
    close(a.more, b.more) &&
    keys.length === Object.keys(a.widths).length &&
    keys.every((k) => a.widths[k] !== undefined && close(a.widths[k], b.widths[k]))
  );
}
