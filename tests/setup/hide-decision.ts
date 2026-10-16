/**
 * Should the tests start their processes hidden (tests/setup/hide-windows.ts)? Decided once, in vitest's
 * own process (vitest.config.ts), and handed to every worker as WORK_TESTS_HIDE_WINDOWS.
 *
 * `windowsHide` gives each process a console of its own, hidden. That is what stops the flashing when the
 * run has no console to share (started from an agent's shell or an editor, output piped): each console
 * program then gets a new one anyway, so hiding it costs nothing. With a console to share — a terminal, a
 * CI runner — nothing flashes, and a console per process makes each git call 2–4× slower (measured: 26–33
 * ms shared, 58–115 ms hidden), which on CI pushed git-heavy setups past vitest's 10 s hook limit.
 *
 * So: on Windows, not on CI, and only when the run's output isn't a terminal. WORK_TESTS_HIDE_WINDOWS=1/0
 * set by hand wins.
 */
export function shouldHideWindows(o: { platform: NodeJS.Platform; env: NodeJS.ProcessEnv; stdoutIsTTY: boolean }): boolean {
  const asked = o.env.WORK_TESTS_HIDE_WINDOWS;
  if (asked === '1' || asked === '0') return asked === '1';
  return o.platform === 'win32' && !o.env.CI && !o.stdoutIsTTY;
}
