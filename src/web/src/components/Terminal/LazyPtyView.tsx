import { lazy, Suspense, type ComponentProps } from 'react';

/**
 * The terminal, loaded on first use: xterm and its addons are a large part
 * of the dashboard's code, and the Inbox, Sessions or Start don't need them.
 * The dashboard preloads it once it has painted (preloadTerminal), so the
 * first terminal opens without a wait. (Not the diff view: `wd --static`
 * inlines the main bundle into one file, which can't fetch more.)
 */
const load = () => import('./PtyView.js');
const Inner = lazy(() => load().then((m) => ({ default: m.PtyView })));

/** Start loading the terminal's code now. */
export function preloadTerminal(): void {
  void load().catch(() => {
    /* it loads again on first use */
  });
}

export function PtyView(props: ComponentProps<typeof import('./PtyView.js').PtyView>) {
  return (
    <Suspense fallback={<div className="wd-term-loading" aria-busy="true" />}>
      <Inner {...props} />
    </Suspense>
  );
}
