import type { Hunk } from '../../api/client.js';
import {
  hunkRows,
  type IntraSpan,
  type SideRow,
} from '../../utils/intraline.js';

interface Props {
  hunk: Hunk;
}

export function DiffHunk({ hunk }: Props) {
  const rows = hunkRows(hunk);
  const ctxText = hunk.context ? ' ' + hunk.context : '';
  return (
    <>
      <tr className="wd-hunk-row">
        <td colSpan={4} className="wd-hunk-context">
          @@ -{hunk.oldStart},{hunk.oldLines} +{hunk.newStart},{hunk.newLines}{' '}
          @@{ctxText}
        </td>
      </tr>
      {rows.map((r, i) => (
        <DiffSideRow row={r} key={i} />
      ))}
    </>
  );
}

function DiffSideRow({ row }: { row: SideRow }) {
  return (
    <tr className="wd-row">
      <td className={`wd-ln wd-ln-old wd-${row.oldKind}`}>
        {row.oldNum ?? ''}
      </td>
      <td className={`wd-content wd-${row.oldKind}`}>
        <ContentCell text={row.oldContent} spans={row.oldSpans} kind="delete" />
      </td>
      <td className={`wd-ln wd-ln-new wd-${row.newKind}`}>
        {row.newNum ?? ''}
      </td>
      <td className={`wd-content wd-${row.newKind}`}>
        <ContentCell text={row.newContent} spans={row.newSpans} kind="add" />
      </td>
    </tr>
  );
}

function ContentCell({
  text,
  spans,
  kind,
}: {
  text: string;
  spans: IntraSpan[] | undefined;
  kind: 'add' | 'delete';
}) {
  if (spans) {
    return (
      <>
        {spans.map((s, i) =>
          s.changed ? (
            <span key={i} className={`wd-intra-${kind === 'add' ? 'add' : 'del'}`}>
              {s.text}
            </span>
          ) : (
            <span key={i}>{s.text}</span>
          ),
        )}
      </>
    );
  }
  return <>{text || ' '}</>;
}
