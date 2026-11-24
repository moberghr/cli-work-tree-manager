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
- **Clients attached**: the host stays silent, and one client's answers go through: the one used last (it typed or resized, `attached.lead()`: it has the PTY's size), else the first attached. Every client is still sent the query; the others' answers are dropped (`attached.replies`). Focus and mouse-motion reports go through from any client, as before, and don't count as use. What a client sent on its own is told from typing by `replyParts` (`core/pty/terminal-replies.ts`: the replies a frame is made of, or null when anything in it is typing); A frame with typing in it goes through whole, replies and all: typing is never dropped.
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
- **Any other metered client** above `HIGH_WATERMARK`, and the holder once its pause passes `PAUSE_TIMEOUT_MS` (500 ms), is **behind**. It is sent no live output. Once its acks bring it under `LOW_WATERMARK`, at most every `CATCH_UP_MIN_MS` (500 ms, since each snapshot runs on the host's loop), it is **caught up** (`resync`) and goes live again:
  - **From the tail** when it may be: what it missed since the offset it was sent output up to, as a `replay` with `resumed: true` (see "Catching up from the tail" below). No reset: the tab keeps its own scrollback.
  - **Else a screen**, as it stands then (a settled snapshot, output held meanwhile, as at attach).

  A holder that timed out doesn't pause the PTY again until it is used (types or resizes).
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

**Catching up from the tail.** The pacer knows the offset up to which it sent a client output (`at`: its attach's, each frame's end, a catch-up's). That output is in order on its socket and will be drawn, so the client's screen will stand there. When it catches up, the registry (`resync(from)`) sends it what came since from the output tail (`continueFrom`, `core/pty/output-tail.ts`, see "Reattach where you left off"), when that is provably all it needs. The checks are a resume's, less the stream and the grid (it draws the output where it would have drawn it live):

- **`busy`**: the agent exited, is restarting or halted, or a redraw is changing the grid.
- **`resized`**: the PTY's grid changed after that offset (the mirror reflowed and the agent repainted meanwhile).
- **`too-old`**: what it missed is no longer all in the tail. **`split`**: the offset is inside a surrogate pair.
- **A frame open**: the catch-up already waits for its end (`whenNoFrame`), so what it missed never ends inside one.

Any doubt is a screen, as before. So is every catch-up of `work attach` (`catchup=screen`: it draws each over a cleared screen), and of a client whose output is still held for a screen being taken.

§ What it missed is not counted against its flow, as a screen isn't: it doesn't go through the pacer, and the tab doesn't ack it (`drawMissed`, as a resume). The client's position moves to the replay's offset (`StreamPosition.replay`), and live output and acks go on from there. Its queries were answered when they came: a client that is behind is never picked to answer (`pick` skips it), and the tab drops what it answers while it draws missed output (`quiet`).

§ No loop, bounded memory. Uncounted output could otherwise keep a slow client behind forever, sent everything at its own slow pace:

- **At most a tail's worth** (`RESUME_TAIL_CHARS`, 256 Ki characters) per catch-up, and **one per `CATCH_UP_MIN_MS`** per client.
- **Only to a client that has just drawn what it was sent** (its acks brought it under `LOW_WATERMARK`), so nothing of the previous catch-up is still queued in it.
- **Behind again before it drew past it**: a client caught up from the tail that falls behind again before it acked anything sent after (`continuedAt`, `screenNext`) is slower than the output. Its next catch-up is a screen, which skips to where the output stands.

So a client's queue holds at most the tail plus `HIGH_WATERMARK` plus one frame. That is about what a catch-up screen of `REPLAY_SCROLLBACK` already put there (~410 KiB at 200 columns). The host holds no more for it than the tail it keeps anyway and the one string sent; no snapshot is taken. A tail catch-up that falls behind again alternates with screens at worst.

§ Why: with two tabs on one session, the tab that fell behind during a burst used to be sent a screen. The reset (RIS) before it threw away the tab's own scrollback (`VIEW_SCROLLBACK`, 5 000 lines) for the mirror's 2 000. Benchmark (`burst-second-tab-history`: two headless tabs, the agent prints 3 000 coloured lines, 218 000 characters, at once; 5 runs):

| | Base (`e2b36c31`, no pacer) | Screen catch-up | Tail catch-up |
|---|---|---|---|
| History lines the second tab keeps | 3 000 | 2 019 | 3 000 |
| Its buffer equals the first tab's | 5/5 | 0/5 | 5/5 |

**A screen mid-session** (a client caught up with one) must redraw and nothing else:

- **The browser** (`PtyView`) resizes to the snapshot's grid. It writes `ESC c` (RIS: in order with what was queued before it; it clears the scrollback too) followed by the screen, and stays at that grid, the PTY's (see "Resizing and attaching at a size"). It takes no focus, sends no size (that would take the PTY's size from the terminal in use), holds no input and leaves the phase alone.
- **`work attach`** (`commands/shared/attach-output.ts`) asks for screen-only catch-ups (`withFlow(…, { screenOnly: true })`, `?catchup=screen`). Its mid-session screen is the visible screen without the scrollback (`snapshot({ scrollback: false })`), so a catch-up adds nothing to your terminal's history. The saved cursor and the scroll region are positions on the screen (the saved cursor's buffer line less `baseY`), so they come out the same without the scrollback (round-trip tests, over a fresh terminal and over one with history in it). Every screen is drawn over a cleared screen (`CLEAR_SCREEN`), never `CSI 3 J`, so your shell's history from before the attach is kept. The first screen still carries the session's scrollback.

**A screen that can't be taken.** `ScreenMirror.snapshot()` gives `null` (logged, `logSwallowed`), never `''`: an empty screen would be drawn by a client over the one it has, blank. What the registry does (`pty-registry.ts`):

- **A first attach** attaches all the same, on an empty screen the agent's next repaint fills, and reports it (`report('warn', …)`). A terminal that got no first frame would take no input.
- **A catch-up** (a client that fell behind, caught up) sends a frame that changes nothing, `data: ''`, `stream: ''`, `resumed: true`, and reports it. The tab keeps its screen, draws nothing and no longer knows where it stands (no stream), so it never resumes from there. It missed output meanwhile.
- **`work attach`** (`screenOnlyCatchUp`) is sent nothing: it draws every screen over a cleared one and never resumes.

The browser also bounds each `term.write` at `WRITE_PIECE` (64 KiB). xterm.js parses one write whole before it looks at the clock, so a big frame or screen written at once is one long freeze. The keystroke-latency meter still marks the echo as the frame arrives.

**Offsets.** Each frame ends at an offset: the characters of output since the entry was spawned (restarts keep counting), `pacer.offset`. A frame cut at `MAX_FRAME_CHARS` ends where the chunk that didn't fit starts, though the tail already has that chunk (tested): a catch-up from the tail continues from a frame's end. `attach` returns the offset its snapshot stands at. Every `replay` frame carries it (`offset`, with the stream's id), and a reconnecting tab asks for what it missed from its own: see "Reattach where you left off".

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

- **Resize frames.** The host runs `validGrid` on a `resize` frame before the connection's size is taken or it becomes the one used last (`pty-host.ts`): an invalid grid is dropped whole, and it can no more lead than resize. The registry checks it again.
- **Clients that don't lead aren't told.** They are not told that the PTY's grid changed. They find out from the next catch-up screen.
- **The bundled ConPTY on a real Windows machine.** That it reflows as 21376 is from its version and Tabby's choice, not seen here.


## Synchronized output

An agent wraps each repaint in `CSI ? 2026 h` … `CSI ? 2026 l` (BSU … ESU) so that the terminal shows whole frames. Claude Code does it for every frame.

**What xterm.js 6.0.0 does with it.** While a frame is open, it keeps the rows to refresh and draws none. At the next animation frame it draws only if no frame is open then. Its 1 s safety timeout starts at a BSU and is cleared at the ESU. So a frame that reaches it in two writes is drawn only if no animation frame falls between them. A stream in which every write ends mid-frame is never drawn: each frame ends within the second, so the timeout never runs out, and every animation frame finds a frame open (xterm.js #6071).

**Measured** in Chromium (Playwright's Chrome for Testing, Metal GPU, M3 Pro), with xterm.js 6.0.0 and addon-webgl 0.19.0 set up as `PtyView` sets them up. A page counts `onRender` rows: a paint is whole when every row shows the same frame, torn otherwise. Frames were 200×50 and about 30 KiB. The scripts are not in the repo (a manual check, not a CI test).

- **The real stream.** A fake agent wrote one frame per `write` at 60 and 30 fps through a real PTY (node-pty, macOS). The PTY delivers it in 1 KiB reads. A 30 KiB frame arrives whole within 0.4 ms (median) to 5 ms (max). 400 KiB takes 6 to 8 ms, 1.5 MiB 21 to 26 ms.
- **The old pacer split every frame.** The "old pacer" is this branch's earlier one (see "What before means here", below the table). That stream was replayed through the old and the new pacer in virtual time, and what each sent was replayed into the page at the same times, in `WRITE_PIECE` writes. The old pacer sends the first read of a quiet moment at once. So every frame went out as two messages, 1 KiB and then the rest: 361 messages for 180 frames, 181 of them ending mid-frame.

| What the tab got (60 fps agent) | DOM renderer | WebGL renderer |
|---|---|---|
| Old pacer, markers kept | 59.6 whole frames/s | 3.7 whole frames/s, gaps up to 532 ms |
| New pacer, markers kept | 60.3/s, 0 torn | 60.1/s, 0 torn |
| New pacer, markers stripped | 60.1/s, 0 torn | 60.1/s, 0 torn |
| Old pacer, markers stripped | 169 torn paints in 3 s | 174 torn paints in 3 s |

At 30 fps all of them drew 30 whole frames/s, except stripped markers on the old pacer: about 90 torn paints in 3 s.

§ **What "before" means here.** The "old pacer" is this branch's own earlier pacer (the coalescing one, which sent a frame's first read alone and so split every frame across writes), not the base. 3.7 whole frames/s is that pacer's figure, and the gain over it is a fix of this branch's own regression. Against the base commit (`e2b36c31`: no pacer, each read sent as it came) a fast machine already drew about 60 whole frames/s: benchmark, base → this branch, 59 → 60 whole frames/s, longest gap 34 → 20 ms. The gain over the base is the gap, not the rate.

Synthetic streams (frames sent from the page itself):

- **Each frame in 3 writes 2 ms apart**, markers kept: 7 to 21 whole frames/s at 30 fps, and 1.5 to 1.8/s at 60 fps, with 1 to 1.5 s gaps. 0 torn.
- **Every write ending mid-frame**: no frame drawn, one paint every 5 s or so, both renderers.
- **One write per frame**, markers or not: 23 to 38 whole frames/s on DOM, 0 torn. So did 100 KiB and 300 KiB frames on WebGL. Without markers they were also 0 torn, because xterm.js parses a write whole and draws after it.
- **Without markers, each frame in pieces**: 100 to 230 torn paints in 4 s.

**Frames bigger than `WRITE_PIECE`, in the real app** (work web, the PTY host, a stand-in agent writing one synchronized frame per write at 60 fps, every cell in true colour, Chrome for Testing headless with Metal, M3 Pro; 159 × 49; a scratch check, not in the repo). The tab writes such a frame in 64 KiB pieces, all in the same task, so xterm.js parses them in one go and the frame is whole before the next animation frame:

| Frame | Writes per frame | WebGL | Same, written unsplit | DOM |
|---|---|---|---|---|
| 136 KB | 3 | 56 whole frames/s, 0 torn, longest gap 33 ms | 55.8/s, 0 torn, 35 ms | 20/s, 0 torn, 99 ms |
| 486 KB | 8 | 56/s, 0 torn, 40 ms | 55.8/s, 0 torn, 38 ms | — |

At 30 fps every WebGL run drew 29 to 29.1/s. 12 screenshots taken during each run, with alternate frames on red and blue backgrounds, showed no half-drawn frame. So splitting a write at `WRITE_PIECE` doesn't cost WebGL frames: what did was a frame split across messages (the old pacer, above).

**Parse rate**: 18 to 34 ms per MiB once warm, so a 64 KiB piece takes 1.2 to 2 ms. The first 16 KiB after the page loaded took 46 to 161 ms (JIT warm-up). xterm.js checks its 12 ms slice only between writes. So a frame with no markers is drawn whole up to about 350 to 650 KiB in the pieces of one message, and less when the page is cold. Past that only the markers keep it whole.

**What was seen before.** Each of these follows from the code and the replay above.

- **A frame split by the coalescing** (this branch's earlier pacer, not the base). Every frame was split. A WebGL tab drew about 4 frames a second, with half-second stalls, while the agent animated at 60. The base, which had no coalescing, drew about 60 (above).
- **A pause, or a client falling behind, mid-frame.** The half sent was held by the tab until the rest came, for up to `PAUSE_TIMEOUT_MS`.
- **A catch-up or an attach mid-frame.** The screen was taken from the mirror as it stood: the top of the new frame over the bottom of the old one. A snapshot carries no 2026, and a catch-up starts with RIS, which ends the tab's frame. So the rest of the frame was drawn as it came, torn.

**What the host does.**

- **`core/pty/sync-output.ts`** (`SYNC_MODE` = 2026 is exported from it, and `state/repaint-scroll.ts` imports it) follows only the set and the reset of 2026, as the output arrives. It also sees them among other modes (`CSI ? 2026 ; 25 h`) and when a read cuts one. A second set inside a frame changes nothing, a reset with no frame open is nothing, and RIS ends a frame, as each does in xterm.js. It doesn't use the mirror's parser, which is asynchronous.
- **`PtySession`** cuts its output just past each frame end (`cutAtFrameEnds`). For each piece, it writes the mirror at once and then hands the piece on. The answerer of a query is still designated as the output arrives (see "Who answers a query").
- **The pacer** holds a frame from its BSU to its ESU, with whatever was pending before it, and sends it as one message. It is not split by `COALESCE_MS` or `MAX_FRAME_CHARS`. Pausing and falling behind are decided only between frames: `deliver` runs once per whole frame, and `evaluate` never pauses while a frame is held.
- **`FRAME_HOLD_MS` = 200** is the time cap. That is 8 times the slowest arrival measured (1.5 MiB in 26 ms), well under xterm.js's own 1 s, and alacritty and zellij use 150 ms. A frame that doesn't end in time is let go, and the rest of it flows as ordinary output. The tab still holds it by its markers.
- **`FRAME_HOLD_MAX_CHARS` = 1 MiB** is the size cap. It bounds memory per PTY. A full repaint of a large screen in true colour is a few hundred KiB, and 1 MiB parses in about 20 to 35 ms.
- **Snapshots are taken only between frames.** An attach joins at the frame's end (`pacer.whenNoFrame`), and so does a catch-up that falls due mid-frame. Both are bounded by the caps. Because PtySession cuts there, the settled snapshot is exactly what came before. A client joining mid-frame gets none of it, and the rest of the frame goes to the others first (`add`). When the process ends, restarts or the host stops, a held frame is sent first.
- **The markers are kept for every client.** The measurements gave no reason to strip them for xterm.js. Once frames arrive whole, kept and stripped both draw at the agent's rate. Kept, they still protect a frame that a cap let go, or one that takes longer than a parse slice. Native terminals (`work attach`) keep them too.

**Scroll after a repaint.** Claude Code reprints its whole transcript after a resize or a toggle: `CSI 2 J`, `CSI 3 J`, then every line, inside one frame. In xterm.js 6 (measured in the same Chromium, with or without 2026, and split into 4 writes), a view at the bottom stays at the bottom and follows. A view scrolled up 50 lines lands at line 0 of the new scrollback and stops following. Before, the top of the view showed "line 221"; after, "line 0".

`state/repaint-scroll.ts` fixes it with xterm's public parser hooks. Its handlers run before xterm's and fall through (`return false`), so the view is noted before anything is cleared. It is put right at the frame's ESU. With no frame it is placed after each write as far as the reprint has come, and put right for good once no write has come for `REPAINT_QUIET_MS` (50), or `REPAINT_SETTLE_MS` (500) after the clear, whichever is first (output that goes on after a repaint doesn't hold the view longer than that):

- **at the bottom**: kept at the bottom (`scrollToBottom`, as Wave Terminal does);
- **scrolled up**: the same text stays at the top of the view. The view's top 3 lines are looked for in the reprint, starting from the same distance from the bottom and going out from there. If they are not found, that distance alone is used. It stays scrolled up and doesn't follow.

Measured with the fix, "line 221" stayed at the top in every case, including a reprint 20 lines shorter. A cleared screen alone (`2 J`), the alternate screen and a reset move nothing.

A repaint with no 2026 is not one write in the real app: the PTY is read 1 KiB at a time and the first read of a quiet moment is sent alone, so the clear and the first lines come in a write of their own. Putting the view right at the end of that write (as at first) found only the first lines of the reprint: a view scrolled up 120 lines in a 552-line scrollback went from "line 432" to "line 0", for a 5.9 KB reprint as for a 68 KB one (the Terminal tab against a real PTY host, Chrome for Testing 159). With 2026 it stayed on "line 432". `tests/web/repaint-scroll.test.ts` writes such a repaint in three writes into a headless xterm.

Left open:

- **8-bit CSI** (`0x9b`) is not recognised by the scanner. Agents write the 7-bit form.
- **A frame let go by a cap** reaches the tab split, as every frame did before, and so draws at the rate measured above. Upstream #6071 is still open.
- **A repaint with no 2026 and a pause in it** longer than `REPAINT_QUIET_MS` is put right where the reprint had come to then; the view stays there, scrolled up, while the rest arrives.
- **Not seen on Windows**: ConPTY's read sizes, and so the arrival spans there.

## Fonts and the renderer

The Terminal tab draws with `@xterm/addon-webgl` 0.19 where it can, and with xterm's DOM renderer where it can't. Three pure modules decide, and `PtyView` wires them:

- `state/webgl-gate.ts`: whether this machine gets WebGL at all.
- `state/webgl-renderer.ts`: the renderer over the tab's life (loaded, lost, released while hidden, disposed), on top of `webgl-recovery.ts`.
- `state/font-settle.ts`: when a font that arrived late makes the tab measure again.

**Measured** in Chromium (Playwright's Chrome for Testing 159, Metal, M3 Pro), with xterm.js 6.0.0 and addon-webgl 0.19.0 set up as `PtyView` sets them up, on a harness page and in the real app with the fake agent. The scripts are not in the repo (a manual check, not a CI test).

**What the addon does by itself.**

- **A lost context.** On `webglcontextlost` it calls `preventDefault`, waits 3 s for a restore and only then fires `onContextLoss`.
- **Dispose.** It removes the canvas but never calls `loseContext`, so the context stays alive until the canvas is garbage-collected.
- **Refusals.** It throws without WebGL2, and on Safari below 16.

**The cap.** Chromium keeps 16 live WebGL contexts per page. Measured: with 20 raw contexts, the first 4 were lost, each with "WARNING: Too many active WebGL contexts. Oldest context will be lost." The Chromium source wasn't read (rate-limited).

§ **Every dispose loses the context too** (`loseContexts` on the canvases the dispose took out). Without it, each re-run of `PtyView`'s connect effect left a live context behind: the 6 s elsewhere check, a start retry, Reconnect, Enter after an exit. Measured: one kept terminal and 20 disposed after it.

| | Kept terminal | Warnings |
|---|---|---|
| Dispose only (addon as is) | lost its context | 5 |
| Dispose + `loseContext` | kept its context | 0 |

Hermes does the same (`web/src/lib/xterm-webgl-release.ts`). VS Code (`src/vs/workbench/contrib/terminal/browser/xterm/xtermTerminal.ts`) and waveterm (`frontend/app/view/term/termwrap.ts`) dispose only.

§ **A terminal hidden in the deck lets its context go after `WEBGL_RELEASE_MS` = 10 s, and gets a new one when shown, before it is fitted.** The buffer stays, and while it is hidden the DOM renderer keeps it drawn, unseen. A deck item is `visibility: hidden`, so it keeps rendering.

- **Cost while hidden.** Per second of a hidden terminal, measured in task ms/s: a spinner costs 71 on WebGL against 27 on DOM, and a 30 fps full repaint 492 against 197. Hidden, WebGL costs more than DOM and holds a context for nothing.
- **Cost of a new context** (200×50 colourful screen, 15 tries), from the load to its first frame:
  - 13 ms median, 19 ms max, while another terminal shares the glyph atlas;
  - 64 ms median, 94 ms max, alone.
- **In the real app**, A shown again had WebGL back in 15 ms.
- **Why 10 s.** At that cost, 10 s means flipping between sessions makes no context per flip. A terminal opened hidden takes no context until it is first shown.
- **Elsewhere.** None of the reference files read lets a hidden terminal's context go. Hermes loses it when it rebuilds a terminal (above), Paradev keeps it while parked (`apps/desktop/src/renderer/lib/terminal/terminal-parking.ts`), and coder and VS Code have no deck.

§ **WebGL is not used on a software rasterizer**: a renderer name matching SwiftShader, llvmpipe, softpipe, "Software" or Microsoft Basic Render Driver (`webglRefusal`). The probe reads `WEBGL_debug_renderer_info`'s unmasked name, or `RENDERER` where it isn't offered, once per page, and loses its own context.

- **Measured with forced SwiftShader:** the first terminal drew 3.8 frames/s on WebGL against 7.2 on DOM, at about 300 % CPU either way. WebGL there is a slower CPU renderer.
- **A name that can't be read** is no reason to refuse: the addon tries, and falls back itself.
- **Hermes** gates the same names (`web/src/lib/xterm-webgl-gating.ts`).

§ **Safari is not refused.**

- The addon refuses Safari below 16 itself.
- The one report against later versions (Hermes #18773) names no cause.
- VS Code, which runs in Safari as vscode.dev, gates nothing.
- Refusing WebKit would put every macOS desktop-app user (Tauri's WKWebView) on DOM for no reason anyone has shown.

§ **A lost context: DOM at once, a refit, and tries again** on `webgl-recovery.ts`'s pauses: 2 s, 10 s and 60 s, and DOM for good at the 4th loss in 10 minutes. So there is no loop.

- **Due while hidden.** A try that falls due while the terminal is hidden waits until it is shown: then one try, not one per pause behind your back.
- **A new context that can't be had** after one was had counts as a loss and is tried again.
- **A first load that fails** means no WebGL here: DOM for good, nothing to wait for.
- **Measured in the real app**, a forced `WEBGL_lose_context`:
  - the corner said DOM after 3.9 s (the addon's 3 s wait);
  - the DOM rows held the text, and typed input echoed;
  - WebGL was back after 5.9 s;
  - hidden, A let its context go after 9.9 s;
  - shown, it had one again;
  - 0 "too many contexts" warnings.
- **Elsewhere.** VS Code, waveterm and Paradev (`apps/desktop/src/renderer/lib/terminal/terminal-addons.ts`) stay on DOM after a loss.

§ **A web font of the stack that arrives after `open()` makes the tab measure again.** xterm measures its cell on open, on a `fontFamily`/`fontSize` change, or after a resize. A setting to the same value is a no-op.

- **What it does.** Once `document.fonts.ready` resolves, for a face that was loading at the open, and on each `loadingdone` that brings a face of the stack, debounced by `FONT_SETTLE_MS` = 100 ms:
  1. sets `fontFamily` to `monospace` and back (xterm measures again);
  2. calls `clearTextureAtlas()`;
  3. fits through `FitScheduler`.
- **A face of another family** changes nothing.
- **A hidden terminal** remeasures but doesn't resize: `applyGrid` returns while hidden, and the fit when shown takes the new cell.
- **No web font yet.** The stack is local fonts only today (no `@font-face` in the SPA), so this is for the day it names one. In macOS Chrome it resolves to Courier, which is the font branch's question.
- **Elsewhere.** coder clears its atlas on every `loadingdone` (`site/src/modules/terminal/WorkspaceTerminal.tsx`). Hermes waits for its bundled faces (`web/src/lib/terminal-font-refit.ts`). Paradev waits for `document.fonts.load` of its stack (`apps/desktop/src/renderer/lib/terminal/font-settle.ts`).

**The glyph options.** Compared side by side on screenshots of Claude Code's logo, box lines and spinner symbols, with our font stack.

§ **`customGlyphs: true`** (xterm's default, now stated): xterm draws box-drawing and block characters to the cell.

- **Off**, they come from the font. Courier leaves gaps between cells, and Claude Code's logo and its boxes break apart.
- **coder sets it false** (PR #25059, `WorkspaceTerminal.tsx`): its logo looked distorted with xterm's block geometry. coder ships a font that draws them and a Powerline fallback font. That distortion wasn't seen on xterm 6.0 / addon 0.19.
- **VS Code** defaults to true (`src/vs/workbench/contrib/terminal/common/terminalConfiguration.ts`).

§ **`rescaleOverlappingGlyphs: true`**: a glyph wider than its cell (Ⅻ and similar ambiguous-width ones) is narrowed to the cell instead of drawn over the next.

- Claude Code's own symbols were unchanged pixel for pixel.
- VS Code defaults to true. xterm's default is false.

§ **`minimumContrastRatio` stays 1**: the agent's colours as it sent them.

- **What 4.5 (VS Code's default) did on our #1e1e1e background:**
  - black (46,52,54) became 133,138,138, and bright black (85,87,83) became 132,134,131: the two became the same grey;
  - red 204,0,0 became pink 223,89,89;
  - dim text was not touched (dim default stays 3.83:1, dim grey 2.49:1).
- **The cost.** A cold atlas with 2000 distinct colour pairs took 339 ms to its first frame against 188 ms (+80 %).
- **Elsewhere.** xterm, Paradev (`apps/desktop/src/renderer/lib/terminal/appearance/index.ts`) and coder keep 1.
- **The real problem.** xterm's default blue, red, magenta and bright black are under 3:1 on #1e1e1e. That is the theme's to fix (the theme branch), not a per-cell rewrite.

Left open:

- **Not seen:** Safari/WebKit, Windows (ANGLE on D3D11, WARP), a real GPU reset (only `WEBGL_lose_context`), or a real web font arriving.

## Status from the stream

An agent with no hooks got its status from a guess: working while it printed in the last 10 s (`output-status.ts`). Two sequences in its own output say it outright, and the mirror's parser already sees every byte. So the mirror keeps them (`core/pty/stream-status.ts`, `StreamStatus`), the host reports them on each PTY (`PtyInfo.signal`, additive: a host from before sends none and the guess stays), and the status reads them before the guess (`statusFromSignal`). The precedence and the mapping are in attention-inbox.md, "A tool with no hooks".

**The sequences, as read from their sources.**

- **OSC 9 ; 4 ; state ; percent** (ConEmu's progress, Windows Terminal's taskbar): 0 remove, 1 a percent, 2 error, 3 indeterminate, 4 paused.
- **OSC 7501 ; key=value:key=value** (the Program Status Protocol, rev 0.4, superlogical.com/rex/docs/build/program-status): `state` is idle, working, blocked, done or error, or `clear` (removes the record at `id` and those beneath it). With it: `id` (`a/b` paths, up to 8 segments, 128 bytes; none is the root record), `kind` (permission, question, auth: with blocked only), `progress` (0..100: with working or blocked only), `app`, and `title` / `msg` in base64. Either terminator. `OSC 7501 ; ?` is a probe, answered `OSC 7501 ; ?`.
- **Codex** (`codex-rs/tui/src/terminal_program_status.rs`): `ESC ] 7501 ; state=<s>:app=codex[:kind=<k>] ESC \`, and `state=clear` at exit, at ^Z and before handing the terminal to another program. It sends it whenever stdout is a terminal (not on a VTE older than 0.54), without probing. `done` follows a finished turn and becomes `idle` at your next key, paste or click (`acknowledge_program_status`, `app.rs`); `error` follows a failed one. No OSC 9;4.
- **opencode** (`packages/tui/src/context/program-status.ts`, through `@opentui/core`'s `setProgramStatus`, which doesn't probe): a root record (blocked, working or idle, summarising its sessions) and one child record per pending session (`id` = the session's, with `title` and `msg`); the root is cleared on exit.
- **Claude Code** (2.1.330, its bundle read): OSC 7501 with `app=claude-code`, `id`, `kind`, `progress`, `title`, `msg` — but only once the terminal answered its `OSC 7501 ; ?` probe (`programStatus` is off until then). OSC 9;4;3 (indeterminate) and 9;4;0 only where it decides the terminal shows them: ConEmu, Ghostty ≥ 1.2.0, iTerm2 ≥ 3.6.6 by `TERM_PROGRAM_VERSION`, never with `WT_SESSION`. Claude reports through hooks anyway, so its stream is not read (`statusFromOutput` returns nothing for `claude`).

**Parsing** follows xterm.js's own addons, rule for rule, so the mirror reads what a terminal on xterm.js would:

- **9;4** as `@xterm/addon-progress` (0.2.0): only `4;…`; more than three fields is nothing; a missing percent is 0, one over 100 is 100; a state past 4, or a percent that isn't digits where one counts, is nothing; error and paused keep the last percent when given 0, indeterminate always keeps it. Windows Terminal (`AdaptDispatch::DoConEmuAction`) differs at the edges: `9;4` alone clears, and fields past the third are ignored.
- **7501** as `@xterm/addon-program-status` (`ProgramStatusParser.ts`): pairs split on `:`, the last of a key wins; a pair without `=`, an unknown key, or a value outside `[A-Za-z0-9_.,+/=-]` is skipped; the report is discarded for a payload over 4087 bytes, an unknown key over 16 bytes, a malformed `id`, an `app` over 32 bytes, or a `title` / `msg` over its limit, not canonical base64, not UTF-8, or with a control character. A missing or unknown state is nothing.

Neither addon is a dependency. Each is a handler and a page of parsing; the program-status one is beta only (0.2.0-beta.x); both expect a browser terminal (addon-progress builds its emitter from `_core._onData`'s constructor); and the program-status one answers the probe, which the host must not do (below). Their tests' edge cases are ours (`tests/core/pty/stream-status.test.ts`).

§ **What it keeps, and for how long.**

- **One per terminal, bounded**: at most `MAX_RECORDS` = 64 records (the spec's floor; xterm.js keeps 256), the least recently updated dropped first, and one 9;4 bar.
- **A new process is a new mirror**, so a restart or a respawn starts with nothing, and an exited PTY reports nothing (`info`). The spec drops working and blocked at exit; nothing of an exited one is used at all.
- **RIS forgets everything** (the spec; `addon-program-status` does the same). DECSTR and the screens change nothing (the spec). The 9;4 bar is forgotten at RIS too: `addon-progress` and Windows Terminal keep it, but an agent that resets its terminal starts over.
- **Once an OSC 7501 report came, 9;4 is not followed until the next RIS** (the spec: a terminal "SHOULD stop" mapping 9;4 once it has 7501). A program that says its full state needs no bar read as one.
- **`since`** is when a record's state (and kind) began: a repeated `working` keeps it.

§ **A "working" from the stream expires after `STALE_WORKING_MS` (15 min) with no output at all**, and shows idle and `stale`, the same bound and shape as a hook's working (`effectiveStatus`). The spec forbids requiring a heartbeat, and this asks none: any output keeps it, and an agent at work redraws something every second (Codex its elapsed time, opencode and Claude Code a spinner). Fifteen silent minutes after "working" means it went away without saying: killed, or crashed under a shell that lives on. Nobody else expires it: Windows Terminal keeps the taskbar state until told (only `SetTaskbarProgress` writes it), VS Code resets the bar when a shell-integration command finishes (`xtermTerminal.ts`), kitty drops working and blocked at a new prompt or exit, and keeps done and error until the window is focused or a key is pressed. Blocked has no expiry: waiting on you is quiet by nature, and the agent's next report or a new process ends it.

§ **The `OSC 7501 ; ?` probe is not answered**, by the mirror or anyone. Answering it would switch Claude Code's own reports on for every session, but only those that started with no client attached (the mirror answers only then; the browser's xterm.js 6.0 has no handler, so a session started with the tab open would stay off): two behaviours, decided by who happened to watch. Claude has hooks; nothing needs it. Codex and opencode don't probe.

§ **Notifications are not read as "needs you"**: plain OSC 9 (iTerm2), OSC 777;notify (Ghostty/urxvt) and OSC 99 (kitty). Codex picks OSC 9 by itself only for terminals it recognises (`notifications/mod.rs`: Ghostty, iTerm2, kitty, Warp, WezTerm; BEL elsewhere, OSC 777 only when configured), and sends one on a finished turn ("agent turn preview", `turn_runtime.rs`) as well as on an approval ("Approval requested: …", `notifications/osc.rs`), so the text can't tell "done" from "needs you". Claude Code chooses one by terminal and setting (`notifyITerm2` / `notifyKitty` / `notifyGhostty`). OSC 9 text that starts with a digit is read as a ConEmu command (opencode's `OT1998-notification-osc.md`: `9;4;…` is progress). And Codex and opencode say the same in OSC 7501 without ambiguity, and Claude has hooks.

**Compared with others.**

- **xterm.js**: `@xterm/addon-progress` (VS Code loads it) and `@xterm/addon-program-status` (records per id, cleared by RIS or `processExited` / `promptStarted`, which drop working and blocked). The parsing above is theirs.
- **VS Code** (`src/vs/workbench/contrib/terminal/browser/xterm/xtermTerminal.ts`): addon-progress for the tab's progress, reset when a shell-integration command finishes. No 7501.
- **Windows Terminal** (`src/terminal/adapter/adaptDispatch.cpp`, `src/cascadia/TerminalCore/TerminalApi.cpp`): 9;4 to the taskbar; indeterminate keeps the percent, error and paused take 10 % when there was none. No timeout, no reset at RIS.
- **kitty** (`docs/misc-protocol.rst`): 7501 rev 0.4 in the tab bar and `kitten @ ls`; the lifetime rules above.
- **waveterm** (`frontend/app/view/term/termwrap.ts`): handlers for OSC 7 and 52 only; neither of these.
- **Paradev** (`packages/shared/src/terminal-title-scanner.ts`): its own byte scanner over the raw PTY bytes reads titles (OSC 0/2) and ConEmu's 9;3, not 9;4 or 7501.

Left open:

- **Not seen live:** Codex and opencode sending these in a work session (their sources were read; the sequences were played through a real PTY into `PtySession`, and the status followed each step). A host started before this build reports no signal until `work pty-host --restart`.
- **Done, unseen** (Codex's and opencode's `done`) shows as idle, seen: a stream status has no row for "Mark seen" to clear. Keeping "seen" for it in work web would let it reach the Inbox's Done section.
- **The percent** reaches `SessionAttention.progress` and the summary; nothing draws it yet.
- **`title`**, and `msg` other than a blocked one's (used as the summary), are validated but not shown.

## Reattach where you left off

A Terminal tab whose connection dropped (Wi-Fi, sleep, work web or the host restarted) wrote "[connection closed — press Enter to reconnect]", and Enter started over: a new terminal and the whole screen sent again (up to 129 KB with a full scrollback, measured below). The tab's own scrollback past `REPLAY_SCROLLBACK` (2 000 of its 5 000 lines), its scroll position and its selection were gone. Now it reconnects in place and is sent only what it missed, when the host can prove that is all it needs. Otherwise it gets a screen, as before.

**Where a client stands.** Every `replay` frame says which output stream it belongs to and the offset it leaves the client at (`stream`, `offset`; `core/pty/resume.ts`).

- **`stream`** is 16 hex characters from `randomBytes(8)`, one per registry entry. A new spawn under the same id after the entry ended, or a host started again, is another stream. A restart or halt in place keeps the entry, so it keeps the stream and the count: the new agent's output continues it, as an attached tab sees it, with no screen between, and a client resuming across it is sent the same characters from its offset. A resume that arrives during the restart is refused as `busy` (below) and gets a screen.
- **`offset`** is the pacer's (see "Flow control and coalescing", Offsets).
- **Live frames carry no stamp.** They are contiguous slices of the output, one host frame per WebSocket message, which the relay passes on as they are. So a client knows its offset: the last replay's, plus `utf16Length` of each binary frame (`StreamPosition`). Acks already rely on that count. A stamp per frame (Paradev's seq, sshx's chunk numbers) would add a header to every frame for something the client counts itself. A catch-up screen mid-session sets the position as the first screen does.

**Asking.** Reconnecting, the tab states `?resume=<stream>-<offset>-<cols>x<rows>` on its attach address: straight to the host with a ticket, or through the relay, which passes it on as it does `flow` and the grid. A malformed one is ignored (a screen). A reconnect only attaches: it never starts an agent and is never told "elsewhere". The ticket request says `attachOnly: true` (`ensurePty(…, { attachOnly })`, which throws `NOT_RUNNING` when the terminal isn't running), and the relay takes the parameter itself for the same.

**The tail.** The pacer keeps the last `RESUME_TAIL_CHARS` (256 Ki) characters of output as they arrived (`OutputTail`, `core/pty/output-tail.ts`). It is fed one piece at a time as the pacer takes each in (`piece()`: a chunk is cut where a synchronized frame opens or ends), and `pacer.offset` is the tail's end, so there is one count. Pushed whole at the top of `output()`, the tail would run ahead of a client that joins at a frame's end between two pieces of one chunk, and it would be sent from the tail what it is then sent live. Why that size:

- **A burst a tab would keep.** A client falls behind only past `HIGH_WATERMARK` (100 000) outstanding, so it misses a burst less that. 256 Ki covers a burst of ~360 000 characters: about the 5 000 lines a tab keeps (`VIEW_SCROLLBACK`) of ~72-character coloured lines. A 3 000-line burst of them is 218 000 characters (230 KB). Past that the tab would push most of it out of its own scrollback anyway. 64 Ki covered a burst of ~165 000.
- **Not counted, but bounded.** What a resume or a catch-up sends from it is never counted against a client's flow, as a screen isn't. It is at most this, about a screen of `REPLAY_SCROLLBACK`, and the catch-up rules above keep it from looping. It used to be under `HIGH_WATERMARK` so that a resume sent no more than a client might have outstanding anyway. A screen never kept to that either.
- **Memory.** At most 512 KiB per PTY (two bytes a character when the output has any non-Latin-1 character, as an agent's does), against the mirror's ~6 to 11.5 MiB: 10 MiB for 20 PTYs. It fills only after 256 Ki characters, about four minutes of a working Claude (~1 KB/s, pty-host.md). Host RSS with 5 sessions after 3 000 lines each (b9, 5 runs): 109.7 MB idle median, against 109.1 MB with 64 Ki. After the busy phase both sides range 79 to 114 MB with GC.
- Others keep 64 KiB (coder) to 2 MiB (Paradev, sshx, opencode).

A longer drop gets a screen, which is what a long absence wants anyway.

**Resume or screen.** `resumeFrom` (pure; its checks after the stream and the grid are `continueFrom`, which a catch-up uses too) decides as the client joins (`whenNoFrame`, right after `pacer.add`, where a screen is taken). What it missed is `tail.since(offset)`. It goes out as a `replay` with `resumed: true`, `data` = the missed output, `offset` = where its live output starts. Any doubt is a screen, sent as on any attach (`onResumeRefused` says why):

- **`stream`**: another stream.
- **`busy`**: the agent exited, is restarting or halted, or a redraw is changing the grid.
- **`grid`**: the tab's grid isn't the PTY's. It is checked against the grid now, the grid before this attach's own resize (a tab states its grid as it attaches, and that resize would hide a mismatch), and the stated grid.
- **`ahead`**: the offset is past the end.
- **`resized`**: the PTY's grid changed after the offset (`gridAt`, set at every real resize, the redraw's two included). The mirror reflowed and the agent repainted for another grid meanwhile. A change at or before its offset the tab already saw: Paradev wants the offset strictly after the change, but equal is the same as an uninterrupted client (it drew everything before the change and is sent everything after).
- **`too-old`**: what it missed is no longer all in the tail.
- **`split`**: the offset falls between the halves of a surrogate pair, where no frame ends.

§ Nothing twice, nothing lost. The missed output ends where the joined client's live output starts: the tail up to `pacer.offset` at the join, then the pacer's frames from there, held until `start()` as for a screen.

- **An open synchronized frame**: a resume during one waits for its end (`whenNoFrame`), so the frame arrives whole inside the missed output.
- **The tail's own cut** (mid-escape, mid-pair, mid-frame) is never sent: a resume starts at the tab's own offset, where its parser stands.
- **Drawing**: missed output is written in `WRITE_PIECE`s like a screen, and never acked.

§ Acks start again from the resumed offset. The missed output doesn't go through the pacer, so it isn't counted. The tab acks with a new counter per connection, so nothing owed on the old one is paid on the new.

§ One answerer. Queries in the missed output were answered when they came: by the client chosen then, or by the host's screen copy when nobody was attached. While xterm parses the missed output, the tab drops what it answers (`quiet`: empty writes mark the start and end, as ScreenMirror marks a chunk; `replyParts`). Typing and reports still go through, and queries in later live output are answered as before.

**The tab** (`PtyView`). When the connection closes unexpectedly after the first screen, and the host sent a `stream`:

- It keeps its Terminal, writes nothing in it, and queues input.
- It reconnects after `RECONNECT_DELAYS_MS` (0, 1, 2, 4 s), each try from where it stands then. It states its grid when shown, none when hidden.
- "Connecting…" covers the pane only after `RECONNECT_COVER_MS` (500 ms).
- **Resumed**: the missed output is drawn on the screen as it is, and the scrollback, scroll position and selection stay. Then its size and queued input are sent, as after any first screen. A `resumed: true` frame is always drawn this way, whatever state the tab thinks it is in, never over a reset terminal (a catch-up from the tail is one, see "Catching up from the tail", and so is a catch-up the host couldn't take a screen for, see "A screen that can't be taken").
- **Refused**: the screen is drawn over a reset terminal at its grid, as a catch-up is.
- **After the last try**: the old message, with the host's reason when the last try was given one and "; what you typed meanwhile was not sent" when input was queued (`connection closed: <reason>; what you typed meanwhile was not sent — press Enter to reconnect`), and Enter starts over. The queued input is dropped, never sent to a new terminal.
- **A frame is drawn after its connection closed.** xterm draws a write a while after the frame came, and the connection can close meanwhile. Each replay's completion is tied to the socket it came on (`live`, `finishReplay(sock)`): once that socket closed it makes nothing ready. Otherwise the next try's first frame would be taken for a catch-up (drawn over a reset terminal), and what was typed would go to a closed connection. What was given to xterm is still drawn, in order, so the position counts what was written.
- **A host from before** (no `stream`): the old message at once.

**Compatibility.** Additive: no `PROTOCOL_VERSION` bump, no `HOST_FEATURES` entry.

- **An older host** sends no `stream`, so the tab never asks.
- **A host started again** has another stream, so the tab gets a screen.
- **An older client** never states `resume` and ignores the new fields.

**`work attach`** stays on screens. It doesn't reconnect (its socket closing ends it), so it has nowhere to resume from. Reconnecting it is a change of its own.

**Measured**: a real PTY through the host, 133 586 characters in about a second, with colours, wide and astral characters and synchronized frames. The numbers are from three scratch runs on macOS, with timings added, of an earlier, timed version of `tests/functional/pty-resume-real.test.ts`: a 30 ms drop, and a frame the stand-in agent held for a fixed time. The test itself now waits only on what was seen: the frame is held until the test says, and each cut waits on the clients' output and the host's screen. Each time includes opening the WebSocket.

| What was sent | Size | Time to arrive |
|---|---|---|
| Resume after a 30 ms drop | 7.9–8.4 Ki characters (10.9–11.5 KB) | 7.5–15 ms |
| Resume inside a held synchronized frame | 76 characters (238 B) | 40–66 ms (the wait for the frame's end) |
| Screen at about the same moment | 43.6 Ki characters (56 KB) | 122–132 ms in four runs of five, 7 ms in one |
| Screen at the end, full `REPLAY_SCROLLBACK` | 101 Ki characters (129 KB) | 17–31 ms |

What the runs show:

- **Equal**: the resumed client's serialized buffer (screen and 10 000-line scrollback) equaled the uninterrupted client's in every run.
- **The check catches errors**: a client resuming 3 characters off, or dropping what it missed, came out different.
- **A screen is not equal**: a client sent a screen instead (too old) differs by its scrollback, because a screen carries 2 000 lines.

**Compared with others.**

- **Paradev** (`packages/host-service/src/terminal/terminal.ts`; the renderer's `terminal-seq-anchor.ts`), the closest:
  - `?seq=<epoch>:<n>`, the `epoch` from `randomBytes(8)` per session (our `stream`). It keeps a 2 MiB catch-up ring and sends a `synced {epoch, seq, head, mode}` message first.
  - It resumes `exact` when the ring still holds `seq`, `seq` is past the last resize and not past the head. Otherwise it `reanchor`s: it keeps the client's screen and nudges a SIGWINCH instead of sending a screen. We send a screen.
  - It keeps the anchor in localStorage. Ours dies with the page, whose terminal is new anyway.
  - It notes that replayed bytes must not be answered, as we do.
- **sshx** (`crates/sshx-server/src/session.rs`): it keeps 2 MiB per shell (`SHELL_STORED_BYTES`) and resumes by chunk number (`subscribe_chunks`). A request older than that is clamped silently (`saturating_sub`), with no screen and no stream id.
- **opencode** (`packages/core/src/pty.ts`, `pty/protocol.ts`): a 2 Mi-character buffer, `?cursor=` and a meta frame with the cursor. A cursor that is too old silently replays the whole buffer; it has no incarnation id.
- **coder** (`agent/reconnectingpty/buffered.go`): a 64 KiB ring (`circbuf.NewBuffer(64 << 10)`) replayed whole on every reconnect, with no offset.
- **VS Code** (`platform/terminal/node/ptyService.ts`, `XtermSerializer`): always a serialized screen (`persistentSessionScrollback` 100 lines), no offset.
- **zmx** (`serializeTerminalState`): always a ghostty-vt screen, no offset.
- **tmux**: redraws from its grid and never sends raw output.

Left open:

- **Not seen in a real browser.** The tab is tested in jsdom with a fake xterm, and end to end with @xterm/headless clients over real sockets.
- **The cover's 500 ms and the four tries** are judgement, not measured on a real outage. A drop that lasts longer than about 7 s gets the old message.
- **`work attach`** doesn't reconnect.

## The libghostty engine

Everything above was written for the xterm screen copy, `ScreenMirror` (@xterm/headless), which stays as the
fallback. The default is `GhosttyMirror` (`core/pty/ghostty-mirror.ts`, on libghostty-vt's wasm build:
`vendor/libghostty-vt/README.md`); config `terminalEngine` / `WORK_TERMINAL_ENGINE` picks per terminal (`create-mirror.ts`,
falling back to xterm with one warning if the module can't load). Pacing, the output tail and reattaching where you
left off work on the output stream, not on the screen copy: they are the same on either. Both implement `TerminalMirror` (`mirror.ts`); the
snapshot is the same layout (`START`, screen, state, never 2026, no palette), whichever engine the browser draws with
(next section).

- **Read, not followed:** modes, title, kitty flags (current), cursor and pending wrap from libghostty's API; pen,
  hyperlink, modifyOtherKeys, charsets and DECSCA from its formatter (`tail`); cursor shape, scroll region and saved
  cursor by asking a copy of the terminal (binary snapshot, decoded; ESC 8, and 1049l for the normal screen under
  the alternate one). The copy cost 12 ms under 2000 lines of scrollback, so the usual case does without it: on the
  normal screen, between sequences (`ground()`), with no cursor ever saved, the two DECRQSS questions change nothing
  and the terminal itself is asked (0.1 ms). "A cursor may have been saved" is the one thing noted from the stream
  (`SAVES_CURSOR`, carried over a chunk's end, forgotten on a reset); it only picks the way of reading, never the
  answer. Nothing else is tracked by hand; the only tables are the reply translation (DA1/DA2 as xterm.js's,
  colour replies from `TerminalColors`) and the replies dropped (XTVERSION, DA3, XTGETTCAP, `CSI ? u`, kitty
  graphics, the OSC 7501 probe). OSC 9;4 / 7501 come from libghostty's own parser (`programReport`).
- **Writes are parsed in the call**, so there is no write queue: a resize applies at once and `snapshotSettled` takes
  the snapshot now. A snapshot taken mid-sequence ends with the sequence so far (`continuation`), so the output after
  it completes it; ScreenMirror has no such tail (an attach between pieces cut mid-sequence draws the rest as text).
- **Known differences** (each an `it.fails` in `tests/core/pty/ghostty-mirror.test.ts`): one flag per mouse encoding
  and protocol, replayed lowest first (the order set is unknowable); one scroll region for both screens; blink kept in
  the cursor shape (`?12h` is never replayed); RIS clears the title and shows the cursor; the mirror clusters graphemes
  (mode 2027 on, as the tab on libghostty; said at the start of a snapshot), so a ZWJ emoji is 2 columns where
  xterm.js's Unicode 11 counts 6 — only a libghostty host with an xterm.js client (the URL override) disagrees; a
  zero-width character at a row's start is dropped; OSC 4 stops at an index out of range; kitty's
  flag stack is not readable (only the current flags are replayed); 1007 and 2031 are replayed only when they differ
  from libghostty's default, DECSCUSR 2 never; no resize without reflow (ConPTY's `windowsPty` only stops scrollback
  being pulled back); libghostty drops whole scrollback pages, so it is given twice `REPLAY_SCROLLBACK`.

## The Terminal tab's engines

PtyView (`web/.../Terminal/PtyView.tsx`) keeps the socket, frames and acks, the replay gate, reconnects, latency, the
perf log and when to fit; what parses, draws, measures and turns keys into bytes is an engine (`engine/terminal-engine.ts`,
`TerminalEngine`). The wire is the same for both: frames, the VT-bytes snapshot, acks.

- **Which:** `?terminalEngine=ghostty|xterm` on the page's address (kept in this browser's localStorage; `?terminalEngine=`
  forgets it), else the `terminalEngine` setting (the same key as the mirror's; read once per page in the background and
  remembered for the next load, so the first terminal never waits for it), else libghostty-vt (`engineChoice`). If its module can't be loaded the tab
  draws with xterm.js and its corner says why.
- **xterm.js** (`engine/xterm-engine.ts`, the fallback, and what `terminalEngine: xterm` picks): unchanged — WebGL with its retry, fonts, copy, links, Unicode 11.
- **libghostty-vt** (`engine/ghostty-engine.ts`, its own chunk, loaded with `import()` only when picked): the module is
  a served asset (`new URL(... .wasm, import.meta.url)`; `spa-handler.ts` serves it as `application/wasm`), compiled
  once per page, a fresh instance per terminal. The binding is the mirror's: `wasm-core.ts`, `vt-terminal.ts`,
  `render-state.ts`, `key-encoder.ts`, `mouse-encoder.ts`, `pointer.ts` and `replies.ts` are pure (in `SPA_SHARED`); only `wasm.ts` (Node: reads the
  file) and `terminal.ts` stay Node-side. If it can't load, xterm.js draws and the corner says why (`cornerBadge`).
- **Drawing:** one canvas, device pixels; a cell is `floor(advance × dpr)` wide like xterm.js's WebGL renderer, so both
  fit the same grid (FitAddon's measure, with its 14 px scrollbar gutter, which draws the thumb). Each animation frame
  takes the render state's dirty rows (`render-state.ts`, cells read in bulk) and repaints only those: backgrounds,
  box/block characters as shapes (`ghostty-draw.ts`, `boxShape`), then text by style with `letterSpacing` making the
  font's advance the cell's (a glyph wider than its cells is narrowed), then underlines (single, double, curly, dotted,
  dashed, in their colour), strike, overline, the cursor (block/bar/underline, blinking, hollow when unfocused). Nothing
  is drawn while a program holds the screen (2026, libghostty's render-hold callback), for at most 1 s. The frame loop
  allocates little per frame (one repaint set, colour strings cached, the textarea moved only when the cursor moves);
  the blink timer runs only while the terminal is focused and shown.
- **Graphemes:** the tab's terminal is made with grapheme clustering (2027) on as the mode's reset default
  (`graphemeClusters`, `OPT.MODE_DEFAULT`), so it survives the RIS a catch-up draw starts with: 👍🏽 and a ZWJ family are
  one character of 2 columns, as xterm.js's Unicode 11 widths have them, drawn as one glyph in their cells (narrowed if
  the emoji font draws them wider). A program may still turn it off.
- **Input:** a hidden textarea; keys through libghostty's key encoder (kitty flags, DECCKM, modifyOtherKeys as the
  program set them; `keyInput` maps a browser event), pastes through its paste encoder (2004), focus reports (1004).
  Shift+Enter is ESC CR unless the program asked for kitty keys. Replies (`WRITE_PTY`) go out once, after the write,
  translated as the mirror's (`translateReplies`, colour replies passed through: this terminal has the real colours).
- **Scrollback:** libghostty's viewport (wheel, Shift+PageUp/PageDown); new output never moves a view scrolled up;
  typing returns it to the bottom. On the alternate screen, when no program has the mouse, the wheel is arrow keys
  while alternate scroll (1007, on by default) is.
- **Selection** (`core/pty/ghostty/pointer.ts`): libghostty's selection gestures — a drag selects by cell (a cell counts
  once the pointer passes its middle), a double click a word, a triple click the whole line (wrapped rows with it),
  Shift+click moves the nearer end; a drag past the top or bottom edge scrolls the view a row every 50 ms
  (`AUTOSCROLL_TICK`, our timer). The selection is the terminal's own, so it stays on its text as output scrolls and
  works in the scrollback. Each row's selected columns come from the render state and are painted as xterm.js paints
  its default selection: white at 30% over the backgrounds, under the text. Typing (or a paste) clears it, as xterm.js's
  `onUserInput` does. While a program has the mouse, selecting needs Shift held.
- **Copy:** Ctrl+C with a selection copies (and clears it), without one it is ^C; the browser's own copy (⌘C, menus) is
  handled on the box's `copy` event — both as xterm-engine's. The text is libghostty's formatter over the selection
  (soft-wrapped rows joined, trailing blanks trimmed), and its VT form gives the bold and italic marks (`markedVt`,
  checked against the text with `markedOr`); then `terminalCopy` and `writeRich` as xterm's path.
- **Mouse reporting** (`core/pty/ghostty/mouse-encoder.ts`): presses, releases, motion and the wheel (one report per wheel
  event, as xterm.js) through libghostty's mouse encoder, in the mode and format the program set (9/1000/1002/1003;
  X10, 1005, SGR 1006, 1015, SGR pixels 1016 in device pixels with the real cell size). The encoder is set from the
  terminal only when those modes change, so its last-cell dedupe holds (a 1002 drag sends one report per cell).
- **Links:** an OSC 8 link (the cell's hyperlink bit, its address from `ghostty_grid_ref_hyperlink_uri`) or a web
  address found by xterm.js's WebLinksAddon rule (its regex and URL check, over the line with its wrapped rows;
  `ghostty-pointer.ts`, `urlAt`) is underlined with a pointer cursor while hovered (an OSC 8 link's address in the
  tooltip, as xterm's `linkHandler.hover`); a click without a drag opens it with `openLink` (http/https only), which
  both engines share from `terminal-engine.ts`. Not while a program has the mouse.
- **Testing:** the box has `wdScreenText()` (the rows as last drawn) for `e2e/ghostty-terminal.spec.ts`.
- **Not yet:** search, an accessibility tree, ligatures and font fallback tuning.
- **Known differences from xterm.js:** shades (░▒▓) are drawn as translucent fills, not dither patterns;
  `setWindowsPty` is a no-op (libghostty always reflows); the corner never says DOM/WebGL (`ghostty`); a drag's end
  cell follows libghostty's half-cell rule (xterm.js takes the cell under the pointer); Shift+click extends from the
  selection's nearer end, not from the original press; middle-click and right-click do nothing without mouse reporting.
