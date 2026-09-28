import fs from 'node:fs';
import path from 'node:path';

/**
 * Start `work web` at login (Windows only for now), so after a reboot the
 * dashboard is up and the PTY host restores the Claude sessions that were
 * live before — no terminal needed.
 *
 * Mechanism: a tiny VBScript in the user's Startup folder that runs
 * `node <work-bin> web --no-open` with a hidden window (a .cmd would flash
 * a console). Per-user, no admin, removable by deleting one file.
 */
export function startupScriptPath(): string | null {
  if (process.platform !== 'win32' || !process.env.APPDATA) return null;
  return path.join(
    process.env.APPDATA,
    'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup',
    'work-web.vbs',
  );
}

/** VBScript string literal: wrap in quotes, double any embedded quote. */
function vbsQuote(s: string): string {
  return '"' + s.replace(/"/g, '""') + '"';
}

export function buildStartupScript(nodePath: string, workBin: string): string {
  // The command line itself needs quotes around each path (spaces), and
  // VBScript needs those quotes doubled inside its string literal.
  const cmdLine = `"${nodePath}" "${workBin}" web --no-open`;
  return [
    "' Written by `work web --autostart on`. Delete this file (or run",
    "' `work web --autostart off`) to stop work web starting at login.",
    `CreateObject("WScript.Shell").Run ${vbsQuote(cmdLine)}, 0, False`,
    '',
  ].join('\r\n');
}

export function setAutostart(enabled: boolean, workBin: string): string {
  const file = startupScriptPath();
  if (!file) throw new Error('Autostart is only supported on Windows so far.');
  if (enabled) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, buildStartupScript(process.execPath, workBin), 'utf-8');
  } else {
    try { fs.unlinkSync(file); } catch { /* already off */ }
  }
  return file;
}
