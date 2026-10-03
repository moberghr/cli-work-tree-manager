/**
 * Where does a keystroke's time go? Measures the echo round trip of one
 * character, hop by hop, in a throwaway HOME (the user's own PTY host and
 * work web are never touched):
 *
 *   conpty — node-pty in this process, straight to a raw-mode echo program:
 *            the floor Windows (ConPTY) gives us.
 *   host   — a WebSocket straight to the PTY host (what `work attach` does).
 *   relay  — through work web's terminal WebSocket (what the browser does).
 *
 * …each alone, and with N other sessions in the same host redrawing all the
 * time (like busy Claudes with spinners), since the host parses every
 * session's output into a headless terminal on one event loop.
 *
 *   npx tsx scripts/terminal-latency.ts [--samples 150] [--noise 0,5,10]
 *
 * Then, in a page (key → sent → echo back → drawn, and how long the
 * terminal takes to show up):
 *   --browser                 headless Chromium (Playwright's)
 *   --channel chrome|msedge   your installed browser, in a real window
 *   --desktop <work.exe>      the Tauri app (desktop/), driven through
 *                             WebView2's remote-debugging port
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const args = process.argv.slice(2);
const arg = (name: string, dflt: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
};
const SAMPLES = Number(arg('samples', '150'));
const NOISE = arg('noise', '0,5,10').split(',').map(Number);

// A private HOME before any work module is loaded: config, state.db,
// pty-host.json all go there.
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'term-latency-'));
// The desktop app needs the real ones: WebView2 won't open its DevTools
// port under a made-up profile folder (it reads no ~/.work: it's given the URL).
const realProfile = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
process.env.HOME = home;
process.env.USERPROFILE = home;
process.env.WORK_DB_EPHEMERAL = '1';

const fixtures = path.join(home, 'fixtures');
fs.mkdirSync(fixtures, { recursive: true });
const rawEcho = path.join(fixtures, 'raw-echo.cjs');
// Raw mode, like Claude Code (Ink): no terminal echo; the program echoes.
fs.writeFileSync(
  rawEcho,
  `if (process.stdin.isTTY) process.stdin.setRawMode(true);
process.stdout.write('ready\\r\\n');
process.stdin.on('data', (d) => process.stdout.write(d));
setInterval(() => {}, 1 << 30);
`,
);
const noise = path.join(fixtures, 'noise.cjs');
// A busy Claude: every 50 ms, cursor up 20 lines and redraw them in color
// with a spinner (roughly what Ink sends while a turn runs).
fs.writeFileSync(
  noise,
  `if (process.stdin.isTTY) process.stdin.setRawMode(true);
const frames = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏';
let n = 0;
setInterval(() => {
  n++;
  let s = n > 1 ? '\\x1b[20A' : '';
  for (let i = 0; i < 20; i++) s += '\\r\\x1b[2K\\x1b[38;5;' + ((i * 7 + n) % 230) + 'm' + frames[(n + i) % 10] + ' line ' + i + ' of a busy session — ' + 'x'.repeat(60) + ' ' + n + '\\x1b[0m\\r\\n';
  process.stdout.write(s);
}, 50);
`,
);

interface Stats {
  p50: number;
  p95: number;
  max: number;
  mean: number;
}
function stats(xs: number[]): Stats {
  const s = [...xs].sort((a, b) => a - b);
  const at = (q: number) => s[Math.min(s.length - 1, Math.floor(q * s.length))];
  return { p50: at(0.5), p95: at(0.95), max: s[s.length - 1], mean: s.reduce((a, b) => a + b, 0) / s.length };
}
const fmt = (st: Stats) =>
  `p50 ${st.p50.toFixed(1).padStart(6)}  p95 ${st.p95.toFixed(1).padStart(6)}  max ${st.max.toFixed(1).padStart(6)} ms`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Echo round trips over a socket-like transport: send one char, time
 *  until it comes back. Chars cycle so each wait sees its own. */
async function measure(send: (c: string) => void, onData: (cb: (s: string) => void) => void, samples: number): Promise<number[]> {
  let waiting: { c: string; t0: number; done: (ms: number) => void } | null = null;
  onData((s) => {
    if (waiting && s.includes(waiting.c)) {
      const w = waiting;
      waiting = null;
      w.done(performance.now() - w.t0);
    }
  });
  const chars = 'abcdefghijklmnopqrstuvwxyz';
  const out: number[] = [];
  for (let i = 0; i < samples + 10; i++) {
    const c = chars[i % chars.length];
    const ms = await new Promise<number>((resolve) => {
      waiting = { c, t0: performance.now(), done: resolve };
      send(c);
      setTimeout(() => {
        if (waiting?.c === c) {
          waiting = null;
          resolve(NaN);
        }
      }, 5000);
    });
    if (i >= 10 && Number.isFinite(ms)) out.push(ms); // first 10: warm-up
    await sleep(15);
  }
  return out;
}

async function main() {
  const { WebSocket } = await import('ws');
  const pty = await import('node-pty');
  const { PtyRegistry } = await import('../src/core/pty-registry.js');
  const { startPtyHost } = await import('../src/core/pty-host.js');
  const { PtyHostClient } = await import('../src/core/pty-host-client.js');
  const { upsertSession } = await import('../src/core/history.js');
  const { sessionIdFor } = await import('../src/core/session-id.js');
  const { startWebServer } = await import('../src/core/web-server.js');

  const cwd = path.join(home, 'wt');
  fs.mkdirSync(cwd, { recursive: true });
  fs.mkdirSync(path.join(home, '.work'), { recursive: true });
  fs.writeFileSync(
    path.join(home, '.work', 'config.json'),
    JSON.stringify({ worktreesRoot: home, repos: { lat: cwd }, groups: {}, copyFiles: [], aiCommand: `node ${rawEcho}` }),
  );
  const tool = (file: string) =>
    ({ cmd: 'node', baseArgs: [file], unsafeFlag: '', resumeFlag: '', promptFileFlag: '', promptFlag: '' }) as never;

  // --- conpty: in-process, no host ---------------------------------------
  const p = pty.spawn(process.execPath, [rawEcho], { cols: 120, rows: 32, cwd, env: process.env as Record<string, string> });
  await new Promise<void>((r) => {
    const d = p.onData((s) => {
      if (s.includes('ready')) {
        d.dispose();
        r();
      }
    });
  });
  const conpty = await measure(
    (c) => p.write(c),
    (cb) => p.onData(cb),
    SAMPLES,
  );
  p.kill();

  // --- the host, and work web in front of it ------------------------------
  const registry = new PtyRegistry({ sessionsPath: path.join(home, 'pty-sessions.json'), hasConversation: () => false });
  const host = await startPtyHost({ registry, restore: false, writeInfo: true });
  const client = new PtyHostClient(host.info);
  await client.spawn('lat-direct', { cwd, tool: tool(rawEcho), cols: 120, rows: 32 });
  await upsertSession('lat', false, 'main', [cwd]);
  const sessionId = sessionIdFor({ target: 'lat', branch: 'main' });
  const web = await startWebServer({ lean: true });
  const webPort = new URL(web.url).port;

  const openWs = async (url: string, headers: Record<string, string> = {}) => {
    const ws = new WebSocket(url, { headers });
    const listeners: Array<(s: string) => void> = [];
    ws.on('message', (d, bin) => {
      if (bin) for (const l of listeners) l((d as Buffer).toString());
    });
    await new Promise((r, j) => {
      ws.once('open', r);
      ws.once('error', j);
    });
    await sleep(400); // replay + first output
    return {
      send: (c: string) => ws.send(JSON.stringify({ type: 'input', data: c })),
      onData: (cb: (s: string) => void) => listeners.push(cb),
      close: () => ws.close(),
    };
  };

  const rows: Array<[string, Stats]> = [['conpty (in-process, no host)', stats(conpty)]];
  for (const n of NOISE) {
    for (let i = 0; i < n; i++) await client.spawn(`noise-${i}`, { cwd, tool: tool(noise), cols: 120, rows: 32 });
    await sleep(800);
    const direct = await openWs(client.attachUrl('lat-direct'));
    rows.push([`host, ${n} busy sessions`, stats(await measure(direct.send, direct.onData, SAMPLES))]);
    direct.close();
    const relay = await openWs(`ws://127.0.0.1:${webPort}/ws/sessions/${encodeURIComponent(sessionId)}/terminal`, {
      Origin: `http://127.0.0.1:${webPort}`,
    });
    rows.push([`relay, ${n} busy sessions`, stats(await measure(relay.send, relay.onData, SAMPLES))]);
    relay.close();
    for (let i = 0; i < n; i++) await registry.kill(`noise-${i}`);
  }

  console.log(`\nKeystroke echo round trip, ${SAMPLES} samples each (${os.cpus().length} cores, Node ${process.version})\n`);
  for (const [name, st] of rows) console.log(`  ${name.padEnd(30)} ${fmt(st)}`);
  console.log('');

  const desktopExe = arg('desktop', '');
  const channel = arg('channel', '');
  if (args.includes('--browser') || channel || desktopExe) {
    await browserStage(web.url, sessionId, cwd, upsertSession, { channel, desktopExe });
  }
  const avaloniaExe = arg('avalonia', '');
  if (avaloniaExe) await avaloniaStage(web.url, sessionId, avaloniaExe);

  await web.stop();
  await Promise.all(registry.list().map((x) => registry.kill(x.id)));
  await host.stop();
  fs.rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}

/**
 * The browser: keydown → input frame sent (xterm) → echo frame received →
 * next animation frame (drawn). Once with a quiet dashboard, once with 300
 * sessions and a status change every 500 ms — the dashboard refetching
 * and re-rendering its lists on the same thread as the terminal.
 */
async function browserStage(
  webUrl: string,
  sessionId: string,
  cwd: string,
  upsertSession: (t: string, g: boolean, b: string, p: string[]) => Promise<unknown>,
  target: { channel: string; desktopExe: string },
): Promise<void> {
  const { chromium } = await import('@playwright/test');
  let label: string;
  let close: () => Promise<void>;
  let page: import('@playwright/test').Page;
  if (target.desktopExe) {
    // The app opens a WebView2 DevTools port when WORK_DESKTOP_CDP_PORT is set;
    // WORK_DESKTOP_URL points it at this throwaway server.
    const { spawn, execFileSync } = await import('node:child_process');
    const port = 9333;
    const child = spawn(target.desktopExe, [], {
      env: { ...process.env, ...realProfile, WORK_DESKTOP_URL: webUrl, WORK_DESKTOP_CDP_PORT: String(port) },
      stdio: 'ignore',
    });
    let browser: import('@playwright/test').Browser | null = null;
    for (let i = 0; i < 60 && !browser; i++) {
      await sleep(500);
      browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`).catch(() => null);
    }
    if (!browser) throw new Error('the desktop app never opened its DevTools port');
    const context = browser.contexts()[0];
    page = context.pages()[0] ?? (await context.waitForEvent('page'));
    // Let the app finish its own navigation to the dashboard first.
    await page.waitForURL((u) => u.href.startsWith(webUrl), { timeout: 30_000 });
    label = 'Desktop app (Tauri, WebView2)';
    close = async () => {
      await browser!.close().catch(() => {});
      try {
        execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
      } catch {
        /* gone */
      }
    };
  } else {
    const headless = !target.channel;
    const browser = await chromium.launch({
      channel: target.channel || undefined,
      headless,
      args: ['--enable-gpu', '--use-angle=d3d11'],
    });
    page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
    label = headless ? 'Browser (headless Chromium)' : `Browser (${target.channel}, a real window)`;
    close = () => browser.close();
  }
  page.on('pageerror', (e) => console.log('    page error:', e.message.slice(0, 200)));
  // Plain JS text: tsx (esbuild) wraps named functions in a __name() helper
  // that doesn't exist in the page, so a serialized function would throw.
  await page.addInitScript(`
    const w = window;
    w.__lat = { key: [], send: [], recv: [], paint: [] };
    window.addEventListener('keydown', () => w.__lat.key.push(performance.now()), true);
    const proto = WebSocket.prototype;
    const origSend = proto.send;
    proto.send = function (d) {
      if (typeof d === 'string' && d.includes('"input"')) w.__lat.send.push(performance.now());
      return origSend.call(this, d);
    };
    const origAdd = proto.addEventListener;
    proto.addEventListener = function (type, fn, opts) {
      if (type === 'message' && this.url.includes('/terminal') && typeof fn === 'function') {
        const self = this;
        return origAdd.call(this, type, function (e) {
          const binary = typeof e.data !== 'string';
          if (binary) w.__lat.recv.push(performance.now());
          fn.call(self, e); // PtyView hands the bytes to xterm here
          if (binary) requestAnimationFrame(() => w.__lat.paint.push(performance.now()));
        }, opts);
      }
      return origAdd.call(this, type, fn, opts);
    };
  `);

  const run = async (label: string, samples: number) => {
    let t0 = performance.now();
    await page.goto(`${webUrl}#/s/${encodeURIComponent(sessionId)}/term`);
    // Already on the dashboard (the desktop app): a hash change loads no new
    // document, so the init script hasn't run. A reload is one.
    if (!(await page.evaluate('!!window.__lat'))) {
      t0 = performance.now();
      await page.reload();
    }
    await page.locator('.wd-pty-host .xterm').waitFor();
    await page.locator('.wd-pty-connecting').waitFor({ state: 'detached' });
    const ready = performance.now() - t0;
    await page.locator('.wd-pty-host .xterm').click();
    await sleep(1500);
    const parts = { input: [] as number[], network: [] as number[], draw: [] as number[], total: [] as number[] };
    for (let i = 0; i < samples + 5; i++) {
      await page.evaluate(() => {
        const l = (window as unknown as { __lat: Record<string, number[]> }).__lat;
        for (const k of Object.keys(l)) l[k].length = 0;
      });
      await page.keyboard.press(String.fromCharCode(97 + (i % 26)));
      await sleep(120);
      const l = await page.evaluate(() => (window as unknown as { __lat: Record<string, number[]> }).__lat);
      if (process.env.LAT_DEBUG && i === 0) {
        console.log('    elsewhere panel:', await page.locator('.wd-pty-elsewhere').count(), 'url:', page.url());
        page.on('console', (m) => console.log('    console:', m.text().slice(0, 160)));
        page.on('websocket', (ws) => {
          console.log('    ws opened', ws.url());
          ws.on('framereceived', (f) =>
            console.log('    frame', typeof f.payload === 'string' ? f.payload.slice(0, 100) : `[${f.payload.length} bytes]`),
          );
          ws.on('close', () => console.log('    ws closed'));
        });
        await page.reload();
        await sleep(3000);
      }
      if (process.env.LAT_DEBUG && i < 3)
        console.log(
          '    debug',
          JSON.stringify(Object.fromEntries(Object.entries(l).map(([k, v]) => [k, v.length]))),
          await page.evaluate(() => document.activeElement?.className ?? ''),
        );
      if (i < 5 || !l.key.length || !l.send.length || !l.recv.length || !l.paint.length) continue;
      parts.input.push(l.send[0] - l.key[0]);
      parts.network.push(l.recv[0] - l.send[0]);
      parts.draw.push(l.paint[0] - l.recv[0]);
      parts.total.push(l.paint[0] - l.key[0]);
    }
    console.log(`  ${label}`);
    console.log(`    ${'open'.padEnd(8)} ${ready.toFixed(0).padStart(6)} ms  (page load → terminal on screen)`);
    for (const [k, xs] of Object.entries(parts)) if (xs.length) console.log(`    ${k.padEnd(8)} ${fmt(stats(xs))}`);
  };

  console.log(`${label}: key → sent → echo back → drawn\n`);
  await run('quiet dashboard, 1 session', 60);

  for (let i = 0; i < 300; i++) await upsertSession('lat', false, `feat/load-${i}`, [path.join(cwd, '..', `load-${i}`)]);
  let on = true;
  const churn = (async () => {
    while (on) {
      await fetch(`${webUrl}api/status-changed`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cwd }),
      }).catch(() => {});
      await sleep(500);
    }
  })();
  await run('300 sessions, a status change every 500 ms', 60);
  on = false;
  await churn;
  await close();
  console.log('');
}

/**
 * The native terminal (desktop/avalonia, kept on the spike/avalonia branch): the app benchmarks itself when told to
 * (WORK_DESKTOP_BENCH, see its Views/Bench.cs) — open the session, then type
 * through its input path — and writes the numbers to a file before exiting.
 */
async function avaloniaStage(webUrl: string, sessionId: string, exe: string): Promise<void> {
  const { spawn, execFileSync } = await import('node:child_process');
  const out = path.join(home, 'avalonia-bench.txt');
  const child = spawn(exe, [], {
    env: { ...process.env, ...realProfile, WORK_DESKTOP_URL: webUrl, WORK_DESKTOP_BENCH: sessionId, WORK_DESKTOP_BENCH_OUT: out },
    stdio: 'ignore',
  });
  const exited = await Promise.race([new Promise<boolean>((r) => child.once('exit', () => r(true))), sleep(90_000).then(() => false)]);
  if (!exited) {
    try {
      execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    } catch {
      /* gone */
    }
  }
  console.log('Native terminal (Avalonia, Skia): key → echo back → drawn\n');
  if (!fs.existsSync(out)) {
    console.log('  no result (the app did not finish)\n');
    return;
  }
  for (const line of fs.readFileSync(out, 'utf8').split(/\r?\n/)) {
    const [k, ...rest] = line.split(' ');
    if (k === 'open') console.log(`    ${'open'.padEnd(8)} ${rest[0].padStart(6)} ms  (session opened → terminal on screen)`);
    else if (k === 'total' && rest.length) console.log(`    ${'total'.padEnd(8)} ${fmt(stats(rest.map(Number)))}`);
    else if (k === 'error') console.log(`    error: ${rest.join(' ')}`);
  }
  console.log('');
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
