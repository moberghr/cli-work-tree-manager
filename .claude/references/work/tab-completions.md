# Tab Completions

`completions/index.ts` provides dynamic completions via yargs' `--get-yargs-completions`. The handler receives `argv._` as `['<scriptName>', ...args, '<current>']` — skip first and last to get completed args. For groups, branch completions read from the group's directory on disk (not individual repo worktree lists).

`core/setup-completions.ts` handles auto-installing completion lines into shell profiles. Called during `work init` and available standalone via `work completion --install`. Detects PowerShell 7/5.1 on Windows (via `[Environment]::GetFolderPath('MyDocuments')`) and bash/zsh on Unix (via `$SHELL`). Idempotent — uses a `# work tab completions` marker to skip if already present.
