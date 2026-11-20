import { useEffect, useState } from 'react';
import type { SettingKind } from '../../../../core/settings/settings-schema.js';
import { listText, parseList, sameValue } from '../../state/settings-view.js';

/**
 * One setting's input, by its kind: a switch and a choice save as they change; a number, a line of text and a list
 * (one entry a line) save when you leave the field or press Enter (a list: Ctrl+Enter), and only when they changed.
 * Saving says so; a refusal shows the server's reason under it, and what you typed stays to fix.
 */
export function SettingInput({
  id,
  kind,
  value,
  placeholder,
  onSave,
}: {
  id: string;
  kind: SettingKind;
  value: unknown;
  placeholder?: string;
  /** Resolves once saved; rejects with why not. */
  onSave: (value: unknown) => Promise<unknown>;
}) {
  const asText = (v: unknown) => (kind.type === 'list' ? listText(v) : v === null || v === undefined ? '' : String(v));
  const [draft, setDraft] = useState(asText(value));
  const [state, setState] = useState<'idle' | 'saving' | 'saved'>('idle');
  const [error, setError] = useState<string | null>(null);
  // A value that changed elsewhere (another window, a reset) replaces the draft — unless you're mid-edit with an error.
  useEffect(() => {
    if (!error) setDraft(asText(value));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only a new value from outside resets the draft
  }, [value]);

  const save = (next: unknown) => {
    setState('saving');
    setError(null);
    onSave(next).then(
      () => {
        setState('saved');
        setTimeout(() => setState((s) => (s === 'saved' ? 'idle' : s)), 1500);
      },
      (e: Error) => {
        setState('idle');
        setError(e.message);
      },
    );
  };
  const commitText = () => {
    const next = kind.type === 'list' ? parseList(draft) : draft.trim();
    const was = kind.type === 'list' ? (Array.isArray(value) ? value : []) : asText(value);
    if (!sameValue(next, was)) save(kind.type === 'list' ? next : next === '' ? null : next);
  };

  let input: React.ReactNode;
  switch (kind.type) {
    case 'bool':
      input = (
        <input id={id} type="checkbox" checked={value === true} disabled={state === 'saving'} onChange={(e) => save(e.target.checked)} />
      );
      break;
    case 'choice':
      input = (
        <select
          id={id}
          value={typeof value === 'string' ? value : ''}
          disabled={state === 'saving'}
          onChange={(e) => save(e.target.value || null)}
        >
          <option value="">—</option>
          {kind.options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      );
      break;
    case 'list':
      input = (
        <textarea
          id={id}
          rows={Math.min(8, Math.max(2, draft.split('\n').length + 1))}
          value={draft}
          placeholder={placeholder ? `${placeholder}\n(one a line)` : 'one a line'}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commitText}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) commitText();
          }}
        />
      );
      break;
    default:
      input = (
        <input
          id={id}
          type="text"
          inputMode={kind.type === 'number' ? 'decimal' : undefined}
          value={draft}
          placeholder={placeholder}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commitText}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commitText();
            if (e.key === 'Escape') {
              setDraft(asText(value));
              setError(null);
            }
          }}
        />
      );
  }
  return (
    <span className="wd-setting-input">
      {input}
      {state === 'saving' && <span className="wd-setting-state">Saving…</span>}
      {state === 'saved' && <span className="wd-setting-state wd-setting-saved">Saved ✓</span>}
      {error && (
        <span className="wd-setting-error" role="alert">
          {error}
        </span>
      )}
    </span>
  );
}
