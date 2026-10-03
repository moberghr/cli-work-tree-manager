// A made-up headless agent with a protocol of its own (not Claude's), to
// prove chat-session.ts runs any adapter's: JSON lines both ways.
//
//   in:  {"say": text}                       → {"said": text}, {"done": true}
//   in:  {"say": "ask"}                      → {"asks": {"id","tool","input"}}, then waits
//   in:  {"answer": id, "allow": bool}       → {"said": "allowed"|"denied"}, {"done": true}
//   in:  {"say": "hang"}                     → nothing (it has no interrupt)
//
// Its pid goes to FAKE_CLAUDE_PIDS (a file) so tests can sweep it.
const fs = require('node:fs');
const readline = require('node:readline');

if (process.env.FAKE_CLAUDE_PIDS) fs.appendFileSync(process.env.FAKE_CLAUDE_PIDS, `${process.pid}\n`);
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
out({ hello: 'echo-conv-1', argv: process.argv.slice(2) });

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  let m;
  try { m = JSON.parse(line); } catch { return; }
  if (typeof m.answer === 'string') {
    out({ said: m.allow ? 'allowed' : 'denied' });
    out({ done: true });
    return;
  }
  if (m.say === 'hang') return;
  if (m.say === 'ask') {
    out({ asks: { id: 'r1', tool: 'Shell', input: { cmd: 'ls' } } });
    return;
  }
  out({ said: String(m.say) });
  out({ done: true });
});
rl.on('close', () => process.exit(0));
