import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { backgroundWorkSince } from '../../../../src/core/agents/claude/files.js';
import type { WorktreeSession } from '../../../../src/core/sessions/history.js';

let home: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'work-claude-files-'));
  vi.spyOn(os, 'homedir').mockReturnValue(home);
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(home, { recursive: true, force: true });
});

const at = (ms: number, file: string) => fs.utimesSync(file, ms / 1000, ms / 1000);
/** A group whose Claude runs in its root (as feat/api-key-origin's does), with one conversation. */
function setup() {
  const root = path.join(home, 'wt', 'shop', 'feat-x');
  const session = {
    target: 'shop',
    branch: 'feat/x',
    isGroup: true,
    paths: [path.join(root, 'api'), path.join(root, 'web')],
  } as WorktreeSession;
  const project = path.join(home, '.claude', 'projects', path.resolve(root).replace(/[^A-Za-z0-9]/g, '-'));
  const conversation = path.join(project, 'conv-1.jsonl');
  const subagents = path.join(project, 'conv-1', 'subagents');
  fs.mkdirSync(subagents, { recursive: true });
  fs.writeFileSync(conversation, '{}\n');
  /** A subagent of it: its transcript (last written at `writtenAt`) and its meta. */
  const agent = (id: string, requestShape: string | null, writtenAt: number) => {
    const file = path.join(subagents, `agent-${id}.jsonl`);
    fs.writeFileSync(file, '{}\n');
    if (requestShape) fs.writeFileSync(path.join(subagents, `agent-${id}.meta.json`), JSON.stringify({ agentType: 'fork', requestShape }));
    at(writtenAt, file);
  };
  return { session, conversation, agent };
}

describe("backgroundWorkSince (Claude's: a background agent still at work after the turn ended)", () => {
  const ended = Date.parse('2026-10-15T14:21:07Z');

  it('a background agent that wrote after the turn ended: yes (reported: feat/api-key-origin read Idle)', () => {
    const { session, conversation, agent } = setup();
    at(ended, conversation);
    agent('a345', 'background', ended + 600_000);
    expect(backgroundWorkSince(session, ended)).toBe(true);
  });

  it('one that finished before the turn ended, an ordinary subagent, or one with no meta: no', () => {
    const { session, conversation, agent } = setup();
    at(ended, conversation);
    agent('done', 'background', ended - 5_000); // its result came back in that turn
    agent('fg', 'sync', ended + 600_000); // not a background one (it ends inside its turn)
    agent('nometa', null, ended + 600_000);
    expect(backgroundWorkSince(session, ended)).toBe(false);
  });

  it("only the conversation of that turn is looked in, not other days' ones", () => {
    const { session, conversation, agent } = setup();
    at(ended - 3 * 3_600_000, conversation); // this conversation was last written hours before the turn ended
    agent('old', 'background', ended + 600_000);
    expect(backgroundWorkSince(session, ended)).toBe(false);
  });

  it('no conversation at all: no', () => {
    const session = { target: 'api', branch: 'x', isGroup: false, paths: [path.join(home, 'nowhere')] } as WorktreeSession;
    expect(backgroundWorkSince(session, ended)).toBe(false);
  });
});
