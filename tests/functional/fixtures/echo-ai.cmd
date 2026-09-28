@echo off
rem .cmd shim around echo-ai.cjs, like npm's global bin shims (claude.cmd,
rem work.cmd). Exercises the cmd.exe escaping path in resolvePtyCommand.
node "%~dp0echo-ai.cjs" %*
