// Stand-in agent for the catch-up test (pty-resume-real.test.ts): on "go", prints BURST_LINES coloured history lines
// (wide and astral characters among them) in one write — an agent's burst — then BURST-DONE. Stays alive until killed.
const lines = Number(process.env.BURST_LINES || 3000);
const wide = ['👍 ⭐ ✅', '漢字テスト', 'plain', '⏺ Update', '✔ done'];
const line = (n) =>
  `\x1b[38;5;${(n % 200) + 16}mhistory ${String(n).padStart(6, '0')}\x1b[0m ${wide[n % wide.length]} \x1b[2mlorem ipsum dolor sit amet\x1b[0m\r\n`;

process.stdout.write('burst ready\r\n');
let started = false;
process.stdin.on('data', (d) => {
  if (started || !String(d).includes('go')) return;
  started = true;
  let out = '';
  for (let n = 0; n < lines; n++) out += line(n);
  process.stdout.write(out + 'BURST-DONE\r\n');
});
setInterval(() => {}, 1 << 30);
