# Color Forcing

`bin.ts` sets `chalk.level = 1` when chalk detects level 0, because Windows `.cmd` shims don't preserve TTY detection. Respects `NO_COLOR` env var.
