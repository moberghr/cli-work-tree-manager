import { createContext, useContext, type ReactNode } from 'react';
import type { PrDiscussionThreadWire } from '../../../core/api-types.js';
import { lineKey } from '../../../core/review/review-discussion.js';

/**
 * The PR's existing review threads on its host (#64), for the diff rows of the Reviews tab: each line asks which
 * threads are on it (`placeThreads`' inline map, by path, side and line). Read only: nothing here answers or resolves
 * one. Absent (every other diff view): no row shows any.
 */
export interface HostThreadsValue {
  inline: ReadonlyMap<string, PrDiscussionThreadWire[]>;
  /** The host's id (absent: GitHub), for "Open on …". */
  host?: string;
}

const Ctx = createContext<HostThreadsValue | null>(null);

export function HostThreadsProvider({ value, children }: { value: HostThreadsValue; children: ReactNode }) {
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useHostThreads(): HostThreadsValue | null {
  return useContext(Ctx);
}

/** The host's threads on one line of a file (none without a provider). */
export function hostThreadsAt(ctx: HostThreadsValue | null, file: string, side: 'left' | 'right', line: number): PrDiscussionThreadWire[] {
  return ctx?.inline.get(lineKey(file, side, line)) ?? [];
}
