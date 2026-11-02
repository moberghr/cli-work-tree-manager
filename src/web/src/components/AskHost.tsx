import { useEffect, useRef, useState } from 'react';
import { answer, attachAskHost, type Question } from '../state/ask.js';

/**
 * Shows `ask`'s questions (state/ask.ts) as an in-page dialog: Enter / OK says yes,
 * Esc / Cancel / a click outside says no. Its keys stop here, so a modal under it
 * (Submit your review) doesn't close with it.
 */
export function AskHost() {
  const [question, setQuestion] = useState<Question | null>(null);
  const okRef = useRef<HTMLButtonElement>(null);
  useEffect(() => attachAskHost(setQuestion), []);
  useEffect(() => {
    if (question) okRef.current?.focus();
  }, [question]);
  if (!question) return null;
  return (
    <div
      className="wd-modal-backdrop wd-ask-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) answer(false);
      }}
    >
      <div
        className="wd-modal wd-ask"
        role="alertdialog"
        aria-modal="true"
        aria-describedby="wd-ask-text"
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === 'Escape') {
            e.preventDefault();
            answer(false);
          }
        }}
      >
        <div className="wd-modal-body">
          <p id="wd-ask-text" className="wd-ask-text">
            {question.text}
          </p>
        </div>
        <footer className="wd-modal-footer">
          <button type="button" className="wd-btn-secondary" onClick={() => answer(false)}>
            Cancel
          </button>
          <button type="button" ref={okRef} className="wd-btn-primary" onClick={() => answer(true)}>
            {question.ok ?? 'OK'}
          </button>
        </footer>
      </div>
    </div>
  );
}
