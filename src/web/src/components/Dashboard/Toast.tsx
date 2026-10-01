import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * A short message at the bottom of the window for what an action did — or
 * why it didn't ("Couldn't open the editor: …") — when there is no place
 * on the page for it (a right-click menu, a bulk action). Gone after a few
 * seconds or on a click.
 */

export interface ToastMessage {
  text: string;
  kind?: 'info' | 'error';
}

export function useToast(ms = 5000): { toast: ToastMessage | null; show: (t: ToastMessage) => void; hide: () => void } {
  const [toast, setToast] = useState<ToastMessage | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hide = useCallback(() => setToast(null), []);
  const show = useCallback(
    (t: ToastMessage) => {
      setToast(t);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(hide, t.kind === 'error' ? ms * 2 : ms);
    },
    [hide, ms],
  );
  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);
  return { toast, show, hide };
}

export function Toast({ toast, onClose }: { toast: ToastMessage | null; onClose: () => void }) {
  if (!toast) return null;
  return (
    <div className={'wd-toast' + (toast.kind === 'error' ? ' wd-toast-error' : '')} role={toast.kind === 'error' ? 'alert' : 'status'} onClick={onClose}>
      {toast.text}
    </div>
  );
}
