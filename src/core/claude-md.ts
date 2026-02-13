import fs from 'node:fs';
import path from 'node:path';
import spawn from 'cross-spawn';
import chalk from 'chalk';
import type { WorkConfig } from './config.js';
import { getConfigDir } from './config.js';

/**
 * Generate a combined CLAUDE.md for a group using `claude -p`.
 * Falls back to a concatenated template if the Claude CLI call fails.
 */
export function generateGroupClaudeMd(
  groupName: string,
  repoAliases: string[],
  config: WorkConfig,
): void {
  const outputPath = path.join(getConfigDir(), `${groupName}.claude.md`);

  // Build prompt with each repo's CLAUDE.md
  const promptParts: string[] = [];
  promptParts.push(
    'You are generating a CLAUDE.md file for a multi-repository workspace.',
  );
  promptParts.push(
    'The workspace contains the following repositories as subdirectories:',
  );
  promptParts.push('');

  for (const alias of repoAliases) {
    const repoPath = config.repos[alias];
    const repoName = path.basename(repoPath);
    const claudeMdPath = path.join(repoPath, 'CLAUDE.md');

    promptParts.push(`## Repository: ${repoName}/ (alias: ${alias})`);

    if (fs.existsSync(claudeMdPath)) {
      const content = fs.readFileSync(claudeMdPath, 'utf-8');
      promptParts.push('### CLAUDE.md contents:');
      promptParts.push('```');
      promptParts.push(content);
      promptParts.push('```');
    } else {
      promptParts.push('(no CLAUDE.md found)');
    }
    promptParts.push('');
  }

  promptParts.push('Generate a combined CLAUDE.md for this workspace that:');
  promptParts.push(
    '1. Explains the workspace structure (which subdirectories contain which repos)',
  );
  promptParts.push(
    "2. Merges and synthesizes the instructions from all repos' CLAUDE.md files",
  );
  promptParts.push(
    '3. Notes any cross-repo relationships or considerations',
  );
  promptParts.push(
    '4. Keeps all specific technical instructions (build commands, test commands, etc.) organized by repository',
  );
  promptParts.push('');
  promptParts.push(
    'Output ONLY the markdown content for the combined CLAUDE.md, with no additional commentary.',
  );

  const prompt = promptParts.join('\n');

  console.log(
    chalk.cyan(
      `Generating combined CLAUDE.md for group '${groupName}'...`,
    ),
  );
  console.log(
    chalk.gray('(This will call Claude to generate the combined file)'),
  );

  // Try claude -p
  const result = spawn.sync('claude', ['-p'], {
    input: prompt,
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  let content: string;

  if (result.status !== 0 || !result.stdout?.trim()) {
    console.log(
      chalk.yellow(
        'Failed to generate CLAUDE.md via Claude. Creating a basic template instead.',
      ),
    );
    content = buildFallbackTemplate(groupName, repoAliases, config);
  } else {
    content = result.stdout.trim();
  }

  fs.writeFileSync(outputPath, content, 'utf-8');
  console.log(chalk.green(`Saved: ${outputPath}`));
}

function buildFallbackTemplate(
  groupName: string,
  repoAliases: string[],
  config: WorkConfig,
): string {
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
    const claudeMdPath = path.join(repoPath, 'CLAUDE.md');

    parts.push(`### ${repoName}`);

    if (fs.existsSync(claudeMdPath)) {
      const content = fs.readFileSync(claudeMdPath, 'utf-8');
      parts.push(content);
    } else {
      parts.push('(no CLAUDE.md found)');
    }
    parts.push('');
  }

  return parts.join('\n');
}
