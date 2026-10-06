/**
 * "Needs you: 6 open review threads · #1927 checks failing [PR tab ▸]" under
 * the session's status line: one line for what waits on you on GitHub,
 * pointing into the PR tab, where all of it is (no button while it's open).
 */
export function NeedsYouBar({ text, onOpen }: { text: string; onOpen?: () => void }) {
  return (
    <div className="wd-needs-you" role="status">
      <span className="wd-needs-you-label">Needs you</span>
      <span className="wd-needs-you-text">{text}</span>
      {onOpen && (
        <button type="button" className="wd-btn-secondary wd-needs-you-btn" onClick={onOpen}>
          PR tab ▸
        </button>
      )}
    </div>
  );
}
