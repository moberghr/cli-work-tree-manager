import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createArchivedRows } from '../../../src/core/sessions/session-wire.js';
import type { WorktreeSession } from '../../../src/core/sessions/history.js';
import type { SessionWire } from '../../../src/core/api-types.js';

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'archived-rows-'));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const session = (over: Partial<WorktreeSession> = {}): WorktreeSession => ({
  target: 'api',
  branch: 'feat/x',
  isGroup: false,
  paths: [],
  createdAt: '',
  lastAccessedAt: '2026-10-01T00:00:00Z',
  archivedAt: '2026-10-02T00:00:00Z',
  ...over,
});

describe('createArchivedRows', () => {
  it('an archived row is built once, and again only when its archive file, name, entry or note changes', () => {
    const file = path.join(dir, 'archive.json');
    fs.writeFileSync(file, '{}');
    const rows = createArchivedRows(() => file);
    const build = vi.fn(() => ({ id: 'x' }) as SessionWire);
    const s = session();
    rows(s, { hasNote: false }, build);
    rows(s, { hasNote: false }, build);
    expect(build).toHaveBeenCalledTimes(1);
    rows(s, { hasNote: true }, build);
    expect(build).toHaveBeenCalledTimes(2);
    rows({ ...s, title: 'Renamed' }, { hasNote: true }, build);
    expect(build).toHaveBeenCalledTimes(3);
    // The summary written after archiving lands in its file.
    const later = new Date(Date.now() + 5000);
    fs.utimesSync(file, later, later);
    rows({ ...s, title: 'Renamed' }, { hasNote: true }, build);
    expect(build).toHaveBeenCalledTimes(4);
  });

  it('a live session is built every time', () => {
    const rows = createArchivedRows(() => path.join(dir, 'none.json'));
    const build = vi.fn(() => ({ id: 'x' }) as SessionWire);
    const live = session({ archivedAt: undefined });
    rows(live, { hasNote: false }, build);
    rows(live, { hasNote: false }, build);
    expect(build).toHaveBeenCalledTimes(2);
  });
});
