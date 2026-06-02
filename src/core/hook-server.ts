/**
 * Local HTTP receiver for Claude Code hook events (Stop, Notification,
 * UserPromptSubmit). Multiple `work` subcommands can each run their own
 * HookServer concurrently — each tags its entries in ~/.claude/settings.json
 * via the shared `settings-editor` so the file write is atomic and stale
 * entries from a crashed previous run get pruned automatically.
 *
 * Originally lived under src/tui/hooks.ts and was hard-wired to `work dash`.
 * Now it's a shared primitive: `work dash` keeps using it for idle tracking
 * and `work web` mounts its own instance.
 */

import http from 'node:http';
import path from 'node:path';
import {
  editSettings,
  editSettingsSync,
  isLegacyEntry,
  isOwnerEntry,
  isStaleEntry,
  tag,
  type HookEntry,
} from './settings-editor.js';

export type HookEvent = 'stop' | 'notification' | 'prompt_submit';

export interface HookPayload {
  session_id: string;
  cwd: string;
  hook_event_name: string;
  notification_type?: string;
}

export type HookCallback = (cwd: string, event: HookEvent) => void;

export interface HookServerOptions {
  /** Identifies the subscriber so multiple `work` processes can coexist. */
  owner: string;
  callback: HookCallback;
}

export class HookServer {
  private readonly server: http.Server;
  private readonly owner: string;
  private readonly callback: HookCallback;
  private port = 0;

  constructor(opts: HookServerOptions) {
    this.owner = opts.owner;
    this.callback = opts.callback;

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
        } catch { /* malformed — ignore */ }
      });
    });
  }

  async start(): Promise<number> {
    const port = await new Promise<number>((resolve, reject) => {
      this.server.listen(0, '127.0.0.1', () => {
        const addr = this.server.address();
        if (!addr || typeof addr === 'string') {
          reject(new Error('Failed to get server address'));
          return;
        }
        resolve(addr.port);
      });
      this.server.on('error', reject);
    });
    this.port = port;
    await injectHttpHooks(this.owner, port);
    return port;
  }

  async stop(): Promise<void> {
    await removeHttpHooks(this.owner);
    return new Promise((resolve) => this.server.close(() => resolve()));
  }

  /** Synchronous best-effort cleanup for use in signal handlers where we
   *  can't await. Falls back to a sync write of the settings file. */
  cleanupSync(): void {
    removeHttpHooksSync(this.owner);
    try { this.server.close(); } catch { /* */ }
  }
}

const EVENTS = ['Stop', 'Notification', 'UserPromptSubmit'] as const;

function pathForEvent(event: string): string {
  if (event === 'Stop') return '/stop';
  if (event === 'Notification') return '/notification';
  return '/prompt_submit';
}

function buildEntry(owner: string, baseUrl: string, event: string): HookEntry {
  return tag(
    {
      hooks: [
        {
          type: 'http',
          url: `${baseUrl}${pathForEvent(event)}`,
          timeout: 5,
        },
      ],
      ...(event === 'Notification' ? { matcher: 'idle_prompt' } : {}),
    },
    owner,
  );
}

function mutateInject(owner: string, port: number) {
  const baseUrl = `http://127.0.0.1:${port}`;
  return (s: { hooks?: Record<string, HookEntry[] | undefined> }) => {
    if (!s.hooks) s.hooks = {};
    for (const event of EVENTS) {
      const list = (s.hooks[event] ?? []) as HookEntry[];
      const cleaned = list.filter(
        (h) => !isLegacyEntry(h) && !isStaleEntry(h) && !isOwnerEntry(h, owner),
      );
      cleaned.push(buildEntry(owner, baseUrl, event));
      s.hooks[event] = cleaned;
    }
  };
}

function mutateRemove(owner: string) {
  return (s: { hooks?: Record<string, HookEntry[] | undefined> }) => {
    if (!s.hooks) return;
    for (const key of Object.keys(s.hooks)) {
      const list = s.hooks[key];
      if (!Array.isArray(list)) continue;
      s.hooks[key] = list.filter(
        (h) => !isLegacyEntry(h) && !isOwnerEntry(h, owner) && !isStaleEntry(h),
      );
      if (s.hooks[key]!.length === 0) delete s.hooks[key];
    }
  };
}

function injectHttpHooks(owner: string, port: number): Promise<void> {
  return editSettings(mutateInject(owner, port));
}

function removeHttpHooks(owner: string): Promise<void> {
  return editSettings(mutateRemove(owner));
}

function removeHttpHooksSync(owner: string): void {
  editSettingsSync(mutateRemove(owner));
}

function normalizePath(p: string): string {
  return path.resolve(p).toLowerCase();
}
