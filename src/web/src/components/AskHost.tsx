import { useEffect, useRef, useState } from 'react';
import { answer, attachAskHost, type Question } from '../state/ask.js';
import { Button } from '../ui/index.js';

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
          <Button onClick={() => answer(false)}>Cancel</Button>
          <Button variant={question.danger ? 'danger' : 'primary'} ref={okRef} onClick={() => answer(true)}>
            {question.ok ?? 'OK'}
          </Button>
        </footer>
      </div>
    </div>
  );
}
