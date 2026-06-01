import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import {
  deleteComment as apiDeleteComment,
  discardReview as apiDiscardReview,
  fetchComments,
  postComment as apiPostComment,
  postDone as apiPostDone,
  submitReview as apiSubmitReview,
  type Comment,
  type CommentInput,
} from '../api/client.js';
import { useSse } from '../api/events.js';

interface ComposerTarget {
  repo: string;
  file: string;
  line: number;
  side: 'left' | 'right';
  lineContent: string;
}

interface ReviewState {
  comments: Comment[];
  error: string | null;
  /** Identifies which row (if any) has its inline composer open. */
  openComposer: ComposerTarget | null;
  /** Comment id of the parent whose reply composer is open, if any. */
  openReplyTo: string | null;
}

interface ReviewActions {
  postComment: (input: CommentInput) => Promise<void>;
  deleteComment: (id: string) => Promise<void>;
  submitReview: (summary: string) => Promise<void>;
  discardReview: () => Promise<void>;
  done: () => Promise<void>;
  openComposerAt: (target: ComposerTarget) => void;
  closeComposer: () => void;
  openReplyAt: (parentId: string) => void;
  closeReply: () => void;
}

type ReviewContextValue = ReviewState & ReviewActions;

const ReviewCtx = createContext<ReviewContextValue | null>(null);

export function ReviewProvider({ children }: { children: ReactNode }) {
  const [comments, setComments] = useState<Comment[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [openComposer, setOpenComposer] = useState<ComposerTarget | null>(null);
  const [openReplyTo, setOpenReplyTo] = useState<string | null>(null);
  const reqIdRef = useRef(0);

  const refetch = useCallback(() => {
    const myReq = ++reqIdRef.current;
    fetchComments().then(
      (data) => {
        if (myReq !== reqIdRef.current) return;
        setComments(data);
        setError(null);
      },
      (err: Error) => {
        if (myReq !== reqIdRef.current) return;
        setError(err.message);
      },
    );
  }, []);

  useEffect(() => refetch(), [refetch]);

  // Fire on Claude replies. User-initiated changes update state directly
  // from the POST response (server doesn't broadcast for those).
  useSse('/events', {
    events: {
      'comments-changed': () => refetch(),
    },
  });

  const postComment = useCallback(async (input: CommentInput) => {
    const res = await apiPostComment(input);
    // Invalidate any in-flight refetch so it can't clobber this fresher result.
    ++reqIdRef.current;
    setComments(res.comments);
  }, []);
  const deleteComment = useCallback(async (id: string) => {
    const res = await apiDeleteComment(id);
    ++reqIdRef.current;
    setComments(res.comments);
  }, []);
  const submitReview = useCallback(async (summary: string) => {
    const res = await apiSubmitReview(summary);
    ++reqIdRef.current;
    setComments(res.comments);
  }, []);
  const discardReview = useCallback(async () => {
    const res = await apiDiscardReview();
    ++reqIdRef.current;
    setComments(res.comments);
  }, []);
  const done = useCallback(async () => {
    await apiPostDone();
  }, []);

  const value = useMemo<ReviewContextValue>(
    () => ({
      comments,
      error,
      openComposer,
      openReplyTo,
      postComment,
      deleteComment,
      submitReview,
      discardReview,
      done,
      openComposerAt: (t) => {
        setOpenComposer(t);
        setOpenReplyTo(null);
      },
      closeComposer: () => setOpenComposer(null),
      openReplyAt: (parentId) => {
        setOpenReplyTo(parentId);
        setOpenComposer(null);
      },
      closeReply: () => setOpenReplyTo(null),
    }),
    [
      comments,
      error,
      openComposer,
      openReplyTo,
      postComment,
      deleteComment,
      submitReview,
      discardReview,
      done,
    ],
  );

  return <ReviewCtx.Provider value={value}>{children}</ReviewCtx.Provider>;
}

export function useReview(): ReviewContextValue {
  const ctx = useContext(ReviewCtx);
  if (!ctx) throw new Error('useReview must be used inside ReviewProvider');
  return ctx;
}

/** Same as useReview but returns null if no provider is mounted. Used by
 *  diff components that render in both review mode and dashboard mode. */
export function useReviewOptional(): ReviewContextValue | null {
  return useContext(ReviewCtx);
}

/** Convenience selectors. */
export function selectDrafts(comments: Comment[]): Comment[] {
  return comments.filter((c) => c.status === 'draft');
}
export function selectPublishedCount(comments: Comment[]): number {
  return comments.reduce((n, c) => (c.status === 'published' ? n + 1 : n), 0);
}
export function selectHasDrafts(comments: Comment[]): boolean {
  return comments.some((c) => c.status === 'draft');
}
export function selectCommentsForLine(
  comments: Comment[],
  repo: string,
  file: string,
  line: number,
  side: 'left' | 'right',
): Comment[] {
  return comments.filter(
    (c) =>
      !c.parentId &&
      c.side === side &&
      c.repo === repo &&
      c.file === file &&
      c.line === line,
  );
}
export function selectReplies(comments: Comment[], parentId: string): Comment[] {
  return comments
    .filter((c) => c.parentId === parentId)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}
