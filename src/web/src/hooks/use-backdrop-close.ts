import { useRef } from 'react';
import type { MouseEvent } from 'react';

/**
 * A dialog's backdrop closes it on a click that started on the backdrop too.
 * A click's target is where the press and the release share an ancestor, so a
 * press in the dialog (selecting the prompt's text with a drag, or a field the
 * dialog moved away from as it grew) let go outside it lands on the backdrop:
 * checking the click's target alone closed the dialog, and what was typed in it
 * went with it.
 */
export function useBackdropClose(close: () => void) {
  const pressedOnBackdrop = useRef(false);
  return {
    onMouseDown: (e: MouseEvent) => {
      pressedOnBackdrop.current = e.target === e.currentTarget;
    },
    onClick: (e: MouseEvent) => {
      const started = pressedOnBackdrop.current;
      pressedOnBackdrop.current = false;
      if (started && e.target === e.currentTarget) close();
    },
  };
}
