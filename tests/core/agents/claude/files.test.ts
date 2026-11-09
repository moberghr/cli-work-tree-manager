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
  /** A subagent of it: its transcript (last written at `writtenAt`) and its meta, written when it started (`startedAt`:
   *  by default well before the turn ended, so only its writes say it's at work). */
  const agent = (id: string, requestShape: string | null, writtenAt: number, startedAt = writtenAt - 3_600_000) => {
    const file = path.join(subagents, `agent-${id}.jsonl`);
    fs.writeFileSync(file, '{}\n');
    if (requestShape) {
      const meta = path.join(subagents, `agent-${id}.meta.json`);
      fs.writeFileSync(meta, JSON.stringify({ agentType: 'fork', requestShape, description: `the ${id} agent` }));
      at(startedAt, meta);
    }
    at(writtenAt, file);
  };
  return { session, conversation, agent };
}

describe("backgroundWorkSince (Claude's: a background agent still at work after the turn ended)", () => {
  const ended = Date.parse('2026-10-15T14:21:07Z');
  /** When it is asked: a minute after the agent's last write in these tests. */
  const now = ended + 660_000;

  it('a background agent that wrote after the turn ended: yes (reported: feat/api-key-origin read Idle)', () => {
    const { session, conversation, agent } = setup();
    at(ended, conversation);
    agent('a345', 'background', ended + 600_000);
    expect(backgroundWorkSince(session, ended, now)).not.toBeNull();
  });

  it('one that finished before the turn ended, an ordinary subagent, or one with no meta: no', () => {
    const { session, conversation, agent } = setup();
    at(ended, conversation);
    agent('done', 'background', ended - 5_000); // its result came back in that turn
    agent('fg', 'sync', ended + 600_000); // not a background one (it ends inside its turn)
    agent('nometa', null, ended + 600_000);
    expect(backgroundWorkSince(session, ended, now)).toBeNull();
  });

  it("only the conversation of that turn is looked in, not other days' ones", () => {
    const { session, conversation, agent } = setup();
    at(ended - 3 * 3_600_000, conversation); // this conversation was last written hours before the turn ended
    agent('old', 'background', ended + 600_000);
    expect(backgroundWorkSince(session, ended, now)).toBeNull();
  });

  it('one quiet for an hour is taken as done (hung or killed); quiet for 20 minutes (a test run, its review lanes) is still at work', () => {
    const { session, conversation, agent } = setup();
    at(ended, conversation);
    agent('slow', 'background', ended + 60_000);
    expect(backgroundWorkSince(session, ended, ended + 60_000 + 20 * 60_000)).not.toBeNull();
    const later = setup(); // a fresh folder: an answer is reused for two seconds
    at(ended, later.conversation);
    later.agent('hung', 'background', ended + 60_000);
    expect(backgroundWorkSince(later.session, ended, ended + 60_000 + 61 * 60_000)).toBeNull();
  });

  it('one the turn started just before it ended counts before its first write after (reported: feat/stored-card-email read Idle)', () => {
    const { session, conversation, agent } = setup();
    at(ended, conversation);
    // Started 6 s before the turn ended, last written 5 s before it: nothing written since, but it's this turn's.
    agent('review', 'background', ended - 5_000, ended - 6_000);
    expect(backgroundWorkSince(session, ended, ended + 90_000)).not.toBeNull();
  });

  it("one started long before the turn, quiet since it ended, isn't counted (an earlier turn's, finished)", () => {
    const { session, conversation, agent } = setup();
    at(ended, conversation);
    agent('earlier', 'background', ended - 5_000, ended - 10 * 60_000);
    expect(backgroundWorkSince(session, ended, ended + 90_000)).toBeNull();
  });

  it('asked again within two seconds, it answers without reading the folder again', () => {
    const { session, conversation, agent } = setup();
    at(ended, conversation);
    agent('a1', 'background', ended + 600_000);
    expect(backgroundWorkSince(session, ended, now)).not.toBeNull();
    fs.rmSync(path.dirname(conversation), { recursive: true, force: true });
    expect(backgroundWorkSince(session, ended, now + 1_000)).not.toBeNull();
    expect(backgroundWorkSince(session, ended, now + 3_000)).toBeNull();
  });

  it("says what's at work: the agent's own description, on one line", () => {
    const { session, conversation, agent } = setup();
    at(ended, conversation);
    agent('review', 'background', ended + 600_000);
    expect(backgroundWorkSince(session, ended, now)).toEqual({ what: 'the review agent' });
  });

  it.each([
    ['a multi-line one, on one line', '  /code-review\n  Review the\tbumps  ', '/code-review Review the bumps'],
    ['a blank one: none', '   \n ', null],
    ['none given: none', undefined, null],
    ['not text: none', 42, null],
  ])('its description, %s', (_name, description, what) => {
    const { session, conversation, agent } = setup();
    at(ended, conversation);
    agent('d', 'background', ended + 600_000);
    const meta = path.join(path.dirname(conversation), 'conv-1', 'subagents', 'agent-d.meta.json');
    fs.writeFileSync(meta, JSON.stringify({ requestShape: 'background', description }));
    at(ended - 3_600_000, meta);
    expect(backgroundWorkSince(session, ended, now)).toEqual({ what });
  });

  it('no conversation at all: no', () => {
    const session = { target: 'api', branch: 'x', isGroup: false, paths: [path.join(home, 'nowhere')] } as WorktreeSession;
    expect(backgroundWorkSince(session, ended, now)).toBeNull();
  });
});
