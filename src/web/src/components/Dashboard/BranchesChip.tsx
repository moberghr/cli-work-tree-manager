import { useEffect, useRef, useState } from 'react';
import type { SessionSummary } from '../../api/client.js';
import { branchesChip } from '../../state/branches.js';
import { BranchesLine } from './SessionBits.js';

/**
 * "3 branches ▾" beside the session's name, when it worked on more than one: a glance (amber when one holds work
 * not pushed), opening the list — a click on a branch shows its changes in the Diff tab — and the way to the
 * Branches tab, which has the rest. It replaced the always-open Branches line under the header (reported: the
 * header was three lines before the tabs).
 */
export function BranchesChip({
  session,
  onShow,
  onOpenTab,
}: {
  session: SessionSummary;
  onShow?: (repo: string, name: string) => void;
  onOpenTab?: () => void;
}) {
  const chip = branchesChip(session);
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', away);
    window.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('mousedown', away);
      window.removeEventListener('keydown', esc);
    };
  }, [open]);
  if (!chip) return null;
  const title = chip.unpushed
    ? `${chip.unpushed} of them hold${chip.unpushed === 1 ? 's' : ''} work not pushed`
    : 'The branches this session worked on';
  return (
    <span className="wd-branches-chip-box" ref={box}>
      <button
        type="button"
        className={'wd-branches-chip' + (chip.unpushed ? ' wd-branches-chip-unpushed' : '')}
        aria-haspopup="dialog"
        aria-expanded={open}
        title={title}
        onClick={() => setOpen((o) => !o)}
      >
        {chip.count} branches ▾
      </button>
      {open && (
        <div className="wd-branches-pop" data-popover role="dialog" aria-label="Branches it worked on">
          <BranchesLine
            session={session}
            onShow={
              onShow &&
              ((repo, name) => {
                setOpen(false);
                onShow(repo, name);
              })
            }
          />
          {onOpenTab && (
            <button
              type="button"
              className="wd-link-button wd-branches-pop-more"
              onClick={() => {
                setOpen(false);
                onOpenTab();
              }}
            >
              Turns, commits and more in the Branches tab →
            </button>
          )}
        </div>
      )}
    </span>
  );
}
