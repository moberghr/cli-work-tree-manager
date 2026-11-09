import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { flatGroupSessions } from '../../src/commands/list.js';
import type { WorktreeSession } from '../../src/core/sessions/history.js';

/** `work list <group>`: a group's sessions in a flat session folder are listed too (they aren't under its folder). */

const row = (over: Partial<WorktreeSession>): WorktreeSession => ({
  target: 'shop',
  isGroup: true,
  branch: 'b',
  paths: [],
  createdAt: '',
  lastAccessedAt: '',
  ...over,
});

describe('flatGroupSessions', () => {
  it("its live sessions outside <root>/<group>/: branch, folder and own repos; not those under it, archived or another's", () => {
    const root = path.resolve('/wt');
    const groupDir = path.join(root, 'shop');
    const sessions = [
      row({ branch: 'feat/flat', paths: [path.join(root, 'feat-flat-a3f9c2', 'api')], repos: ['api', 'docs'] }),
      row({ branch: 'feat/old', paths: [path.join(groupDir, 'feat-old', 'api')] }),
      row({ branch: 'feat/gone', paths: [path.join(root, 'feat-gone-000000', 'api')], archivedAt: 'x' }),
      row({ target: 'admin', branch: 'feat/flat', paths: [path.join(root, 'feat-flat-7be014', 'api')] }),
    ];
    expect(flatGroupSessions('shop', groupDir, sessions)).toEqual([
      { branch: 'feat/flat', folder: path.join(root, 'feat-flat-a3f9c2'), repos: ['api', 'docs'] },
    ]);
  });
});
