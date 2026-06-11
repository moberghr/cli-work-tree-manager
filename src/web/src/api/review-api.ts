import type { Comment, CommentInput } from './client.js';

/**
 * Injectable surface used by ReviewProvider. Two implementations exist:
 *
 * - `scopeReviewApi()` — talks to /api/* (the wd -c server's per-scope endpoints).
 * - `sessionReviewApi(sessionId)` — talks to /api/sessions/:id/* (the dashboard's
 *   per-session endpoints, backed by ~/.work/comments/<sessionId>.json).
 *
 * Both share the same shape so ReviewProvider doesn't know which one it has.
 */
export interface ReviewApi {
  fetch(): Promise<Comment[]>;
  post(input: CommentInput): Promise<{ comments: Comment[] }>;
  delete(id: string): Promise<{ comments: Comment[] }>;
  resolve(id: string, resolved: boolean): Promise<{ comments: Comment[] }>;
  submit(summary: string): Promise<{ comments: Comment[]; count: number }>;
  discard(): Promise<{ comments: Comment[]; discarded: number }>;
  done(): Promise<void>;
  /** Path the provider should subscribe to for `comments-changed` events.
   *  Lets callers scope SSE to one session (`/events?session=<id>`). */
  ssePath: string;
  /** Optional predicate — return true if a comments-changed event applies
   *  to this api. Dashboard mode filters by sessionId so other sessions'
   *  changes don't trigger a refetch. */
  matchesEvent?: (payload: unknown) => boolean;
}

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(path, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${path}`);
  return res.json() as Promise<T>;
}

async function postJson<T>(path: string, body: unknown, method = 'POST'): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${path}`);
  return res.json() as Promise<T>;
}

/** Per-scope api (the wd -c server). */
export function scopeReviewApi(): ReviewApi {
  return {
    fetch: () =>
      getJson<{ comments: Comment[] }>('/api/comments').then((r) => r.comments),
    post: (input) => postJson('/api/comments', input),
    delete: async (id) => {
      const res = await fetch(`/api/comments/${encodeURIComponent(id)}`, {
        method: 'DELETE',
      });
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      return res.json() as Promise<{ comments: Comment[] }>;
    },
    resolve: (id, resolved) =>
      postJson(`/api/comments/${encodeURIComponent(id)}/resolve`, { resolved }),
    submit: (summary) => postJson('/api/submit-review', { summary }),
    discard: () => postJson('/api/discard-review', {}),
    done: async () => {
      await postJson('/api/done', {});
    },
    ssePath: '/events',
  };
}

/** Per-scope api (the work web `/review/<hash>` URL — ad-hoc `wd` scope). */
export function scopeHashReviewApi(hash: string): ReviewApi {
  const base = `/api/scopes/${encodeURIComponent(hash)}`;
  return {
    fetch: () =>
      getJson<{ comments: Comment[] }>(`${base}/comments`).then(
        (r) => r.comments,
      ),
    post: (input) => postJson(`${base}/comments`, input),
    delete: async (id) => {
      const res = await fetch(
        `${base}/comments/${encodeURIComponent(id)}`,
        { method: 'DELETE' },
      );
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      return res.json() as Promise<{ comments: Comment[] }>;
    },
    resolve: (id, resolved) =>
      postJson(`${base}/comments/${encodeURIComponent(id)}/resolve`, {
        resolved,
      }),
    submit: (summary) => postJson(`${base}/submit-review`, { summary }),
    discard: () => postJson(`${base}/discard-review`, {}),
    done: async () => {
      await postJson(`${base}/done`, {});
    },
    // Listen on the scope-narrowed stream — scope-routes relays
    // `comments-changed` there (alongside diff/checkpoint events), so a
    // review tab shares ONE pooled SSE connection with ReviewApp's own
    // useSse instead of also pinning the global /events stream. Browsers
    // cap connections per host; the second stream per tab was starving
    // the pool once a few review tabs accumulated.
    ssePath: `${base}/events`,
    matchesEvent: (payload) => {
      if (!payload || typeof payload !== 'object') return false;
      const p = payload as { scopeHash?: string };
      return p.scopeHash === hash;
    },
  };
}

/** Per-session api (the work web dashboard). */
export function sessionReviewApi(sessionId: string): ReviewApi {
  const base = `/api/sessions/${encodeURIComponent(sessionId)}`;
  return {
    fetch: () =>
      getJson<{ comments: Comment[] }>(`${base}/comments`).then((r) => r.comments),
    post: (input) => postJson(`${base}/comments`, input),
    delete: async (id) => {
      const res = await fetch(
        `${base}/comments/${encodeURIComponent(id)}`,
        { method: 'DELETE' },
      );
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      return res.json() as Promise<{ comments: Comment[] }>;
    },
    resolve: (id, resolved) =>
      postJson(`${base}/comments/${encodeURIComponent(id)}/resolve`, {
        resolved,
      }),
    submit: (summary) => postJson(`${base}/submit-review`, { summary }),
    discard: () => postJson(`${base}/discard-review`, {}),
    // Dashboard sessions don't expose /done — they live for the whole
    // server's lifetime. Resolve immediately for compat.
    done: async () => { /* noop */ },
    ssePath: `/events?session=${encodeURIComponent(sessionId)}`,
    matchesEvent: (payload) => {
      if (!payload || typeof payload !== 'object') return true;
      const p = payload as { sessionId?: string };
      return !p.sessionId || p.sessionId === sessionId;
    },
  };
}
