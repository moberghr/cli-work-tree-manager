// Stand-in "AI tool" for a DIRECT launch test: prints and exits at once, so
// `work tree --no-host` (which waits for the tool) returns. echo-ai.cjs is
// the one for host sessions — it stays alive like a real agent.
process.stdout.write(`direct-launch ok args=[${process.argv.slice(2).join(' ')}]\n`);
