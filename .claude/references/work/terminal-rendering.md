# Terminal rendering (what an attaching terminal is sent)

**The mirror.** Each PTY in the PTY host has a copy of its screen, `ScreenMirror` (`core/pty/screen-mirror.ts`, owned by `PtySession`): an @xterm/headless 6 terminal that is written everything the agent prints, with the serialize addon loaded. A client that attaches (a Terminal tab, `work attach`) is first sent the mirror's `snapshot()` as the `replay` frame, then live output (`registry.attach`, see pty-host.md). Raw output history isn't sent instead: it can start in the middle of a sequence, and it was drawn for another client's grid. VS Code does the same.

§ The mirror measures text with Unicode 11 widths, as the browser does (`PtyView` loads `@xterm/addon-unicode11` and sets version 11). With the default Unicode 6 table, 👍 ⭐ ✅ ⏳ 🚀 were 1 column in the mirror and 2 in the browser, so every replayed line that had one was laid out for the wrong columns. `@xterm/addon-unicode11` is therefore a runtime dependency, kept external in `tsup.config.ts` beside `@xterm/headless` and `@xterm/addon-serialize`.

## What a snapshot is

The serialize addon (0.14.0) draws the normal screen and its scrollback, then the alternate screen behind `CSI ? 1049 h CSI H` if it is shown, then a few modes: DECCKM, the keypad, bracketed paste, insert, origin, reverse wraparound, focus, no-wraparound and one mouse protocol. Reproduced on our versions: after an agent wrote `CSI ? 1049 h`, `1000 h`, `1002 h`, `1006 h`, `2004 h`, `1004 h`, `25 l`, `CSI 5 SP q`, `OSC 2 ; title`, `CSI > 1 u` and `CSI 2 ; 4 r`, the snapshot carried only the alternate screen, 2004, 1004 and 1002. The SGR mouse encoding (1006) was lost, so the client reported clicks in the old X10 format the agent can't read. The hidden cursor was lost, so a blinking cursor showed where the agent had hidden it. The cursor shape, the title, the scroll region and the kitty keyboard flags were lost too.

So a snapshot is three parts.

- **Start.** `ESC 7`, `CSI ? 1049 l`, home, clear, DECSTR (`CSI ! p`) and `CSI 0 m`. This puts the target in the state the addon's output assumes: the normal screen, cleared, with the default character sets, no scroll region, no origin mode and the default pen. A fresh terminal is in that state already. A terminal that was written a snapshot before (reported: the second copy drew its text through the DEC line-drawing set the first one left, `r` came out as `⎼`) or the real terminal `work attach` writes into may not be. `ESC 7` comes first so that the cursor `1049 l` restores is where the cursor already is. A snapshot written twice ends in the state it ends in once: the screen, the cursor and the modes are the same, and the first copy's screen goes to the scrollback. A snapshot of a terminal written a snapshot is the same snapshot byte for byte (tested).
- **The addon's output.** When the alternate screen is shown, the normal screen's own state goes just before the addon's `1049 h`: its scroll region, its cursor again (DECSTBM homes it, and 1049 saves it) and its kitty flags. A terminal leaving the alternate screen later then lands where the app left it.
- **Rehydration**, in this order, because some of it moves the cursor:
  1. `CSI ? 6 l` if origin mode is on, so that the positions below are absolute.
  2. The saved cursor (DECSC: `ESC 7`, `CSI s`, `1048 h`) as a position plus `ESC 7`. Reproduced: the addon drops it, and a later `ESC 8` went to the top-left corner (xterm.js #6232).
  3. The mouse. First every protocol off, then the app's protocol on. Then every encoding off, then the app's encodings (1005, 1006, 1015, 1016) replayed in the order it wrote them, one per mode. The resets must come first: in xterm.js any protocol reset turns off whichever is on, and `1016 l` turns off SGR as well as SGR-pixel. The encodings are replayed in order rather than reduced to one, because terminals differ: xterm.js ignores 1005 and 1015, xterm takes the last one set. Each terminal then ends where the live stream would have left it.
  4. The DEC modes: 1, 7, 25, 45, 1004 and 2004 are stated either way (`h` or `l`), plus the keypad (`ESC =` / `ESC >`) and insert mode (`CSI 4 h/l`). Their default is the same everywhere, so stating them puts `work attach`'s real terminal right even if something left it otherwise. 12 (cursor blink), 1007 (alternate scroll) and 2031 (colour-scheme reports) are stated only if the app set them. In xterm.js, `? 12 l` turns off the page's own `cursorBlink` option, and terminals differ on 1007's default.
  5. DECSCUSR and the title (`OSC 2`, control characters removed), only if the app set them.
  6. The active screen's kitty flags as pushes, bottom first, then modifyOtherKeys (`CSI > 4 ; n m`), then any G0–G3 designation other than ASCII. Line drawing in G0 was lost (#6232), and `qqq` drew as `qqq` after a replay.
  7. The scroll region, which homes the cursor and was lost. It is stated as `CSI r` too if one was stated for the normal screen first, because a terminal that keeps a single region would otherwise carry it into the alternate screen.
  8. `CSI ? 6 h` if origin mode is on. The addon writes it after placing the cursor, and setting origin mode homes the cursor: an agent's cursor inside a scroll region was replayed at the top-left (#6233).
  9. The cursor, last and absolute (relative to the region in origin mode). The addon's relative moves landed one column short after a full row (#6165, reproduced: a full row then `\b` put the cursor on column 8 instead of 9). There is one exception. A cursor waiting to wrap after the last column can't be expressed as a position, and the addon's output already leaves it there. So no position is written for it unless something in the rehydration moved the cursor (a saved cursor, a region, origin mode); in that case it ends on the last column without the pending wrap. Pending wrap itself was not lost by the addon: on 0.14.0 a full row with nothing after it replays correctly.

§ Never 2026 (synchronized output). A snapshot with it on would hold the client's rendering until the app happened to turn it off. The addon leaves it out, and so does the rehydration (tested). zmx clears it while serializing for the same reason.

§ Each mode is stated whatever the addon wrote. One the addon already wrote is then only said twice, with the same value. xterm.js's master addon has since added `? 25 l` and the scroll region; ours come after it and state the same value, so an addon upgrade adds nothing twice.

§ The state is followed with xterm's own parser hooks on the mirror (`registerCsiHandler`, `registerEscHandler`, `onTitleChange`), each returning false so that xterm still handles the sequence. A sequence split across writes reaches them whole (tested), because xterm's parser has already joined it. There is no second escape-sequence scanner. What xterm reports itself (`terminal.modes`: DECCKM, the keypad, paste, insert, origin, wraparound, focus, the mouse protocol) is read from it when the snapshot is taken. Only what it doesn't report is tracked: the cursor's visibility, blink and shape, the title, the mouse encodings, 1007, 2031, modifyOtherKeys, the character sets, and per screen the saved cursor, the scroll region and the kitty stack.

§ The tracking follows what xterm.js 6 does, because that is the mirror's truth and the browser's.
- RIS forgets everything but the title, DECSET 12 and a hidden cursor, which xterm.js 6 keeps through RIS.
- DECSTR puts back the cursor's visibility and shape, the active screen's region and saved cursor, and the character sets. It keeps the mouse.
- A resize puts both screens' regions back to the whole screen.
- Leaving the alternate screen forgets its region (its buffer is cleared) and its kitty flags. A snapshot never carries an inactive alternate screen anyway.
- `1049 l` forgets the normal screen's saved cursor: 1049 overwrote it on the way in and restored it on the way out.
- Kitty flags are kept per screen, as the protocol requires ("separate stacks for the main and alternate screens"). Push, pop and set (`CSI > f u`, `CSI < n u`, `CSI = f ; mode u`, with modes 1, 2 and 3) work as in kitty. The depth is 8, and a push past it drops the oldest. xterm.js 6.0 ignores these sequences; they are kept for the native terminal behind `work attach`.

What a snapshot doesn't carry: the GL shift (SO/SI are C0 controls, and the parser offers no hook for them), tab stops (setting them moves the cursor, as zmx found), the pending wrap in the case above, and an inactive alternate screen's saved cursor.

## Scrollback

`core/pty/scrollback.ts` holds both values, and the SPA imports it (it is in `SPA_SHARED`). The mirror keeps `REPLAY_SCROLLBACK` = 2000 lines, and all of them are replayed. A Terminal tab keeps `VIEW_SCROLLBACK` = 5000 while it stays connected. That costs only the tab's memory and nothing at an attach, so the tab may keep more than a reattach brings back. The mirror used to keep 200 lines, so a reattach brought back 200.

Measured on a developer laptop, 200 columns × 50 rows of coloured agent output (diffs, syntax colour per word, truecolor headers, emoji), median of 7:

| Mirror scrollback | `serialize()` | `replay` frame | Mirror memory |
|---|---|---|---|
| 200 | ~2.5 ms | 50 KiB | ~3.5 MiB |
| 1000 | ~8 ms | 210 KiB | ~6.5 MiB |
| 2000 | ~17 ms | 410 KiB | ~11.5 MiB |
| 5000 | ~33 ms (52 ms worst) | 1 MiB | ~21 MiB |

2000 is the largest value whose attach stays well under ~30 ms and 1 MiB. `serialize()` runs on the host's event loop, so every other terminal waits for it. The memory is held per running session for as long as it runs, and it is about half of the above at the usual 120 columns. VS Code restores 100 lines by default (`terminal.integrated.persistentSessionScrollback`), and Superset replays 5000.

## `work attach` letting go

When `work attach` stops showing a session (Ctrl+], the agent ended, the host went away), it writes `TERMINAL_RESET` (`core/pty/terminal-reset.ts`) to your terminal. Without it, the agent's modes stayed on in the shell you returned to. The mouse sent escape codes on every click, a paste arrived wrapped in `200~` / `201~`, the keys stayed in kitty's CSI-u encoding (Superset fixes the same "keys stuck after a killed agent"), the cursor stayed hidden, or the alternate screen stayed up. The sequence is fixed rather than tracked: the client doesn't parse what it shows, and each part is harmless when the mode is already off (tested).

- Kitty: `CSI < 255 u` (more pops than any stack holds, which empties it) and then `CSI = 0 ; 1 u`, which is Superset's disarm. It is done on the alternate screen, and again on the main screen after leaving it.
- `ESC 7 CSI ? 1049 l` leaves the alternate screen. The cursor goes back to where 1049 saved it, or, already on the main screen, stays where it is.
- Then: every mouse protocol and encoding off, focus and paste off, DECCKM and the keypad normal, `CSI > 4 m`, the whole-screen scroll region inside `ESC 7` / `ESC 8` (DECSTBM homes the cursor), `CSI 0 SP q`, `? 25 h`, `ESC ( B` and `CSI 0 m`. The SGR reset comes last, because a terminal that doesn't know `CSI > 4 m` may take it for SGR 4 (underline).

## Compared with others

- **Superset / Paradev** (`headless-emulator.ts`):
  - Same stack: @xterm/headless with the serialize addon, and a "resync" that states input modes both ways ("an authoritative resync, not a diff against xterm defaults"). We do the same for modes with a universal default.
  - It follows modes with its own regex scanner over the raw output, buffering a partial sequence across chunks. We use xterm's parser hooks, which see exactly what xterm parsed.
  - It tracks no title, cursor shape, scroll region, kitty flags or cursor position, and a RIS or DECSTR in the stream doesn't reset what it tracked.
  - It loads no Unicode 11 and replays 5000 lines.
  - Its kitty disarm is what `work attach` uses.
- **zmx** (`serializeTerminalState`, over ghostty's formatter):
  - The title and DECSCUSR come after the content, because neither moves the cursor.
  - Tab stops are left out, because they move the cursor after CUP.
  - 2026 is cleared while serializing.
  - We follow all three. We also place the cursor last ourselves, because the addon's placement is wrong in the cases above.
- **VS Code** (`XtermSerializer`):
  - The mirror's Unicode version follows each client's setting. Ours is fixed at 11: our page is xterm.js with Unicode 11, and native terminals measure these emoji as 2 columns too.
  - It replays 100 lines.
  - It adds nothing after `serialize()`.
- **xterm.js master** (addon still 0.14.0):
  - The addon now writes `? 25 l` and the scroll region, the latter read from xterm's internals. It still writes no mouse encoding, cursor shape, saved cursor, character sets or kitty flags, and origin mode still comes after the cursor.
  - Kitty keyboard support is on master only, after 6.0.0, behind `vtExtensions.kittyKeyboard`, which is off by default. xterm.js 6.0 ignores the kitty sequences we replay.

## Who answers a query

An agent asks its terminal things (device attributes, the cursor position, whether a mode is on, the background colour) and waits for the answer. Before, the host passed on whatever each attached client answered: nobody answered with no client attached (Claude Code waits out its probe timeouts), and N clients answered N times. Now exactly one answers each query, decided as the output **arrives** at the host, not when anyone parses it.

- **No client attached**: the host's screen copy answers (`ScreenMirror.answerQueries`). The registry asks `now()` as each chunk arrives (`PtyRegistry.designate`); `ScreenMirror.write` marks that chunk with empty writes around it (xterm runs a write's callback after parsing it and before the next), and the answers xterm gives through `onData` while a marked chunk is parsed go to the PTY. So a chunk that arrived before a client attached is still the host's to answer when xterm parses it after the attach, and the client is not sent it (its snapshot has no query in it).
  - xterm answers: DA1, DA2, DSR 5n, CPR 6n, DECXCPR `? 6 n`, DECRQM (2026 included: the browser's xterm.js 6.0.0 answers the same), DECRQSS.
  - The host adds: OSC 10 / 11 / 12 and OSC 4 queries, which xterm.js leaves to its renderer. Answered from the last colour a client answered (`TerminalColors`, one per host process, fed every answer the host lets through), else the tab's theme (`TERMINAL_THEME`, shared with PtyView) and xterm.js's default palette, in xterm.js's `rgb:rrrr/gggg/bbbb` form. Only a colour value is ever repeated.
  - Silent, as in the browser: DA3, XTVERSION (xterm.js 6.0.0 has no handler), kitty `CSI ? u`, XTQMODKEYS, `CSI … t` window reports (windowOptions off), XTGETTCAP, OSC 52.
- **Clients attached**: the host stays silent, and one client's answers go through: the one used last (it typed or resized, `attached.lead()`: it has the PTY's size), else the first attached. Every client is still sent the query; the others' answers are dropped (`attached.replies`). Focus and mouse-motion reports go through from any client, as before, and don't count as use. A frame with typing in it goes through whole, replies and all: typing is never dropped.
- **The answerer is fixed per chunk** until the next one arrives, so its late answer still goes through. A client that becomes the one used last after a query arrived (a new tab's post-replay resize) doesn't take that query over. When the answering client detaches, the next attached takes over (it was sent the same).
- **A client drawing its replay** has the query held for it and answers once it draws it.
- The relay (`terminal-ws.ts`) and `work attach` are clients like any other: one host connection each.
- **Windows**: nothing assumes ConPTY passes every query on. Whatever reaches the host is handled the same; what ConPTY answers itself never arrives.

Left open: a query whose answering client leaves with no other attached stays unanswered (the screen copy parsed it as a client's). A double answer is possible if the answering client's reply comes after the next chunk designated another client. `CSI ? 997 ; n` colour-scheme reports are not recognised as replies, so they count as typing.

Compared: **opencode** answers every query in its daemon and drops what its client terminal answers. **Superset** v1 always answers in its headless emulator, and drops the renderer's answers only until the shell is ready (two answers after that); v2 has the renderer send its theme (`colors` frame) for the host to answer colour queries. **tmux** is itself the terminal: it answers everything and never forwards a client's answer.

## Terminal identity

What Claude Code (2.1.330, its bundled JS) reads to decide how to draw:

- **Colour depth**: `TERM_PROGRAM` first (iTerm.app, ghostty, WezTerm → 24-bit; Apple_Terminal → 256), then `COLORTERM === "truecolor" || "24bit"`, then `TERM` starting `xterm-256` → 256. The host now sets `COLORTERM=truecolor` when the environment has none (`terminalEnv`, `pty-session.ts`): xterm.js draws 24-bit, and without it Claude drew its theme in 256 colours and suggested "Set COLORTERM=truecolor".
- **Rendering profile** (`LS`): from the XTVERSION reply when there is one, else `TERM`, the multiplexer, then the terminal's name (`TERM_PROGRAM` verbatim, or `WT_SESSION` → windows-terminal …). The profile sets the widths it assumes (unless it measured them at startup, by CPR, which the host now answers), erase/insert behaviour and cursor resync.
- **Wheel**: `TERM_PROGRAM=vscode` (some versions) or an XTVERSION name starting `xterm.js` turns on its xterm.js wheel tuning (`wheelFlood`); otherwise the native-terminal curve.

Left as is, and why:

- **XTVERSION**: not answered. Answering `xterm.js(…)` would switch on the wheel tuning and change the profile for every session at once. Superset answers `Paradev (xterm.js)` only because it ships a wheel handler that sends what native terminals send. Measure Claude's scrolling in the tab with and without it before choosing.
- **TERM_PROGRAM and the other identity variables**: inherited from the terminal that started the host (`WT_SESSION` on purpose, so `work tree --host` matches in Windows Terminal). Right for that native view, wrong for the tab: a host started from Ghostty tells Claude it draws into Ghostty (profile `ghostty`) while xterm.js draws. Options: drop them for sessions the dashboard starts, or set `TERM_PROGRAM=xterm.js` there (Claude's `xtermjs` profile).

## Flow control and coalescing

Output used to go to every client chunk by chunk, as fast as the agent wrote it. A tab that drew slower than that (a flood, a background tab) queued megabytes in xterm.js (it throws past 50 MB), and the host sent a WebSocket frame per node-pty read. Now one module sits between the PTY's output and its clients: `core/pty/output-pacer.ts` (pure, timers injected), one per registry entry. The shared numbers and the client side are in `core/pty/flow-control.ts` (pure, import-free; the SPA imports it).

**Coalescing.** The first output after a quiet moment goes out at once, so a keystroke's echo waits for nothing. Whatever arrives within the next `COALESCE_MS` (5) goes out as one frame, up to `MAX_FRAME_CHARS` (64 KiB). A single chunk bigger than that goes alone. The mirror is still written chunk by chunk (PtySession, before the registry sees it), and the window stays open while output keeps coming. A synchronized frame (DEC 2026) is not coalesced this way: it is held whole (see "Synchronized output").

**Acks.** A client that acks says so with `?flow=1` on its attach address (`withFlow`). It sends `{ type: 'ack', chars }` every `ACK_EVERY` (5 000) characters it has finished drawing. The browser counts in `term.write`'s callback, `work attach` in `process.stdout.write`'s. The unit is the host's: UTF-16 code units, the length of the string it sent. A client receives UTF-8 and counts it with `utf16Length` without decoding: one per sequence, two for a 4-byte one, and the counts still add up when a frame is cut inside a sequence. A screen (a replay frame) is never counted or acked.

**Per client**, the pacer counts what it sent and what was acked (an ack never pays for more than was sent):

- **The holder**: the client the registry picks (`pick`: the one used last, else the first attached, among those sent live output). It is the same rule as the answerer's. If it acks and the PTY can pause, the PTY is paused once its unacked count is above `HIGH_WATERMARK` (100 000) and read again once it is below `LOW_WATERMARK` (5 000). This is VS Code's flow control, for one client.
- **Any other metered client** above `HIGH_WATERMARK`, and the holder once its pause passes `PAUSE_TIMEOUT_MS` (500 ms), is **behind**. It is sent no live output. Once its acks bring it under `LOW_WATERMARK`, at most every `CATCH_UP_MIN_MS` (500 ms, since each snapshot runs on the host's loop), it is sent the screen as it stands then (`resync`: a settled snapshot, output held meanwhile, as at attach) and goes live again. A holder that timed out doesn't pause the PTY again until it is used (types or resizes).
- **A client that doesn't ack** (an older one, or no `?flow=1`) is sent everything, as before, and never pauses anything.

§ An agent never waits for a view that isn't the holder, nor for the holder longer than `PAUSE_TIMEOUT_MS` at a time. 500 ms was measured, not guessed. A background tab parses in timer slices that run once a second, so it released each pause at its next tick and never reached a 2 s limit. The stress run below took 159 s for 20 MB that way; with 500 ms it took 2 s, with one pause and two catch-up screens.

§ No pause outlives its reason. The pause is released when the holder detaches, when another client becomes the holder, and when the process ends (`end()`), restarts or halts (`setFlow(null)`, flushed first). It is also released when the entry is killed or removed (`dispose`). `PtySession.dispose` reads again before it kills, because a paused PTY's end waits for its output to be read.

§ A pause never costs the agent's last output. On Unix, node-pty (1.1.0, `unixTerminal.ts`, `onexit`) waits for the PTY's socket to close once the child has exited. If it hasn't closed, node-pty destroys it after `DESTROY_SOCKET_TIMEOUT_MS` (200 ms) and drops whatever was unread.
- **Linux**: a child exits with its last output still in the PTY's buffer (a small write doesn't block it). So a pause still in place 200 ms after the exit lost all of it. Measured: 2 000 characters, paused and released at 600 ms, arrived as none.
- **macOS**: the child's exit waits for its output to be read, so nothing is lost there.

`PtySession` hooks the moment node-pty starts that wait (`onChildExit`: its `once('close')`, which `onexit` calls right after setting the timer). From then on it reads, and it never pauses again. A shorter `PAUSE_TIMEOUT_MS` was the other way. But a timer under 200 ms is still at the mercy of a busy event loop (snapshots run on it), and it would have to count from an exit the pacer doesn't see. One test reads node-pty's source, so an upgrade that changes `onexit` fails it. A real-PTY test checks that the tail arrives; it passes on macOS and Linux, and without the hook it fails on Linux.

§ A client behind when the agent exits is never left on a stale screen. `pacer.end()` sends what was pending to the live clients, releases the pause, and sends every client still behind the final screen at once, whatever `CATCH_UP_MIN_MS` says. The registry holds that client's exit while its screen is being taken, and tells it after the screen and the output held meanwhile. So the `exit` frame, which closes the socket, never overtakes the screen (tested).

§ Who answers a query is still decided as the output **arrives** (`designate`, before the pacer sees the chunk). A frame may go out up to 5 ms later, after another client became the one used last, and the query is still the first one's (tested). The set of clients a frame goes to is fixed when it goes: a client that joins, falls behind or catches up has what was pending sent first. So a frame is never sent twice, nor to a client whose snapshot has it. A client falls behind only right after a whole frame went to it, and `pick` skips one that is behind. A query is therefore never designated to a client that won't be sent it.

**Windows.** The PTY is never paused there (`canPauseOutput`). node-pty reads ConPTY's output through a worker thread so that `ClosePseudoConsole`, which before Windows 11 24H2 waits for that output to be drained, can't block the host. If reading were paused, nothing would drain it, and killing the agent could hang the whole host. There a holder too far behind falls behind like any other client, so the agent is never paused for it. Pausing on Windows waits on a check on 24H2 and with the bundled ConPTY.

**A replay mid-session** (a client caught up) must redraw and nothing else:

- **The browser** (`PtyView`) resizes to the snapshot's grid. It writes `ESC c` (RIS: in order with what was queued before it; it clears the scrollback too) followed by the screen, and stays at that grid, the PTY's (see "Resizing and attaching at a size"). It takes no focus, sends no size (that would take the PTY's size from the terminal in use), holds no input and leaves the phase alone.
- **`work attach`** (`commands/shared/attach-output.ts`) asks for screen-only catch-ups (`withFlow(…, { screenOnly: true })`, `?catchup=screen`). Its mid-session screen is the visible screen without the scrollback (`snapshot({ scrollback: false })`), so a catch-up adds nothing to your terminal's history. The saved cursor and the scroll region are positions on the screen (the saved cursor's buffer line less `baseY`), so they come out the same without the scrollback (round-trip tests, over a fresh terminal and over one with history in it). Every screen is drawn over a cleared screen (`CLEAR_SCREEN`), never `CSI 3 J`, so your shell's history from before the attach is kept. The first screen still carries the session's scrollback.

The browser also bounds each `term.write` at `WRITE_PIECE` (64 KiB). xterm.js parses one write whole before it looks at the clock, so a big frame or screen written at once is one long freeze. The keystroke-latency meter still marks the echo as the frame arrives.

**Offsets.** Each frame ends at an offset: the characters of output since the entry was spawned (restarts keep counting), `pacer.offset`. `attach` returns the offset its snapshot stands at. Nothing uses them on the wire yet: they are for a reconnecting client to ask for only what it missed.

**Negotiation and compatibility.** There is no protocol version bump and no `HOST_FEATURES` entry, because no client needs to know whether the host paces. An older host ignores the parameter and the `ack` frames (unknown types are dropped), so a new client behaves as before. An older client sends neither, so the host sends it everything, unpaced. The relay (`terminal-ws.ts`) passes `?flow=1` on to the host and the acks through as they are. A mid-session replay only ever goes to a client that asked for flow. `work attach` also sends `catchup=screen` (`CATCH_UP_PARAM`), which an older host ignores like `flow=1`. Its catch-up then carries the scrollback, drawn into your history again: a duplicate, nothing lost, nothing erased.

**Stress** (20 MB of coloured lines from a real PtySession through the host to an `@xterm/headless` client acking in its write callbacks, in one process):

- **Acking client, keeping up**: peak unacked about 136 000, under HIGH plus one frame. 39 to 80 pauses and as many resumes. 1.1 to 2.1 s, the same as unpaced within noise.
- **Acking once a second**: one pause, then two catch-up screens, 2 s.

Every run's final screen equals the unpaced one and the host mirror's.

**Compared:**

- **VS Code**: the same numbers and unit (`FlowControlConstants`, `CharCountAckSize`), with one client per PTY and no timeout: a renderer that stops acking stops the PTY. Its `TerminalDataBufferer` flushes 5 ms after the first event with no leading edge, so every echo waits 5 ms. We send the first chunk at once.
- **ttyd**: counts bytes, pauses above a pending-callback count (one callback per 100 KB written), and resumes when the browser's callbacks drain. Also one client, no timeout. **Tabby**: a pending-callback count, 128 KiB per callback.
- **opencode**: its writer coalesces consecutive chunks and waits for each write's done callback before the next. That is pacing within one client, not between several.

We have several clients on one PTY, some of them unwatched, hence the holder, the time-out and the fresh screen instead of a queue.

Whole synchronized-output frames (`HOLD 2026`) are in the pacer now: see "Synchronized output".

## Resizing and attaching at a size

`core/pty/terminal-size.ts` holds the rules: a grid is whole numbers, 2..1000 columns and 2..500 rows (`validGrid`), and it is stated on an attach address as `?cols=…&rows=…` (`withGrid`, `gridFromParams`). It is pure and import-free, and the SPA imports it (`SPA_SHARED`).

§ **The Terminal tab's grid and the PTY's change together.** `applyGrid` in `PtyView` measures the pane, resizes xterm.js and sends the `resize` frame in one go. Nothing else resizes the tab's terminal to a size of its own. A terminal fitted alone reflows the agent's last frame, which was drawn for the PTY's grid, into garbage until the agent repaints. That is what a drag used to look like.

- **Rate.** A drag fires the pane's ResizeObserver every frame, and each grid change makes the agent repaint its whole screen. `FitScheduler` (`web/src/state/fit-scheduler.ts`) runs a fit at most once per `FIT_MIN_MS` = 50 ms: the first of a burst at once, the rest as one at the end of the window. That last fit measures the pane as it is then, so the final size always lands. Others do the same. Tabby caps its reflows at one per frame with a 32 ms floor, for its own renderer. Theia waits 50 ms before it resizes the terminal and its process. Codex waits 75 ms before it reflows. Here each fit costs a repaint that comes back over the host and a WebSocket (an echo takes 6–18 ms), so 50 ms lets one land before the next size goes and still follows a drag.
- **The blank frame.** It is real when the fit runs inside the ResizeObserver callback. That callback runs after the frame's animation callbacks and right before its paint. The WebGL renderer clears its canvas on a resize (setting `canvas.width` clears it) and draws it again only in the next frame's animation callback. Measured with xterm.js 6.0 and addon-webgl 0.19 in Chromium: one blank frame per fit. So every fit runs in a task of its own (a timer), never inside the callback, and the renderer's draw then comes before the next paint. No private API is used: `_renderService` is not touched.
- **No size, no fit.** A pane with no width or height (not laid out yet, a collapsed panel), or one FitAddon makes no grid of (it proposes 2 × 1 for an empty pane), changes nothing. coder skips a fit the same way. When the pane gets a size, the observer fits it.
- **Hidden.** A tab hidden in the deck keeps its grid and sends nothing. The PTY's size belongs to the terminal in use. Shown or focused, it takes the size again, sent even when unchanged (another window may have resized the PTY since).
- **Scroll position.** When you have scrolled up, a marker on the line at the top of the view follows it through the reflow, and the view is put back on it. When the view was at the bottom, it stays there.
- **A catch-up screen** (output-pacer.ts) stays at the snapshot's grid, the PTY's. Only if the pane's own grid changed since this tab last told the PTY are both changed, through the same scheduler.

**Attaching at a size.** A client that takes the PTY's size anyway states its grid on its attach address: the Terminal tab when shown, and `work attach`. A tab hidden in the deck never states one. `registry.attach` (`AttachOptions.grid`) then does these steps before it takes the snapshot:

- makes the client the one used last (`leader`, `pacer.used`), as its first resize would have;
- resizes the PTY and the mirror to that grid (`resize`; mid-restart only the entry's grid, which the new process starts at).

So the snapshot is at the client's grid:

- **The mirror** reflows to it in order with the output before it: once that output is parsed, at the grid it was drawn for (`ScreenMirror.resize`), and the settled snapshot is taken behind both.
- **The agent's repaint** (its SIGWINCH answer) arrives after the attach. Like any output after the attach, it is held for this client until `start()` and then sent as live output. Nothing is lost or doubled: what came before is in the snapshot, and what came after is in the held output, once (`ParsingPty`-style tests in `pty-registry.test.ts` and `pty-host.test.ts`).

The client draws the snapshot at its own grid: there is no second reflow and no repaint after the fact.

The grid also goes:

- to the ticket request (`POST /api/terminals/:id/ticket` takes `cols` and `rows`);
- through the relay (`terminal-ws.ts` passes the parameters on and gives them to `ensurePty`).

**Compatibility.** The parameters are additive. There is no protocol bump and no `HOST_FEATURES` entry.

- **An older host** ignores them. The tab's resize after the replay, sent as before, then does it the old way.
- **`work attach`** used to nudge the size a row and back after every replay. Now it sends one resize, and only when the replay's grid isn't its terminal's (an older host).
- **An invalid grid** is ignored everywhere: the host, the relay and the ticket route.
- **The replay frame** says which grid it was drawn for, as before.

**The grid an agent starts at** (`registry.spawn`):

| Start | Before | Now |
|---|---|---|
| A tab's (a ticket or the relay) | 120 × 32 | The tab's grid |
| `work attach` | Its terminal's | Its terminal's |
| One with no tab (started in the background) | 120 × 32 | The last grid a client set in this host, else 120 × 32 |
| A restore | 120 × 32 | The grid it had when last used |

Each restore-list entry keeps its grid (`persist` writes `cols` and `rows`, which `PersistedPty` allowed already). A client's change is written `GRID_PERSIST_MS` = 1 s after the last change. A list from an older host has no grid, so its restore starts at 120 × 32. After a restore and before any client sets a grid, a start with none takes the grid most restored sessions had.

**Redraw** (⋯ → Reconnect terminal only, never on a normal attach). After the new connection's replay, the tab sends `{ type: 'redraw' }`, then any input it held. `registry.redraw` makes the PTY one row smaller (a row bigger at the minimum). After `REDRAW_JIGGLE_MS` = 100 ms it puts the PTY back to the grid it has then. The clients aren't resized: the agent's repaint at the smaller grid is drawn over by the one at theirs. It works the same on every platform.

- **Why not SIGWINCH to the foreground process group.** A same-size SIGWINCH repaints nothing in a Node or Bun agent (Claude Code is a Bun binary): they emit `'resize'` only when the size they read has changed. Measured with node-pty 1.1, Node 24 and Bun 1.3: two resizes back to back gave two SIGWINCHes and no `'resize'`, and 30 ms apart gave both. node-pty also exposes no `TIOCGPGRP`.
- **Why not a one-row jiggle with no pause on Windows.** ConPTY sends nothing for an unchanged size.

An older host drops the frame.

**ConPTY.** When the host runs on Windows, it passes `windowsPty` (`{ backend: 'conpty', buildNumber }` from `os.release()`, as VS Code's `getWindowsPty` does) to:

- its mirror (`ScreenMirror`'s option, set by `PtySession`);
- every replay frame. The tab sets it on its xterm.js.

The build follows the ConPTY each PTY actually runs on (`conptyFor`, `pty-session.ts`). With the bundled one (`useBundledConpty`: node-pty 1.1.0's `third_party/conpty/1.23.251008001`, Windows Terminal 1.23), it is at least `CONPTY_REFLOW_BUILD` (21376) whatever the OS build, because that ConPTY reflows; Tabby reports 21376 the same way. `PtySession.windowsPty` says it for that PTY and the registry sends it over the host's (`PtyLike.windowsPty`). A registry with no `windowsPty` (not on Windows) sends none.

xterm.js 6 then reflows lines on a resize only from build 21376, where ConPTY reflows them too. Below that build it turns on its wrapping heuristics. On a grow, it adds rows at the bottom instead of pulling lines back from the scrollback, because ConPTY reprints its view. Without this, a resize drew ConPTY's reflow over xterm.js's own.

The registry sets none by default. The host passes it (`startPtyHost`), so a test's registry says the same on every CI platform.

Untested on a real Windows machine:

- the reflow with `windowsPty` set;
- the jiggle under ConPTY;
- the build read from `os.release()`.

Left open:

- **Older resize frames.** A `resize` frame from an older client is bounded only by the registry's `validGrid`.
- **Clients that don't lead aren't told.** They are not told that the PTY's grid changed. They find out from the next catch-up screen.
- **The bundled ConPTY on a real Windows machine.** That it reflows as 21376 is from its version and Tabby's choice, not seen here.


## Synchronized output

An agent wraps each repaint in `CSI ? 2026 h` … `CSI ? 2026 l` (BSU … ESU) so that the terminal shows whole frames. Claude Code does it for every frame.

**What xterm.js 6.0.0 does with it.** While a frame is open, it keeps the rows to refresh and draws none. At the next animation frame it draws only if no frame is open then. Its 1 s safety timeout starts at a BSU and is cleared at the ESU. So a frame that reaches it in two writes is drawn only if no animation frame falls between them. A stream in which every write ends mid-frame is never drawn: each frame ends within the second, so the timeout never runs out, and every animation frame finds a frame open (xterm.js #6071).

**Measured** in Chromium (Playwright's Chrome for Testing, Metal GPU, M3 Pro), with xterm.js 6.0.0 and addon-webgl 0.19.0 set up as `PtyView` sets them up. A page counts `onRender` rows: a paint is whole when every row shows the same frame, torn otherwise. Frames were 200×50 and about 30 KiB. The scripts are not in the repo (a manual check, not a CI test).

- **The real stream.** A fake agent wrote one frame per `write` at 60 and 30 fps through a real PTY (node-pty, macOS). The PTY delivers it in 1 KiB reads. A 30 KiB frame arrives whole within 0.4 ms (median) to 5 ms (max). 400 KiB takes 6 to 8 ms, 1.5 MiB 21 to 26 ms.
- **The old pacer split every frame.** That stream was replayed through the old and the new pacer in virtual time, and what each sent was replayed into the page at the same times, in `WRITE_PIECE` writes. The old pacer sends the first read of a quiet moment at once. So every frame went out as two messages, 1 KiB and then the rest: 361 messages for 180 frames, 181 of them ending mid-frame.

| What the tab got (60 fps agent) | DOM renderer | WebGL renderer |
|---|---|---|
| Old pacer, markers kept | 59.6 whole frames/s | 3.7 whole frames/s, gaps up to 532 ms |
| New pacer, markers kept | 60.3/s, 0 torn | 60.1/s, 0 torn |
| New pacer, markers stripped | 60.1/s, 0 torn | 60.1/s, 0 torn |
| Old pacer, markers stripped | 169 torn paints in 3 s | 174 torn paints in 3 s |

At 30 fps all of them drew 30 whole frames/s, except stripped markers on the old pacer: about 90 torn paints in 3 s.

Synthetic streams (frames sent from the page itself):

- **Each frame in 3 writes 2 ms apart**, markers kept: 7 to 21 whole frames/s at 30 fps, and 1.5 to 1.8/s at 60 fps, with 1 to 1.5 s gaps. 0 torn.
- **Every write ending mid-frame**: no frame drawn, one paint every 5 s or so, both renderers.
- **One write per frame**, markers or not: 23 to 38 whole frames/s on DOM, 0 torn. So did 100 KiB and 300 KiB frames on WebGL. Without markers they were also 0 torn, because xterm.js parses a write whole and draws after it.
- **Without markers, each frame in pieces**: 100 to 230 torn paints in 4 s.

**Parse rate**: 18 to 34 ms per MiB once warm, so a 64 KiB piece takes 1.2 to 2 ms. The first 16 KiB after the page loaded took 46 to 161 ms (JIT warm-up). xterm.js checks its 12 ms slice only between writes. So a frame with no markers is drawn whole up to about 350 to 650 KiB in the pieces of one message, and less when the page is cold. Past that only the markers keep it whole.

**What was seen before.** Each of these follows from the code and the replay above.

- **A frame split by the coalescing.** Every frame was split. A WebGL tab drew about 4 frames a second, with half-second stalls, while the agent animated at 60.
- **A pause, or a client falling behind, mid-frame.** The half sent was held by the tab until the rest came, for up to `PAUSE_TIMEOUT_MS`.
- **A catch-up or an attach mid-frame.** The screen was taken from the mirror as it stood: the top of the new frame over the bottom of the old one. A snapshot carries no 2026, and a catch-up starts with RIS, which ends the tab's frame. So the rest of the frame was drawn as it came, torn.

**What the host does.**

- **`core/pty/sync-output.ts`** follows only the set and the reset of 2026, as the output arrives. It also sees them among other modes (`CSI ? 2026 ; 25 h`) and when a read cuts one. A second set inside a frame changes nothing, a reset with no frame open is nothing, and RIS ends a frame, as each does in xterm.js. It doesn't use the mirror's parser, which is asynchronous.
- **`PtySession`** cuts its output just past each frame end (`cutAtFrameEnds`). For each piece, it writes the mirror at once and then hands the piece on. The answerer of a query is still designated as the output arrives (see "Who answers a query").
- **The pacer** holds a frame from its BSU to its ESU, with whatever was pending before it, and sends it as one message. It is not split by `COALESCE_MS` or `MAX_FRAME_CHARS`. Pausing and falling behind are decided only between frames: `deliver` runs once per whole frame, and `evaluate` never pauses while a frame is held.
- **`FRAME_HOLD_MS` = 200** is the time cap. That is 8 times the slowest arrival measured (1.5 MiB in 26 ms), well under xterm.js's own 1 s, and alacritty and zellij use 150 ms. A frame that doesn't end in time is let go, and the rest of it flows as ordinary output. The tab still holds it by its markers.
- **`FRAME_HOLD_MAX_CHARS` = 1 MiB** is the size cap. It bounds memory per PTY. A full repaint of a large screen in true colour is a few hundred KiB, and 1 MiB parses in about 20 to 35 ms.
- **Snapshots are taken only between frames.** An attach joins at the frame's end (`pacer.whenNoFrame`), and so does a catch-up that falls due mid-frame. Both are bounded by the caps. Because PtySession cuts there, the settled snapshot is exactly what came before. A client joining mid-frame gets none of it, and the rest of the frame goes to the others first (`add`). When the process ends, restarts or the host stops, a held frame is sent first.
- **The markers are kept for every client.** The measurements gave no reason to strip them for xterm.js. Once frames arrive whole, kept and stripped both draw at the agent's rate. Kept, they still protect a frame that a cap let go, or one that takes longer than a parse slice. Native terminals (`work attach`) keep them too.

**Scroll after a repaint.** Claude Code reprints its whole transcript after a resize or a toggle: `CSI 2 J`, `CSI 3 J`, then every line, inside one frame. In xterm.js 6 (measured in the same Chromium, with or without 2026, and split into 4 writes), a view at the bottom stays at the bottom and follows. A view scrolled up 50 lines lands at line 0 of the new scrollback and stops following. Before, the top of the view showed "line 221"; after, "line 0".

`state/repaint-scroll.ts` fixes it with xterm's public parser hooks. Its handlers run before xterm's and fall through (`return false`), so the view is noted before anything is cleared. It is put right at the frame's ESU, or, with no frame, once the write the clear came in is parsed:

- **at the bottom**: kept at the bottom (`scrollToBottom`, as Wave Terminal does);
- **scrolled up**: the same text stays at the top of the view. The view's top 3 lines are looked for in the reprint, starting from the same distance from the bottom and going out from there. If they are not found, that distance alone is used. It stays scrolled up and doesn't follow.

Measured with the fix, "line 221" stayed at the top in every case, including a reprint 20 lines shorter. A cleared screen alone (`2 J`), the alternate screen and a reset move nothing.

Left open:

- **8-bit CSI** (`0x9b`) is not recognised by the scanner. Agents write the 7-bit form.
- **A frame let go by a cap** reaches the tab split, as every frame did before, and so draws at the rate measured above. Upstream #6071 is still open.
- **A repaint with no 2026** that spans several writes is put right at the end of its first write. A scrolled-up view can then land on the distance from the bottom instead of the text.
- **Not seen on Windows**: ConPTY's read sizes, and so the arrival spans there.
