// Stand-in "AI tool" for functional tests: prints a banner, then echoes
// every line it reads as `echo:<line>`. Stays alive until killed, like a
// real agent CLI idling at its prompt. Args are printed so tests can check
// what the launcher passed (e.g. --continue).
process.stdout.write(`fake-ai ready args=[${process.argv.slice(2).join(' ')}]\r\n`);
let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let i;
  while ((i = buf.search(/\r|\n/)) !== -1) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    if (line) process.stdout.write(`echo:${line}\r\n`);
  }
});
setInterval(() => {}, 1 << 30);
