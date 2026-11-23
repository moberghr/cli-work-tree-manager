// Stand-in agent for the reattach test (pty-resume-real.test.ts): on "go", prints a fixed stream fast — coloured
// lines with accented, wide and astral characters, and synchronized frames (2026) that draw at the top of the screen —
// then FLOOD-DONE. Stays alive until killed.
//
// One frame is held open for the test to cut a client inside it, by files in its folder, not by time: at step
// FLOOD_HOLD_STEP it waits for `hold-go`, prints the frame's first half, and prints the rest only once `hold-finish`
// exists.
const fs = require('node:fs');

const BSU = '\x1b[?2026h';
const ESU = '\x1b[?2026l';
const steps = Number(process.env.FLOOD_STEPS || 300);
const holdStep = Number(process.env.FLOOD_HOLD_STEP || 150);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const write = (s) => new Promise((r) => process.stdout.write(s, () => r()));
const until = async (file) => {
  while (!fs.existsSync(file)) await sleep(2);
};

process.stdout.write('flood ready\r\n');
let started = false;
process.stdin.on('data', (d) => {
  if (started || !String(d).includes('go')) return;
  started = true;
  void run();
});

async function run() {
  for (let i = 0; i < steps; i++) {
    if (i === holdStep) {
      await until('hold-go');
      await write(`${BSU}\x1b7\x1b[1;1H\x1b[2K\x1b[7m top ${i} 😀 漢字 \x1b[0m`);
      await until('hold-finish');
      await write(`\x1b[2;1H\x1b[2K bottom ${i} é\x1b8${ESU}`);
    } else if (i % 25 === 10) {
      await write(`${BSU}\x1b7\x1b[1;1H\x1b[2K\x1b[7m top ${i} 😀 漢字 \x1b[0m`);
      await sleep(20);
      await write(`\x1b[2;1H\x1b[2K bottom ${i} é\x1b8${ESU}`);
    }
    let s = '';
    for (let j = 0; j < 8; j++) s += `\x1b[3${(i + j) % 8}m${i}.${j} é 漢字 😀 ${'x'.repeat((i * 7 + j * 13) % 60)}\x1b[0m\r\n`;
    await write(s);
    if (i % 5 === 0) await sleep(2);
  }
  await write('FLOOD-DONE\r\n');
}
setInterval(() => {}, 1 << 30);
