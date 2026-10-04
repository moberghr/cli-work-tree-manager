/**
 * What takes the keyboard from the dashboard's shortcuts (j/k, n, g …, F2,
 * Alt+1…9, a session's keys): a dialog, a confirm, a modal, an open menu
 * (it owns the arrows and Esc; a key would act on what's behind it). Not
 * a popover (Tasks, Activity, the icon legend, the shortcuts list:
 * `data-popover`), which closes on Esc or a click elsewhere and leaves the
 * shortcuts working — `g t` closes the Tasks panel it opened.
 */
export const MODAL_SELECTOR = '[role="dialog"]:not([data-popover]), [role="alertdialog"], [aria-modal="true"], [role="menu"]';

export function modalOpen(root: ParentNode = document): boolean {
  return root.querySelector(MODAL_SELECTOR) !== null;
}
