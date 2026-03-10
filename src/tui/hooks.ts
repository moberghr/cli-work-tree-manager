/**
 * Manages a local HTTP server that receives Claude Code hook events
 * (Stop, Notification) to detect when sessions become idle or resume work.
 *
 * On startup, injects hook config into ~/.claude/settings.json.
 * On shutdown, removes the injected hooks and restores original settings.
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export type HookEvent = 'stop' | 'notification' | 'prompt_submit';

export interface HookPayload {
  session_id: string;
  cwd: string;
  hook_event_name: string;
  notification_type?: string;
}

export type HookCallback = (cwd: string, event: HookEvent) => void;

const SETTINGS_PATH = path.join(os.homedir(), '.claude', 'settings.json');

export class HookServer {
  private server: http.Server;
  private port = 0;
  private callback: HookCallback;

  constructor(callback: HookCallback) {
    this.callback = callback;

    this.server = http.createServer((req, res) => {
      if (req.method !== 'POST') {
        res.writeHead(404);
        res.end();
        return;
      }

      let body = '';
      req.on('data', (chunk: string) => { body += chunk; });
      req.on('end', () => {
        res.writeHead(200);
        res.end();

        try {
          const payload: HookPayload = JSON.parse(body);
          const cwd = normalizePath(payload.cwd);

          if (payload.hook_event_name === 'Stop') {
            this.callback(cwd, 'stop');
          } else if (payload.hook_event_name === 'Notification') {
            this.callback(cwd, 'notification');
          } else if (payload.hook_event_name === 'UserPromptSubmit') {
            this.callback(cwd, 'prompt_submit');
          }
        } catch { /* ignore malformed payloads */ }
      });
    });
  }

  /** Start the server and inject hooks into Claude settings. Returns the port. */
  async start(): Promise<number> {
    return new Promise((resolve, reject) => {
      this.server.listen(0, '127.0.0.1', () => {
        const addr = this.server.address();
        if (!addr || typeof addr === 'string') {
          reject(new Error('Failed to get server address'));
          return;
        }
        this.port = addr.port;
        this.injectHooks();
        resolve(this.port);
      });

      this.server.on('error', reject);
    });
  }

  /** Stop the server and restore original Claude settings. */
  async stop(): Promise<void> {
    this.restoreSettings();
    return new Promise((resolve) => {
      this.server.close(() => resolve());
    });
  }

  private injectHooks() {
    try {
      const settings = fs.existsSync(SETTINGS_PATH)
        ? JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8'))
        : {};

      const baseUrl = `http://127.0.0.1:${this.port}`;

      const hookEntry = (urlPath: string) => ({
        hooks: [{ type: 'http', url: `${baseUrl}${urlPath}`, timeout: 5 }],
      });

      // Preserve any existing hooks, append ours
      if (!settings.hooks) settings.hooks = {};

      const existing = settings.hooks;
      if (!existing.Stop) existing.Stop = [];
      if (!existing.Notification) existing.Notification = [];
      if (!existing.UserPromptSubmit) existing.UserPromptSubmit = [];

      // Remove any stale _work2Dash entries (e.g. from a previous crash)
      existing.Stop = existing.Stop.filter((h: any) => !h._work2Dash);
      existing.Notification = existing.Notification.filter((h: any) => !h._work2Dash);
      existing.UserPromptSubmit = existing.UserPromptSubmit.filter((h: any) => !h._work2Dash);

      // Tag our hooks so we can remove them on cleanup
      existing.Stop.push({ ...hookEntry('/stop'), _work2Dash: true });
      existing.Notification.push({ ...hookEntry('/notification'), _work2Dash: true, matcher: 'idle_prompt' });
      existing.UserPromptSubmit.push({ ...hookEntry('/prompt_submit'), _work2Dash: true });

      fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2));
    } catch { /* settings write failed — hooks won't work but dashboard still functions */ }
  }

  private restoreSettings() {
    try {
      // Always read current settings and remove tagged entries.
      // This avoids overwriting changes made externally while the dashboard was running.
      if (!fs.existsSync(SETTINGS_PATH)) return;

      const settings = JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8'));
      if (!settings.hooks) return;

      for (const key of Object.keys(settings.hooks)) {
        if (!Array.isArray(settings.hooks[key])) continue;
        settings.hooks[key] = settings.hooks[key].filter(
          (h: any) => !h._work2Dash,
        );
        if (settings.hooks[key].length === 0) delete settings.hooks[key];
      }
      if (Object.keys(settings.hooks).length === 0) delete settings.hooks;

      fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2));
    } catch { /* best-effort restore */ }
  }
}

function normalizePath(p: string): string {
  return path.resolve(p).toLowerCase();
}
