import { useEffect, useRef, type ReactNode } from 'react';

interface Props {
  title: string;
  children: ReactNode;
  actions: ReactNode;
  onClose: () => void;
  /** Optional primary autofocus target; if not provided, defaults to the
   *  first .wd-btn-primary inside `actions`. */
  primaryRef?: React.RefObject<HTMLElement | null>;
}

/** A small themed modal — used for submit-review and end-review confirmations. */
export function Modal({ title, children, actions, onClose, primaryRef }: Props) {
  const backdropRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);
  useEffect(() => {
    if (primaryRef?.current) {
      primaryRef.current.focus();
      return;
    }
    const primary = backdropRef.current?.querySelector<HTMLButtonElement>(
      '.wd-btn-primary',
    );
    primary?.focus();
  }, [primaryRef]);
  return (
    <div
      className="wd-modal-backdrop"
      ref={backdropRef}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="wd-modal">
        <h2>{title}</h2>
        {children}
        <div className="wd-modal-actions">{actions}</div>
      </div>
    </div>
  );
}
