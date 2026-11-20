# `work dash` (removed in 2.0)

`work dash` (the Ink TUI with its own PTYs and http-type hook server) was retired: use `work web` (browser dashboard) + `work attach` (a real terminal on the same PTY-host session). Its leftover http hook entries in `~/.claude/settings.json` are PID-tagged and pruned as stale by the next `work web` start (its clean-up of old hooks, `removeRetiredAgentSetup`).
