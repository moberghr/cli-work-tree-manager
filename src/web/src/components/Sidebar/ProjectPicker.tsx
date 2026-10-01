import { useId, useMemo, useState } from 'react';
import type { ProjectSummary } from '../../api/panes.js';

/**
 * The New worktree dialog's project field: type to narrow the list (the
 * name, a group's repos, a repo's folder — every word must match), ↑/↓ and
 * Enter to pick, or click. 29 projects in a plain <select> could only be
 * scrolled. Groups first. Leaving it with text that names nothing puts the
 * picked project back.
 */

/** The projects whose name, members or folder contain every word of `query` (case-insensitive). */
export function matchProjects(projects: ProjectSummary[], query: string): ProjectSummary[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return projects;
  return projects.filter((p) => {
    const hay = [p.name, ...(p.members ?? []), p.path ?? ''].join(' ').toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}

export function ProjectPicker({
  projects,
  value,
  onChange,
  disabled,
  inputRef,
}: {
  projects: ProjectSummary[];
  value: string;
  onChange: (name: string) => void;
  disabled?: boolean;
  inputRef?: (el: HTMLInputElement | null) => void;
}) {
  const listId = useId();
  const [query, setQuery] = useState<string | null>(null); // null: not typing, show the value
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const shown = useMemo(() => matchProjects(projects, query ?? ''), [projects, query]);
  const label = (p: ProjectSummary) => (p.kind === 'group' ? `${p.name} (group)` : p.name);
  const current = projects.find((p) => p.name === value);

  const pick = (p: ProjectSummary | undefined) => {
    if (p) onChange(p.name);
    setQuery(null);
    setOpen(false);
  };

  return (
    <div className="wd-project-picker">
      <input
        ref={inputRef}
        type="text"
        role="combobox"
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={open && shown[active] ? `${listId}-${active}` : undefined}
        value={query ?? (current ? label(current) : value)}
        placeholder={projects.length ? 'Type to find a project…' : '(loading…)'}
        disabled={disabled}
        onFocus={(e) => {
          e.target.select();
          setOpen(true);
        }}
        onChange={(e) => {
          setQuery(e.target.value);
          setActive(0);
          setOpen(true);
        }}
        onBlur={() => {
          // A click on an option lands first (onMouseDown); anything else keeps what was picked.
          setQuery(null);
          setOpen(false);
        }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            setOpen(true);
            setActive((i) => Math.min(i + 1, shown.length - 1));
          } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setActive((i) => Math.max(i - 1, 0));
          } else if (e.key === 'Enter' && open) {
            // Pick, don't submit the dialog.
            e.preventDefault();
            pick(shown[active]);
          } else if (e.key === 'Escape' && open) {
            e.preventDefault();
            e.stopPropagation(); // the dialog stays open
            setQuery(null);
            setOpen(false);
          }
        }}
      />
      {open && (
        <ul id={listId} className="wd-project-picker-list" role="listbox">
          {shown.length === 0 && <li className="wd-project-picker-empty">No project matches “{query}”</li>}
          {shown.map((p, i) => (
            <li
              key={`${p.kind}:${p.name}`}
              id={`${listId}-${i}`}
              role="option"
              aria-selected={i === active}
              className={'wd-project-picker-option' + (i === active ? ' wd-project-picker-option-active' : '')}
              onMouseDown={(e) => {
                e.preventDefault(); // keep focus: no blur before the pick
                pick(p);
              }}
              onMouseEnter={() => setActive(i)}
            >
              <span>{label(p)}</span>
              {p.kind === 'group' && p.members?.length ? <span className="wd-project-picker-hint">{p.members.join(', ')}</span> : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
