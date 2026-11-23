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
