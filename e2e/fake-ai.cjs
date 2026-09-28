// Stand-in for Claude in e2e tests: configured as `aiCommand`, so the PTY
// host spawns this instead of a real (slow, networked, billed) Claude.
// Prints a banner, then echoes every line it reads as `echo:<line>`, and
// stays alive until killed — enough to prove input → PTY → screen works.
const readline = require('node:readline');

process.stdout.write(`FAKE-AI READY pid=${process.pid}\r\n`);
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  process.stdout.write(`echo:${line}\r\n`);
});
setInterval(() => {}, 1 << 30);
