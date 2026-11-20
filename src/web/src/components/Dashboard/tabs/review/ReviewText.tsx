import { Fragment, type ReactNode } from 'react';
import { changeType, diffstatBlocks, folderParts, nameParts, proseParts, splitPath } from '../../../../state/review-view.js';

/** The AI step's prose: plain text, what it put between backticks drawn as code. */
export function Prose({ text }: { text: string }) {
  return (
    <>
      {proseParts(text).map((p, k) =>
        p.code ? (
          <code key={k} className="wd-review-code">
            {p.text}
          </code>
        ) : (
          <Fragment key={k}>{p.text}</Fragment>
        ),
      )}
    </>
  );
}

/** A folder, dimmed, wrapping only after a `/` (never inside a folder's name). */
export function FolderPath({ folder, prefix }: { folder: string; prefix?: ReactNode }) {
  return (
    <span className="wd-review-folder">
      {prefix}
      {folderParts(folder).map((part, k) => (
        <Fragment key={k}>
          {k > 0 && <wbr />}
          {part}
        </Fragment>
      ))}
    </span>
  );
}

/** The change as a coloured letter (A added, M modified, D deleted, R renamed), GitHub's colours. */
export function ChangeBadge({ status, oldPath }: { status: string; oldPath?: string }) {
  const c = changeType({ status, ...(oldPath ? { oldPath } : {}) });
  return (
    <span className={`wd-review-badge wd-review-badge-${c.type}`} title={c.label} aria-label={c.label}>
      {c.letter}
    </span>
  );
}

/** "+222 −78" in green and red, monospace; with `bar`, GitHub's five-block diffstat after them. */
export function LineCounts({ added, deleted, bar }: { added: number; deleted: number; bar?: boolean }) {
  return (
    <span className="wd-review-counts" title={`${added} line${added === 1 ? '' : 's'} added, ${deleted} deleted`}>
      <span className="wd-review-plus">+{added}</span> <span className="wd-review-minus">−{deleted}</span>
      {bar && (
        <span className="wd-review-diffstat" aria-hidden>
          {diffstatBlocks(added, deleted).map((b, k) => (
            <span key={k} className={`wd-review-block wd-review-block-${b}`} />
          ))}
        </span>
      )}
    </span>
  );
}

/** A file name, bold, breaking only between its words (`nameParts`). */
export function FileName({ name, className }: { name: string; className?: string }) {
  return (
    <span className={`wd-review-filename${className ? ` ${className}` : ''}`}>
      {nameParts(name).map((part, k) => (
        <Fragment key={k}>
          {k > 0 && <wbr />}
          {part}
        </Fragment>
      ))}
    </span>
  );
}

/** How many draft comments a file has: a small pill with a speech bubble. */
export function CommentCount({ n }: { n: number }) {
  if (!n) return null;
  const words = `${n} draft comment${n === 1 ? '' : 's'}`;
  return (
    <span className="wd-review-filecomments" title={words} aria-label={words}>
      <svg viewBox="0 0 16 16" width="10" height="10" aria-hidden>
        <path
          fill="currentColor"
          d="M1 2.75C1 1.78 1.78 1 2.75 1h10.5c.97 0 1.75.78 1.75 1.75v7.5A1.75 1.75 0 0 1 13.25 12H8.06l-2.57 2.57A.75.75 0 0 1 4.25 14v-2h-1.5A1.75 1.75 0 0 1 1 10.25Z"
        />
      </svg>
      {n}
    </span>
  );
}

/** How many open threads a file already has on the PR's host: a pill apart from the drafts' (an outline, no fill). */
export function ThreadCount({ n }: { n: number }) {
  if (!n) return null;
  const words = `${n} open thread${n === 1 ? '' : 's'} already on the PR`;
  return (
    <span className="wd-review-filethreads" title={words} aria-label={words}>
      <svg viewBox="0 0 16 16" width="10" height="10" aria-hidden>
        <path
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          d="M1.75 2.75c0-.55.45-1 1-1h10.5c.55 0 1 .45 1 1v7.5c0 .55-.45 1-1 1H7.8l-2.8 2.5v-2.5H2.75c-.55 0-1-.45-1-1Z"
        />
      </svg>
      {n}
    </span>
  );
}

/** "[M] RefundHandler.cs:6" — where a comment is: the change badge, the name bold, the line in monospace. */
export function FileWhere({ path, line, status }: { path: string; line: number; status?: string }) {
  return (
    <span className="wd-review-where">
      {status && <ChangeBadge status={status} />}
      <FileName name={splitPath(path).name} />
      <span className="wd-review-fileline">:{line}</span>
    </span>
  );
}

/**
 * A file wherever a review lists one: the change badge, its name bold, its comments and a ✓ once viewed; under it its
 * folder (monospace, dimmed) with its line counts at the right, then any detail. With `folder={false}` (the story
 * tree: the diff's own header has the path) there is no folder line — the counts go on the name's line, beside the
 * name when they fit, else under it at the right. A button when it leads somewhere; dimmed once viewed; marked when
 * its diff is the one on screen.
 */
export function FileRow({
  path,
  file,
  comments = 0,
  threads = 0,
  viewed = false,
  current = false,
  folder: withFolder = true,
  bar = false,
  className,
  nameClass,
  title,
  detail,
  onClick,
  disabled,
}: {
  path: string;
  file?: { status: string; added: number; deleted: number; oldPath?: string };
  comments?: number;
  /** Open threads already on the PR's host for it. */
  threads?: number;
  viewed?: boolean;
  current?: boolean;
  /** Its folder on a line under the name (default); false: none (the path is in the tooltip). */
  folder?: boolean;
  bar?: boolean;
  className?: string;
  nameClass?: string;
  title?: string;
  detail?: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
}) {
  const { name, folder } = splitPath(path);
  const cls = ['wd-review-filerow', viewed ? 'wd-review-filerow-viewed' : '', current ? 'wd-review-filerow-current' : '', className ?? '']
    .filter(Boolean)
    .join(' ');
  const counts = file && <LineCounts added={file.added} deleted={file.deleted} bar={bar} />;
  const facts = (comments > 0 || threads > 0 || viewed || (!withFolder && file)) && (
    <span className="wd-review-filerow-facts">
      <ThreadCount n={threads} />
      <CommentCount n={comments} />
      {viewed && (
        <span className="wd-review-fileviewed" title="Viewed" aria-label="Viewed">
          ✓
        </span>
      )}
      {!withFolder && counts}
    </span>
  );
  const body = (
    <>
      <span className={`wd-review-filerow-top${withFolder ? '' : ' wd-review-filerow-oneline'}`}>
        {file && <ChangeBadge status={file.status} {...(file.oldPath ? { oldPath: file.oldPath } : {})} />}
        <FileName name={name} {...(nameClass ? { className: nameClass } : {})} />
        {facts}
      </span>
      {withFolder && (folder || file) && (
        <span className="wd-review-filerow-sub">
          {folder ? <FolderPath folder={folder} /> : <span />}
          {counts}
        </span>
      )}
      {detail && <span className="wd-review-filerow-detail">{detail}</span>}
    </>
  );
  return onClick ? (
    <button
      type="button"
      className={cls}
      onClick={onClick}
      disabled={disabled}
      title={title ?? path}
      aria-current={current ? 'true' : undefined}
    >
      {body}
    </button>
  ) : (
    <div className={cls} title={title ?? path}>
      {body}
    </div>
  );
}

/** "What changed here": the AI step's few sentences on a file, above its code; folds to its heading. */
export function FileSummary({ summary }: { summary: string }) {
  return (
    <details className="wd-review-file-summary" open>
      <summary>What changed here</summary>
      <p>
        <Prose text={summary} />
      </p>
    </details>
  );
}
