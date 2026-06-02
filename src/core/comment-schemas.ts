/**
 * Shared zod schemas for the comment HTTP surface. Kept separate from
 * `comment-types.ts` because the SPA imports `comment-types.ts` for the
 * type-only exports and pulling zod into the SPA bundle is wasteful —
 * the schemas are server-side validation only.
 */

import { z } from 'zod';

export const commentInputSchema = z.object({
  repo: z.string().optional(),
  file: z.string().optional(),
  line: z.number().int().optional(),
  side: z.enum(['left', 'right', 'general']).optional(),
  body: z.string().min(1),
  status: z.enum(['published', 'draft']).optional(),
  lineContent: z.string().optional(),
  parentId: z.string().optional(),
  author: z.enum(['user', 'claude']).optional(),
});

export const submitReviewSchema = z.object({
  summary: z.string().optional(),
});
