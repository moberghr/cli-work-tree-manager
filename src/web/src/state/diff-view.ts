import type { DiffSelection } from './diff-history.js';

/**
 * The Diff tab's small decisions, apart so they're tested: which repo tab is
 * shown, in what order, and what an empty diff says. Pure.
 */

interface RepoLike {
  name: string;
  files: readonly unknown[];
}

/**
 * The repo tab to show: the one you clicked while it's there; else the one on
 * screen while it has changes; else the first with changes (a group once
 * opened on `backend (0)` — "No changes in backend" — with the change in
 * frontend); else the first.
 */
export function preferredRepo(repos: readonly RepoLike[], current: string | null, picked: string | null): string | null {
  if (repos.length === 0) return current;
  if (picked && repos.some((r) => r.name === picked)) return picked;
  const cur = repos.find((r) => r.name === current);
  if (cur && cur.files.length > 0) return cur.name;
  return (repos.find((r) => r.files.length > 0) ?? cur ?? repos[0]).name;
}

/** One of a group's repos in the Diff toolbar's switch: what the diff on screen has of it (null: not in it, as a commit of another repo). */
export interface RepoSwitchItem {
  name: string;
  files: number | null;
  added: number;
  deleted: number;
}

/** A session's repos by their folder's name (what the diff calls them), in the session's own order. */
export function sessionRepoNames(paths: readonly string[]): string[] {
  return paths.map(
    (p) =>
      p
        .replace(/[\\/]+$/, '')
        .split(/[\\/]/)
        .pop() ?? p,
  );
}

/**
 * The Diff toolbar's repo switch for a group: every repo of the session, always, in the session's order (tabs that
 * come and go or move about with the diff can't be relied on), with what the diff on screen has in each.
 */
export function repoSwitch(
  names: readonly string[],
  repos: readonly { name: string; files: readonly { added: number; deleted: number }[] }[] | undefined,
): RepoSwitchItem[] {
  return names.map((name) => {
    const r = repos?.find((x) => x.name === name);
    return {
      name,
      files: r ? r.files.length : null,
      added: r ? r.files.reduce((s, f) => s + f.added, 0) : 0,
      deleted: r ? r.files.reduce((s, f) => s + f.deleted, 0) : 0,
    };
  });
}

/** Repos with changes first, in their own order; the rest after (shown dimmed). */
export function orderRepoTabs<T extends RepoLike>(repos: readonly T[]): T[] {
  return [...repos.filter((r) => r.files.length > 0), ...repos.filter((r) => r.files.length === 0)];
}

/** The repos shown as pills in the switch; `more`: the rest are in its list (the button after the pills). */
export interface RepoPills {
  pills: RepoSwitchItem[];
  more: boolean;
}

/**
 * Which of a group's repos are pills in the Diff toolbar, given the room the rest of the line leaves them: every repo,
 * in the session's order, when they all fit (a group of a few looks as it always did); else the ones with changes in
 * this pick, in the session's order, as many as fit beside the list's button (`moreWidth`, its gap included), and the
 * one on screen, the last ones taken giving way to it — unless even it doesn't fit (the button then names it).
 */
export function repoPills(
  items: readonly RepoSwitchItem[],
  active: string | null,
  room: number,
  widthOf: (name: string) => number,
  moreWidth: number,
): RepoPills {
  const total = items.reduce((s, r) => s + widthOf(r.name), 0);
  if (total <= room) return { pills: [...items], more: false };
  const left = room - moreWidth;
  const taken: RepoSwitchItem[] = [];
  let used = 0;
  for (const r of items.filter((x) => (x.files ?? 0) > 0)) {
    if (used + widthOf(r.name) > left) break;
    taken.push(r);
    used += widthOf(r.name);
  }
  const current = items.find((r) => r.name === active);
  if (current && !taken.includes(current)) {
    // Make room for the one on screen by letting go of the last ones taken; then back in the session's order.
    while (taken.length > 0 && used + widthOf(current.name) > left) used -= widthOf(taken.pop()!.name);
    if (used + widthOf(current.name) <= left) taken.push(current);
    taken.sort((a, b) => items.indexOf(a) - items.indexOf(b));
  }
  return { pills: taken, more: true };
}

/** The list's button: how many repos aren't pills, or the repo on screen when it isn't one. */
export interface RepoMoreButton {
  label: string;
  /** The label names the repo on screen (no pill for it). */
  current: boolean;
  /** Repos with no pill. */
  hidden: number;
  /** Of those, the ones with changes in this pick, the one on screen left out (it's the diff below). */
  hiddenChanged: number;
}

export function repoMoreButton(items: readonly RepoSwitchItem[], pills: readonly RepoSwitchItem[], active: string | null): RepoMoreButton {
  const rest = items.filter((r) => !pills.some((p) => p.name === r.name));
  const hiddenChanged = rest.filter((r) => (r.files ?? 0) > 0 && r.name !== active).length;
  const current = active !== null && rest.some((r) => r.name === active);
  return { label: current ? active : `+${rest.length}`, current, hidden: rest.length, hiddenChanged };
}

/** A section of the switch's list: its heading (none when it's the only one) and its repos. */
export interface RepoMenuSection {
  title: string;
  repos: RepoSwitchItem[];
}

/**
 * The switch's list: every repo of the group whose name has every word typed (any case), those with changes in this
 * pick first, then those with none, then those not in it (a commit is one repo's) — each in the session's order.
 */
export function repoMenuSections(items: readonly RepoSwitchItem[], query: string): RepoMenuSection[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const found = items.filter((r) => words.every((w) => r.name.toLowerCase().includes(w)));
  const sections = [
    { title: 'Changed', repos: found.filter((r) => r.files !== null && r.files > 0) },
    { title: 'No changes', repos: found.filter((r) => r.files === 0) },
    { title: 'Not in this pick', repos: found.filter((r) => r.files === null) },
  ].filter((s) => s.repos.length > 0);
  return sections.length === 1 ? [{ title: '', repos: sections[0].repos }] : sections;
}

/** What an empty diff says, for what was asked. */
export function emptyDiffMessage(shown: DiffSelection, resolvedBase: string | undefined, label?: string): string {
  if (shown.kind === 'range') {
    if (label === 'Since you looked') return 'Nothing changed since you last looked.';
    if (label === 'Last turn') return 'The last turn changed no files.';
    return shown.fromKey === shown.toKey ? 'This changed no files.' : 'Nothing changed in this span.';
  }
  if (shown.base === 'uncommitted') return 'No uncommitted changes.';
  if (!resolvedBase || resolvedBase === 'HEAD') {
    return (
      "Couldn't find this branch's parent. Tried main, master, dev, develop (and their origin/* mirrors). " +
      'Record one with `work tree --base <ref>`.'
    );
  }
  return `No commits since \`${resolvedBase}\` — this branch is up to date or already merged.`;
}
