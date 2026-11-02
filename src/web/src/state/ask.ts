/**
 * "Are you sure?" as the page's own dialog, never `window.confirm`: the desktop app's
 * macOS webview (WKWebView) shows no dialog for it and answers false, so every button
 * behind one did nothing there ("It's not running — start it here…", Archive).
 *
 * `ask` resolves true on OK, false on Cancel / Esc / a click outside. `AskHost`
 * (mounted once by `App`) shows the questions one at a time, in the order asked;
 * with no host mounted (a component tested alone) it falls back to `window.confirm`.
 */
export interface Question {
  text: string;
  /** The OK button's label (default "OK"). */
  ok?: string;
}

interface Pending extends Question {
  answer: (yes: boolean) => void;
}

type Listener = (current: Question | null) => void;

const queue: Pending[] = [];
let host: Listener | null = null;

export function ask(text: string, opts: { ok?: string } = {}): Promise<boolean> {
  if (!host) return Promise.resolve(typeof window !== 'undefined' && window.confirm(text));
  return new Promise((resolve) => {
    queue.push({ text, ok: opts.ok, answer: resolve });
    if (queue.length === 1) host?.(queue[0]);
  });
}

/** The host's answer to the question on screen; the next one (if any) shows. */
export function answer(yes: boolean): void {
  const done = queue.shift();
  done?.answer(yes);
  host?.(queue[0] ?? null);
}

/** `AskHost` registers here; returns its removal, which answers what's left with no. */
export function attachAskHost(listener: Listener): () => void {
  host = listener;
  listener(queue[0] ?? null);
  return () => {
    if (host !== listener) return;
    host = null;
    for (const p of queue.splice(0)) p.answer(false);
  };
}
