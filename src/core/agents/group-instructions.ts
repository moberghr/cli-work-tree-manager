import fs from 'node:fs';
import path from 'node:path';
import spawn from 'cross-spawn';
import type { WorkConfig } from '../platform/config.js';
import { getConfigDir } from '../platform/config.js';
import { agentFor, internalAgent } from './index.js';
import { report } from '../platform/report.js';

/**
 * Generate a group's combined instructions file — under the name the
 * configured agent reads (CLAUDE.md, AGENTS.md: agents/ `instructionsFile`),
 * from each repo's own — written by the summarising agent's one-shot run.
 * Falls back to a concatenated template if that run fails. Kept in
 * ~/.work/<group>.claude.md (the name it always had) and copied into each
 * group worktree's root.
 */
export function generateGroupInstructions(
  groupName: string,
  repoAliases: string[],
  config: WorkConfig,
): void {
  const outputPath = path.join(getConfigDir(), `${groupName}.claude.md`);
  const fileName = agentFor(config).instructionsFile;

  // Build prompt with each repo's instructions file
  const promptParts: string[] = [];
  promptParts.push(
    `You are generating a ${fileName} file (instructions for an AI coding agent) for a multi-repository workspace.`,
  );
  promptParts.push(
    'The workspace contains the following repositories as subdirectories:',
  );
  promptParts.push('');

  for (const alias of repoAliases) {
    const repoPath = config.repos[alias];
    const repoName = path.basename(repoPath);
    const claudeMdPath = path.join(repoPath, fileName);

    promptParts.push(`## Repository: ${repoName}/ (alias: ${alias})`);

    if (fs.existsSync(claudeMdPath)) {
      const content = fs.readFileSync(claudeMdPath, 'utf-8');
      promptParts.push(`### ${fileName} contents:`);
      promptParts.push('```');
      promptParts.push(content);
      promptParts.push('```');
    } else {
      promptParts.push(`(no ${fileName} found)`);
    }
    promptParts.push('');
  }

  promptParts.push(`Generate a combined ${fileName} for this workspace that:`);
  promptParts.push(
    '1. Explains the workspace structure (which subdirectories contain which repos)',
  );
  promptParts.push(
    `2. Merges and synthesizes the instructions from all repos' ${fileName} files`,
  );
  promptParts.push(
    '3. Notes any cross-repo relationships or considerations',
  );
  promptParts.push(
    '4. Keeps all specific technical instructions (build commands, test commands, etc.) organized by repository',
  );
  promptParts.push('');
  promptParts.push(
    `Output ONLY the markdown content for the combined ${fileName}, with no additional commentary.`,
  );

  const prompt = promptParts.join('\n');

  report('step', `Generating the combined ${fileName} for group '${groupName}'...`);
  report('detail', `(${internalAgent(config).name} writes the combined file)`);

  // Text-only, no tools, neutral cwd, tagged internal: the summarising agent's one-shot (agents/).
  const oneShot = internalAgent(config).oneShot;
  const run = oneShot?.command({}) ?? null;
  const result = run
    ? spawn.sync(run.cmd, run.args, {
        input: prompt,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        cwd: run.cwd,
        env: run.env,
      })
    : null;

  let content: string;

  if (!result || result.status !== 0 || !result.stdout?.trim()) {
    report('warn', `Couldn't have the combined ${fileName} written. Creating a basic template instead.`);
    content = buildFallbackTemplate(groupName, repoAliases, config);
  } else {
    content = result.stdout.trim();
  }

  fs.writeFileSync(outputPath, content, 'utf-8');
  report('success', `Saved: ${outputPath}`);
}

function buildFallbackTemplate(
  groupName: string,
  repoAliases: string[],
  config: WorkConfig,
): string {
  const fileName = agentFor(config).instructionsFile;
  const parts: string[] = [];
  parts.push(`# Multi-Repository Workspace: ${groupName}`);
  parts.push('');
  parts.push('This workspace contains the following repositories:');
  parts.push('');

  for (const alias of repoAliases) {
    const repoPath = config.repos[alias];
    const repoName = path.basename(repoPath);
    parts.push(`- **${repoName}/** (alias: ${alias})`);
  }

  parts.push('');
  parts.push('## Per-Repository Instructions');
  parts.push('');

  for (const alias of repoAliases) {
    const repoPath = config.repos[alias];
    const repoName = path.basename(repoPath);
    const claudeMdPath = path.join(repoPath, fileName);

    parts.push(`### ${repoName}`);

    if (fs.existsSync(claudeMdPath)) {
      const content = fs.readFileSync(claudeMdPath, 'utf-8');
      parts.push(content);
    } else {
      parts.push(`(no ${fileName} found)`);
    }
    parts.push('');
  }

  return parts.join('\n');
}
