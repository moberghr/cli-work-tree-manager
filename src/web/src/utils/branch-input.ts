import type { ChangeEvent } from 'react';

/** As it's typed or pasted: leading spaces gone, a run of spaces (with the dashes around it) one `-` — git takes no space. */
const asBranch = (s: string) => s.replace(/^\s+/, '').replace(/[\s-]*\s[\s-]*/g, '-');

/**
 * A branch name as you type it (#60): `fix login bug` → `fix-login-bug`, `fix - login` → `fix-login`; dashes you
 * typed yourself stay as they are. `caret` (where the cursor was) comes back where it belongs in the new text.
 */
export function typedBranch(value: string, caret = value.length): { value: string; caret: number } {
  return { value: asBranch(value), caret: asBranch(value.slice(0, caret)).length };
}

/** A branch field's onChange: sets the name as `typedBranch` makes it, the cursor kept where you were typing. */
export function onBranchChange(set: (branch: string) => void) {
  return (e: ChangeEvent<HTMLInputElement>) => {
    const el = e.target;
    const typed = typedBranch(el.value, el.selectionStart ?? el.value.length);
    set(typed.value);
    // React puts the cursor at the end when it writes a value the field didn't have.
    if (typed.value !== el.value) requestAnimationFrame(() => el.setSelectionRange(typed.caret, typed.caret));
  };
}
