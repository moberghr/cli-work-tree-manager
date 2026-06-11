/**
 * Canonical Comment types shared between the server (comment-server.ts) and
 * the SPA (src/web/src/api/client.ts).
 *
 * The Vite SPA build cannot directly import this module — Vite's `root` is
 * src/web/ — so the SPA re-exports a copy. The duplicate carries a
 * "keep in sync with" pragma. Don't edit either copy in isolation.
 */

export type CommentAuthor = 'user' | 'claude';
export type CommentStatus = 'published' | 'draft';
/** 'file' is a whole-file comment (GitHub-style): `file` set, `line` 0, no
 *  specific side. 'general' is not tied to any file. */
export type CommentSide = 'left' | 'right' | 'general' | 'file';

export interface Comment {
  id: string;
  /** Empty for general comments not tied to a specific repo. */
  repo: string;
  /** Empty for general comments. */
  file: string;
  /** 0 for general comments. */
  line: number;
  /** 'general' for non-line-specific comments. */
  side: CommentSide;
  body: string;
  createdAt: string;
  /** Raw content of the diff line at the time the comment was made. Used to
   *  detect "outdated" comments after the underlying file changes. */
  lineContent?: string;
  /** 'user' for comments authored in the browser, 'claude' for replies
   *  posted by the assistant via the same /api/comments endpoint. */
  author: CommentAuthor;
  /** If set, this comment is a reply to the comment with this id. */
  parentId?: string;
  /** 'published' streams to stdout immediately; 'draft' is held until the
   *  user submits the review batch via POST /api/submit-review. */
  status: CommentStatus;
  /** True when the user has marked this thread done. Set on the top-level
   *  comment; the UI collapses the thread in the diff and dims it (but keeps
   *  it listed) in the comments panel. */
  resolved?: boolean;
}
