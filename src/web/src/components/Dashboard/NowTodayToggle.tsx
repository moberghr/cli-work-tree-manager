import { Segmented } from '../../ui/index.js';

/**
 * "Now / Today" beside the Sessions title: the sessions as they stand, or
 * what each did today (the digest). One page, two views of it.
 */
export function NowTodayToggle({ value, onChange }: { value: 'now' | 'today'; onChange: (v: 'now' | 'today') => void }) {
  return (
    <Segmented
      label="Sessions view"
      value={value}
      onChange={onChange}
      options={[
        { value: 'now', label: 'Now', title: 'Every session as it stands (g s)' },
        { value: 'today', label: 'Today', title: 'What each session did today (g d)' },
      ]}
    />
  );
}
