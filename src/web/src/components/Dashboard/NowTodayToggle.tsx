/**
 * "Now / Today" beside the Sessions title: the sessions as they stand, or
 * what each did today (the digest). One page, two views of it.
 */
export function NowTodayToggle({ value, onChange }: { value: 'now' | 'today'; onChange: (v: 'now' | 'today') => void }) {
  return (
    <span className="wd-segmented" role="group" aria-label="Sessions view">
      {(['now', 'today'] as const).map((v) => (
        <button
          key={v}
          type="button"
          className={'wd-segmented-btn' + (value === v ? ' wd-segmented-btn-on' : '')}
          aria-pressed={value === v}
          title={v === 'now' ? 'Every session as it stands (g s)' : 'What each session did today (g d)'}
          onClick={() => onChange(v)}
        >
          {v === 'now' ? 'Now' : 'Today'}
        </button>
      ))}
    </span>
  );
}
