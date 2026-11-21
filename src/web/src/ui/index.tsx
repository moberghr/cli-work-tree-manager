export { Menu, type MenuEntry, type MenuItem, type MenuProps, type MenuSwatch, type MenuSwatches } from './Menu.js';
import type {
  ButtonHTMLAttributes,
  HTMLAttributes,
  InputHTMLAttributes,
  ReactNode,
  Ref,
  SelectHTMLAttributes,
  TextareaHTMLAttributes,
} from 'react';

/**
 * The shared pieces of the web UI: one implementation of each control (styles: ui.css, on the scale in
 * tokens.css). A page composes these and places them; it never restyles one. Each renders the class the
 * pages already used, so markup not yet moved here looks the same and tests that find a control by its
 * class keep working. See .claude/references/work/web-ui.md.
 */

/** What a button is for: the view's one main action, any other, one on a row, one with no frame, or a link. */
export type ButtonVariant = 'primary' | 'danger' | 'secondary' | 'row' | 'quiet' | 'link';

const BUTTON_CLASS: Record<ButtonVariant, string> = {
  primary: 'wd-btn-primary',
  // The one main action when it destroys something (Delete, Merge, Remove): filled red.
  danger: 'wd-btn-danger',
  secondary: 'wd-btn-secondary',
  row: 'wd-row-action',
  quiet: 'wd-topnav-btn',
  link: 'wd-link-button',
};

/** A link button's colour where the app's blue would shout: the panel's quiet grey, or the text around it. */
export type LinkTone = 'muted' | 'inherit';

/** A button's height: the usual one, or the small one of a toolbar (beside a Segmented, the same height). */
export type ButtonSize = 'md' | 'sm';

/** The classes of a button of this kind (for an `<a>` that must look like one). Pure. */
export function buttonClass(
  variant: ButtonVariant = 'secondary',
  opts: { danger?: boolean; size?: ButtonSize; icon?: boolean; tone?: LinkTone; className?: string } = {},
): string {
  const framed = variant === 'primary' || variant === 'danger' || variant === 'secondary';
  return [
    BUTTON_CLASS[variant],
    opts.danger && variant === 'row' ? 'wd-row-action-danger' : '',
    opts.size === 'sm' && framed ? 'wd-btn-sm' : '',
    opts.icon ? 'wd-btn-icon' : '',
    opts.tone && variant === 'link' ? `wd-link-button-${opts.tone}` : '',
    opts.className ?? '',
  ]
    .filter(Boolean)
    .join(' ');
}

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  /** A row action that destroys something: red when pointed at. */
  danger?: boolean;
  /** `sm` in a toolbar, for a main or secondary button (a row's is small already). */
  size?: ButtonSize;
  /** One glyph and no words (a dialog's ×): square, the glyph larger. Give it an aria-label. */
  icon?: boolean;
  /** A link button's colour: quiet grey (reply drafts' actions, an outline) or the text around it (a panel's list). */
  tone?: LinkTone;
  /** For a dialog that puts focus on it. */
  ref?: Ref<HTMLButtonElement>;
}

/** A button. `type` is "button" unless said: none of ours submits a form by accident. */
export function Button({ variant = 'secondary', danger, size, icon, tone, className, type = 'button', ...rest }: ButtonProps) {
  return <button type={type} className={buttonClass(variant, { danger, size, icon, tone, className })} {...rest} />;
}

export interface SegmentedOption<T extends string> {
  value: T;
  label: ReactNode;
  /** What it does, for its tooltip. */
  title?: string;
  /** Dimmed while not on: there is nothing behind it (a repo with no changes in this pick). */
  muted?: boolean;
  disabled?: boolean;
  /** The page's own class on this one's button (what a test finds it by). */
  className?: string;
}

/**
 * A few choices of which at most one is on (Now / Today, Group: Repo / None, Uncommitted / Since branch).
 * `value` null: none is (the view shows something none of them names, a commit picked elsewhere). As
 * `tabs` it switches what the view shows below it — a tablist of tabs, `aria-selected` — rather than a
 * setting (`aria-pressed`); it looks the same.
 */
export function Segmented<T extends string>({
  options,
  value,
  onChange,
  label,
  kind = 'toggle',
  className,
}: {
  options: ReadonlyArray<SegmentedOption<T>>;
  value: T | null;
  onChange: (value: T) => void;
  /** What is being chosen, for a screen reader. */
  label: string;
  kind?: 'toggle' | 'tabs';
  className?: string;
}) {
  const tabs = kind === 'tabs';
  return (
    <span className={['wd-segmented', className ?? ''].filter(Boolean).join(' ')} role={tabs ? 'tablist' : 'group'} aria-label={label}>
      {options.map((o) => {
        const on = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            role={tabs ? 'tab' : undefined}
            aria-selected={tabs ? on : undefined}
            aria-pressed={tabs ? undefined : on}
            className={['wd-segmented-btn', on ? 'wd-segmented-btn-on' : '', o.muted ? 'wd-segmented-btn-muted' : '', o.className ?? '']
              .filter(Boolean)
              .join(' ')}
            title={o.title}
            disabled={o.disabled}
            onClick={() => onChange(o.value)}
          >
            {o.label}
          </button>
        );
      })}
    </span>
  );
}

/** A text box's or a select's classes: `compact` in a tight row (a chip row, beside row buttons), 24 px. Pure. */
export function fieldClass(base: string, compact: boolean | undefined, className: string | undefined): string {
  return ['wd-input', base, compact ? 'wd-input-sm' : '', className ?? ''].filter(Boolean).join(' ');
}

/**
 * A one-line text box. Every attribute an input takes passes on (a ref included). `bare`: the search field
 * across the top of a palette (Ctrl+P, code search) — no frame, a line under it, a little larger.
 */
export function Input({
  className,
  compact,
  bare,
  type = 'text',
  ...rest
}: InputHTMLAttributes<HTMLInputElement> & { compact?: boolean; bare?: boolean; ref?: Ref<HTMLInputElement> }) {
  return <input type={type} className={fieldClass(bare ? 'wd-input-bare' : '', compact, className)} {...rest} />;
}

/** A pick from a list (`<option>`s as children): the same box as an Input, with the browser's own arrow. */
export function Select({
  className,
  compact,
  ...rest
}: SelectHTMLAttributes<HTMLSelectElement> & { compact?: boolean; ref?: Ref<HTMLSelectElement> }) {
  return <select className={fieldClass('wd-select', compact, className)} {...rest} />;
}

/** A text box of several lines; grows by hand (vertical resize). `rows={1}`: one line, a button's height. */
export function TextArea({ className, ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement> & { ref?: Ref<HTMLTextAreaElement> }) {
  return <textarea className={['wd-input', 'wd-textarea', className ?? ''].filter(Boolean).join(' ')} {...rest} />;
}

/**
 * One tab of a strip that switches what is shown below it (the top bar's pages, a session's Terminal / Diff /
 * Code): its label, underlined when it is the one on. A strip of a few short choices inside a view is a
 * Segmented (`kind="tabs"`) instead. The strip itself (a `role="tablist"`) is the page's.
 */
export function Tab({ active, className, children, ...rest }: { active: boolean } & ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      className={['wd-tab', active ? 'wd-tab-on' : '', className ?? ''].filter(Boolean).join(' ')}
      {...rest}
    >
      {children}
    </button>
  );
}

/**
 * What a badge is: a number (a tab's count: filled), a label (a PR's number, "on GitHub", "member": outlined),
 * a state (a rail row's "review", a flag, a verdict: tinted) or a file's letter (A, M, D: tinted, square).
 */
export type BadgeKind = 'count' | 'tag' | 'status' | 'letter';
/** Its colour, by what it means: none in particular, the app's blue, good, careful, bad, a review owed, merged. */
export type BadgeTone = 'neutral' | 'accent' | 'ok' | 'warn' | 'danger' | 'review' | 'merged';

/**
 * A badge's classes (for an `<a>` or a `<button>` that must look like one). `dashed`: not the real thing yet,
 * or no longer (a draft PR, a row kept past its PR, an archived session). Pure.
 */
export function badgeClass(
  kind: BadgeKind = 'tag',
  tone: BadgeTone = kind === 'count' ? 'accent' : 'neutral',
  className?: string,
  dashed = false,
): string {
  return ['wd-badge', `wd-badge-${kind}`, tone === 'neutral' ? '' : `wd-badge-${tone}`, dashed ? 'wd-badge-dashed' : '', className ?? '']
    .filter(Boolean)
    .join(' ');
}

/** A small label in a row: a count, a tag, a state, a file's letter. */
export function Badge({
  kind = 'tag',
  tone,
  dashed,
  className,
  ...rest
}: { kind?: BadgeKind; tone?: BadgeTone; dashed?: boolean } & HTMLAttributes<HTMLSpanElement>) {
  return <span className={badgeClass(kind, tone, className, dashed)} {...rest} />;
}

/**
 * A short value you can take out (a scanned folder, a group's repo: `remove` gives it its ×), or a choice to
 * pick (`as="label"` round a checkbox: the new group's repos). `on`: picked; `bad`: something is wrong with
 * it (a group's repo that is gone).
 */
export function Chip({
  children,
  remove,
  on,
  bad,
  as: Tag = 'span',
  className,
  title,
}: {
  children?: ReactNode;
  remove?: { label: string; title?: string; disabled?: boolean; onClick: () => void };
  on?: boolean;
  bad?: boolean;
  as?: 'span' | 'label';
  className?: string;
  title?: string;
}) {
  return (
    <Tag className={['wd-chip', on ? 'wd-chip-on' : '', bad ? 'wd-chip-bad' : '', className ?? ''].filter(Boolean).join(' ')} title={title}>
      {children}
      {remove && (
        <button
          type="button"
          className="wd-chip-remove"
          aria-label={remove.label}
          title={remove.title}
          disabled={remove.disabled}
          onClick={remove.onClick}
        >
          ×
        </button>
      )}
    </Tag>
  );
}

/**
 * A chip you switch on and off, of which several can be on (Start's repos to show). For exactly one of a few, a
 * Segmented.
 */
export function ToggleChip({
  on,
  className,
  children,
  ...rest
}: { on: boolean } & Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'aria-pressed'>) {
  return (
    <button
      type="button"
      aria-pressed={on}
      className={['wd-chip', 'wd-chip-toggle', on ? 'wd-chip-on' : '', className ?? ''].filter(Boolean).join(' ')}
      {...rest}
    >
      {children}
    </button>
  );
}

/** A page's title, what it counts beside it, and its controls on the right. */
export function PageHeader({
  title,
  meta,
  compact,
  children,
}: {
  title: ReactNode;
  meta?: ReactNode;
  /** In a panel or a narrow column (Tasks, a step of the first run, the Reviews list beside a review): less room, a smaller title. */
  compact?: boolean;
  children?: ReactNode;
}) {
  return (
    <header className={compact ? 'wd-tab-header wd-tab-header-compact' : 'wd-tab-header'}>
      <h1>
        {title}
        {meta !== undefined && meta !== null && meta !== '' && <span className="wd-tab-header-muted"> {meta}</span>}
      </h1>
      {children && <div className="wd-tab-controls">{children}</div>}
    </header>
  );
}

/** The small capitals over a group of rows, with what the group counts. */
export function SectionTitle({
  children,
  meta,
  as: Tag = 'h2',
  className,
}: {
  children: ReactNode;
  meta?: ReactNode;
  as?: 'h2' | 'h3';
  /** The page's own class beside the shared one (where it sits; what a test finds it by). */
  className?: string;
}) {
  return (
    <Tag className={['wd-section-title', className ?? ''].filter(Boolean).join(' ')}>
      {children}
      {meta !== undefined && meta !== null && meta !== '' && <span className="wd-section-title-meta"> {meta}</span>}
    </Tag>
  );
}

/** A row you click, in a list: a title line and a quieter line under it. */
export function ListRow({
  title,
  meta,
  active,
  className,
  ...rest
}: { title: ReactNode; meta?: ReactNode; active?: boolean } & Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'title'>) {
  return (
    <button
      type="button"
      className={['wd-list-row', active ? 'wd-list-row-active' : '', className ?? ''].filter(Boolean).join(' ')}
      aria-current={active ? 'true' : undefined}
      {...rest}
    >
      <span className="wd-list-row-title">{title}</span>
      {meta !== undefined && meta !== null && <span className="wd-list-row-meta">{meta}</span>}
    </button>
  );
}
