import { closeSessionShown, openSessionPane, type SessionSummary } from '../../api/client.js';
import type { PaneViewWire, ShownFileWire } from '../../hooks/use-shown-file.js';
import { Button, Segmented, type SegmentedOption } from '../../ui/index.js';
import type { ResizeSpec } from '../Layout/ResizeDivider.js';
import { CodeView } from '../Code/CodeView.js';
import { DiffView } from '../Diff/DiffView.js';
import { ShownFilePane } from './ShownFilePane.js';
import { SessionReviewTab } from './tabs/SessionReviewTab.js';

type PaneTab = PaneViewWire['tab'];

/** The pane's width: dragged on its left edge (so `invert`), remembered per browser. */
export const SIDE_PANE_SPEC: ResizeSpec = {
  storageKey: 'work-web:side-pane-width',
  cssVar: '--side-pane-width',
  defaultPx: 640,
  min: 320,
  max: 1600,
  axis: 'x',
  invert: true,
  label: 'Resize the pane beside the terminal',
};

/** The pane's tabs: the shown file's only while one is shown. Pure. */
export function paneTabs(shown: Pick<ShownFileWire, 'path'> | null): SegmentedOption<PaneTab>[] {
  return [
    ...(shown
      ? [{ value: 'file' as const, label: shown.path, title: `The file it shows: ${shown.path}`, className: 'wd-side-pane-file-tab' }]
      : []),
    { value: 'diff', label: 'Diff', title: 'Its changes' },
    { value: 'code', label: 'Code', title: 'Its files' },
    { value: 'review', label: 'Review', title: 'Its review' },
  ];
}

/** A pane view's place in the Code view, once per ask (`at`): CodeView goes to each `seq` once. Pure. */
export function paneGoto(pane: PaneViewWire | null): { repo: string; path: string; line?: number; seq: number } | null {
  if (pane?.tab !== 'code' || !pane.place) return null;
  return { ...pane.place, seq: Date.parse(pane.at) || 1 };
}

interface Props {
  session: SessionSummary;
  pane: PaneViewWire;
  shown: ShownFileWire | null;
  /** The answer of a change made here, applied before the server's announcement comes back. */
  onWire: (w: { shown: ShownFileWire | null; pane: PaneViewWire | null }) => void;
  /** The shown file in the Code tab. */
  onOpenCode: () => void;
  /** Test seam: what a tab or × asks the server. */
  api?: { open: typeof openSessionPane; close: typeof closeSessionShown };
}

/**
 * The pane beside a session's terminal (asked for: a diff, the code or the review next to the conversation, not in
 * place of it): the file it shows (`work show <file>`) and the session's own Diff, Code and Review, one at a time
 * under a strip of tabs. Which one is on is the server's (`core/sessions/shown-file.ts`, `PaneView`), so `work show
 * --diff` from the agent and a tab clicked here move every window alike.
 */
export function SidePane({ session, pane, shown, onWire, onOpenCode, api = { open: openSessionPane, close: closeSessionShown } }: Props) {
  const id = session.id;
  const tab: PaneTab = pane.tab === 'file' && !shown ? 'diff' : pane.tab;
  const go = (t: PaneTab) => {
    if (t === tab) return;
    api.open(id, t).then(
      (w) => onWire({ shown: w.shown, pane: w.pane ?? null }),
      () => undefined,
    );
  };
  const close = () => {
    onWire({ shown: null, pane: null });
    api.close(id).catch(() => undefined);
  };
  return (
    <section className="wd-side-pane" aria-label="Beside the terminal">
      <header className="wd-side-pane-head">
        <Segmented
          kind="tabs"
          label="Beside the terminal"
          className="wd-side-pane-tabs"
          value={tab}
          onChange={go}
          options={paneTabs(shown)}
        />
        <Button variant="quiet" icon className="wd-side-pane-close" aria-label="Close the pane" title="Close the pane" onClick={close}>
          ×
        </Button>
      </header>
      <div className="wd-side-pane-body">
        {tab === 'file' && shown && (
          <ShownFilePane key={`${shown.repo}/${shown.path}`} session={session} shown={shown} closable={false} onOpenCode={onOpenCode} />
        )}
        {tab === 'diff' && <DiffView key={id} session={session} />}
        {tab === 'code' && <CodeView key={id} session={session} goto={paneGoto(pane)} onShowDiff={() => go('diff')} />}
        {tab === 'review' && <SessionReviewTab key={id} session={session} onShowTerminal={() => undefined} />}
      </div>
    </section>
  );
}
