import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import chalk from 'chalk';
import spawn from 'cross-spawn';

export interface ShellProfile {
  shell: string;
  profilePath: string;
  completionLine: string;
}

export type InstallResult =
  | 'installed'
  | 'created-file'
  | 'already-exists'
  | 'error';

export interface CompletionResult {
  profile: ShellProfile;
  status: InstallResult;
  error?: string;
}

const PS_COMPLETION_LINE =
  'work completion --shell powershell | Out-String | Invoke-Expression';
const BASH_COMPLETION_LINE = 'eval "$(work completion)"';
const ZSH_COMPLETION_LINE = 'eval "$(work completion --shell zsh)"';
const FISH_COMPLETION_SCRIPT = `# work tab completions
function __work_complete
    set -l cmd (commandline -opc)
    set -l cur (commandline -ct)
    work --get-yargs-completions $cmd $cur 2>/dev/null
end

complete -c work -f -a '(__work_complete)'`;
const MARKER = '# work tab completions';
const LEGACY_MARKER = '# work2 tab completions';

/** Get the Windows Documents folder, handling OneDrive redirection. */
function getWindowsDocumentsFolder(): string | null {
  // Try pwsh first, fall back to powershell.exe
  for (const exe of ['pwsh', 'powershell']) {
    const result = spawn.sync(
      exe,
      ['-NoProfile', '-Command', "[Environment]::GetFolderPath('MyDocuments')"],
      { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] },
    );
    if (result.status === 0 && result.stdout) {
      const dir = result.stdout.toString().trim();
      if (dir) return dir;
    }
  }
  return null;
}

/** Check if an executable exists on PATH. */
function executableExists(name: string): boolean {
  const cmd = process.platform === 'win32' ? 'where' : 'which';
  const result = spawn.sync(cmd, [name], {
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  return result.status === 0;
}

/** Detect available shell profiles for completion installation. */
export function detectShellProfiles(): ShellProfile[] {
  const profiles: ShellProfile[] = [];

  if (process.platform === 'win32') {
    const docs = getWindowsDocumentsFolder();
    if (!docs) return profiles;

    if (executableExists('pwsh')) {
      profiles.push({
        shell: 'PowerShell 7',
        profilePath: path.join(
          docs,
          'PowerShell',
          'Microsoft.PowerShell_profile.ps1',
        ),
        completionLine: PS_COMPLETION_LINE,
      });
    }

    if (executableExists('powershell')) {
      profiles.push({
        shell: 'PowerShell 5.1',
        profilePath: path.join(
          docs,
          'WindowsPowerShell',
          'Microsoft.PowerShell_profile.ps1',
        ),
        completionLine: PS_COMPLETION_LINE,
      });
    }
  } else {
    const shell = process.env.SHELL ?? '';
    const home = os.homedir();

    if (shell.includes('fish')) {
      // Fish uses a dedicated completions directory
      const fishConfigDir = process.env.XDG_CONFIG_HOME
        ? path.join(process.env.XDG_CONFIG_HOME, 'fish')
        : path.join(home, '.config', 'fish');
      profiles.push({
        shell: 'Fish',
        profilePath: path.join(fishConfigDir, 'completions', 'work.fish'),
        completionLine: FISH_COMPLETION_SCRIPT,
      });
    } else if (shell.includes('zsh')) {
      profiles.push({
        shell: 'Zsh',
        profilePath: path.join(home, '.zshrc'),
        completionLine: ZSH_COMPLETION_LINE,
      });
    } else if (shell.includes('bash')) {
      profiles.push({
        shell: 'Bash',
        profilePath: path.join(home, '.bashrc'),
        completionLine: BASH_COMPLETION_LINE,
      });
    }
  }

  return profiles;
}

/**
 * Strip a legacy `work2` completion block from a non-fish profile. Matches the
 * marker line and the next line (the install command). Returns content unchanged
 * if no legacy block is present.
 */
function stripLegacyBlock(content: string): string {
  if (!content.includes(LEGACY_MARKER)) return content;
  const lines = content.split(/\r?\n/);
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === LEGACY_MARKER) {
      // Skip marker line and the following install line (if present)
      if (i + 1 < lines.length && /work2\b/.test(lines[i + 1])) i++;
      continue;
    }
    out.push(lines[i]);
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n');
}

/** Idempotently install the completion line into a shell profile. */
export function installCompletionLine(profile: ShellProfile): CompletionResult {
  try {
    let createdFile = false;
    const isFish = profile.shell === 'Fish';

    let existingContent = '';
    if (fs.existsSync(profile.profilePath)) {
      existingContent = fs.readFileSync(profile.profilePath, 'utf-8');
      if (existingContent.includes(MARKER)) {
        return { profile, status: 'already-exists' };
      }
    } else {
      createdFile = true;
    }

    // Ensure parent directory exists
    fs.mkdirSync(path.dirname(profile.profilePath), { recursive: true });

    if (isFish) {
      // Fish: write the complete completion script to its own file
      fs.writeFileSync(profile.profilePath, profile.completionLine + '\n');
    } else {
      // Bash/Zsh/PowerShell: strip any legacy `work2` block, then append new one.
      const cleaned = stripLegacyBlock(existingContent);
      const snippet = `\n${MARKER}\n${profile.completionLine}\n`;
      fs.writeFileSync(profile.profilePath, cleaned + snippet);
    }

    return { profile, status: createdFile ? 'created-file' : 'installed' };
  } catch (err) {
    return {
      profile,
      status: 'error',
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/** Detect shells and install completions into each profile. */
export function setupCompletions(): CompletionResult[] {
  const profiles = detectShellProfiles();
  return profiles.map((p) => installCompletionLine(p));
}

/** Print colored results for each completion installation. */
export function printCompletionResults(results: CompletionResult[]): void {
  for (const r of results) {
    const label = `${r.profile.shell} (${r.profile.profilePath})`;

    switch (r.status) {
      case 'installed':
        console.log(chalk.green(`  ✓ ${label} — completions added`));
        break;
      case 'created-file':
        console.log(
          chalk.green(`  ✓ ${label} — profile created with completions`),
        );
        break;
      case 'already-exists':
        console.log(chalk.gray(`  · ${label} — already has completions`));
        break;
      case 'error':
        console.log(chalk.red(`  ✗ ${label} — ${r.error}`));
        break;
    }
  }
}

/** Print manual instructions when no shells are detected. */
export function printManualInstructions(): void {
  console.log(
    chalk.yellow(
      '  Could not detect shell profiles. Add completions manually:',
    ),
  );
  console.log('');
  console.log(chalk.gray('  PowerShell — add to $PROFILE:'));
  console.log(`    ${PS_COMPLETION_LINE}`);
  console.log('');
  console.log(chalk.gray('  Bash/Zsh — add to ~/.bashrc or ~/.zshrc:'));
  console.log(`    ${BASH_COMPLETION_LINE}`);
  console.log('');
  console.log(chalk.gray('  Fish — run:'));
  console.log(`    work completion --shell fish > ~/.config/fish/completions/work.fish`);
}
