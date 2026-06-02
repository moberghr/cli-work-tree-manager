import crypto from 'node:crypto';
import type {
  Comment,
  CommentAuthor,
  CommentSide,
  CommentStatus,
} from './comment-types.js';

export interface CommentInput {
  repo?: string;
  file?: string;
  line?: number;
  side?: CommentSide;
  body: string;
  status?: CommentStatus;
  lineContent?: string;
  parentId?: string;
  author?: CommentAuthor;
}

export interface SubmitInfo {
  /** Number of drafts promoted to published, in chronological order. */
  drafts: Comment[];
  /** Optional summary comment created from `summary` text. */
  summary: Comment | null;
}

/**
 * In-memory comment store. Pure model — no I/O, no HTTP, no SSE. The server
 * wires hooks (`onPost`, `onSubmit`, etc.) so its routes can stream events
 * to clients and stdout without the store knowing how delivery happens.
 */
export interface CommentStore {
  list(): Comment[];
  /** Add a comment. Throws if parentId is given but not found. Returns the
   *  newly-created comment. Does NOT fire onPost — the caller decides
   *  whether to stream this immediately (published+user) or hold it
   *  (drafts, claude echoes). */
  post(input: CommentInput): Comment;
  /** Remove a comment by id. Returns true if anything was removed. */
  remove(id: string): boolean;
  /** Promote all drafts to published, optionally creating a summary comment
   *  from `summary` text. Returns the batch info. */
  submit(summary: string | undefined): SubmitInfo;
  /** Drop every draft comment. Returns the number removed. */
  discardDrafts(): number;
  /** Snapshot — a defensive copy. */
  snapshot(): Comment[];
}

export function createCommentStore(): CommentStore {
  const comments: Comment[] = [];

  function findParent(parentId: string | undefined): Comment | undefined {
    if (typeof parentId !== 'string') return undefined;
    const parent = comments.find((c) => c.id === parentId);
    if (!parent) throw new Error('parent comment not found');
    return parent;
  }

  return {
    list: () => comments,
    snapshot: () => [...comments],

    post(input) {
      if (typeof input.body !== 'string' || !input.body.trim()) {
        throw new Error('comment body is required');
      }
      const parent = findParent(input.parentId);
      const side = input.side ?? parent?.side ?? 'general';
      if (side !== 'left' && side !== 'right' && side !== 'general') {
        throw new Error('invalid side');
      }
      const c: Comment = {
        id: crypto.randomBytes(8).toString('hex'),
        repo:
          (typeof input.repo === 'string' ? input.repo : parent?.repo) ?? '',
        file:
          (typeof input.file === 'string' ? input.file : parent?.file) ?? '',
        line: typeof input.line === 'number' ? input.line : (parent?.line ?? 0),
        side,
        body: input.body.trim(),
        createdAt: new Date().toISOString(),
        lineContent:
          typeof input.lineContent === 'string'
            ? input.lineContent
            : parent?.lineContent,
        author: input.author === 'claude' ? 'claude' : 'user',
        parentId: parent?.id,
        status: input.status === 'draft' ? 'draft' : 'published',
      };
      comments.push(c);
      return c;
    },

    remove(id) {
      const idx = comments.findIndex((c) => c.id === id);
      if (idx < 0) return false;
      comments.splice(idx, 1);
      return true;
    },

    submit(summary) {
      const drafts = comments
        .filter((c) => c.status === 'draft')
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      let summaryComment: Comment | null = null;
      if (typeof summary === 'string' && summary.trim()) {
        summaryComment = {
          id: crypto.randomBytes(8).toString('hex'),
          repo: '',
          file: '',
          line: 0,
          side: 'general',
          body: summary.trim(),
          createdAt: new Date().toISOString(),
          author: 'user',
          status: 'published',
        };
        comments.push(summaryComment);
      }
      for (const d of drafts) {
        d.status = 'published';
      }
      return { drafts, summary: summaryComment };
    },

    discardDrafts() {
      const before = comments.length;
      for (let i = comments.length - 1; i >= 0; i--) {
        if (comments[i].status === 'draft') comments.splice(i, 1);
      }
      return before - comments.length;
    },
  };
}
