// A stand-in for `claude -p --input-format stream-json --output-format stream-json`:
// the same line protocol, scripted. Its pid goes to FAKE_CLAUDE_PIDS (a file)
// so tests can sweep it.
//
//   "hello"           → init, streamed text "Hi there", assistant text, result
//   "slow"            → init, then nothing until interrupted (control_request)
//   "ignore-interrupt"→ like slow, but never acknowledges an interrupt
const fs = require('node:fs');
const readline = require('node:readline');

if (process.env.FAKE_CLAUDE_PIDS) fs.appendFileSync(process.env.FAKE_CLAUDE_PIDS, `${process.pid}\n`);
const sessionId = process.env.FAKE_CLAUDE_SESSION || 'fake-session-1';
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
let deaf = false;

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  let m;
  try { m = JSON.parse(line); } catch { return; }
  if (m.type === 'control_request' && m.request?.subtype === 'interrupt') {
    if (deaf) return;
    out({ type: 'control_response', response: { subtype: 'success', request_id: m.request_id, response: {} } });
    out({ type: 'result', subtype: 'error_during_execution', is_error: true, session_id: sessionId });
    return;
  }
  if (m.type !== 'user') return;
  const text = typeof m.message?.content === 'string' ? m.message.content : '';
  out({ type: 'system', subtype: 'init', session_id: sessionId, argv: process.argv.slice(2) });
  out({ type: 'user', message: m.message, session_id: sessionId });
  if (text === 'slow' || text === 'ignore-interrupt') {
    deaf = text === 'ignore-interrupt';
    return;
  }
  // Streamed over time, like the real thing (the chat throttles to ~20 updates/s).
  const steps = [
    () => out({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } }),
    () => out({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hi ' } } }),
    () => out({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'there' } } }),
    () => {
      out({ type: 'assistant', message: { id: 'msg_1', role: 'assistant', content: [{ type: 'text', text: 'Hi there' }] }, session_id: sessionId });
      out({ type: 'stream_event', event: { type: 'content_block_stop', index: 0 } });
      out({ type: 'result', subtype: 'success', is_error: false, duration_ms: 1200, total_cost_usd: 0.01, session_id: sessionId });
    },
  ];
  steps.forEach((step, i) => setTimeout(step, i * 80));
});
rl.on('close', () => process.exit(0));
