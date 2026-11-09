import type { SessionBranchWire } from '../../api/client.js';
import { branchNote } from '../../state/branches.js';
import type { BranchGroup } from '../../state/diff-history.js';

/**
 * The Diff toolbar's branch switch, for a repo the session worked on more than one branch of: the branch checked
 * out (its Since branch) and every other one with something listed (its whole work, merged or not). A plain
 * select: a session can have many branches, and the toolbar has the room of one control.
 */
export function BranchSwitch({
  current,
  groups,
  shownBranch,
  branches = [],
  repo,
  onPick,
}: {
  /** The branch checked out in the repo on screen. */
  current: string | null;
  /** The other branches, newest first (branchGroups). */
  groups: BranchGroup[];
  /** The other branch the diff on screen is of, or null for the checked-out one's history. */
  shownBranch: string | null;
  /** What's known of each branch (the session row's): merged, not pushed, its PR. */
  branches?: SessionBranchWire[];
  /** A group's repo on screen (its folder), null for a single repo. */
  repo: string | null;
  /** null: back to the branch checked out (Since branch). */
  onPick: (branch: string | null) => void;
}) {
  const note = (name: string) => branchNote(branches.find((b) => b.name === name && (!repo || b.repo === repo)) ?? null, true);
  const label = (name: string) => {
    const n = note(name);
    return n ? `${name} · ${n}` : name;
  };
  return (
    <label className="wd-diff-branch-switch" title="The branches this session worked on in this repo: each one's whole change">
      <span className="wd-diff-branch-switch-tag">Branch</span>
      <select value={shownBranch ?? ''} onChange={(e) => onPick(e.target.value || null)} aria-label="Branch">
        <option value="">{current ? `${current} (checked out)` : 'Checked out'}</option>
        {groups.map((g) => (
          <option key={g.branch} value={g.branch}>
            {label(g.branch)}
          </option>
        ))}
      </select>
    </label>
  );
}
