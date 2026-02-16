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
  'work2 completion --shell powershell | Out-String | Invoke-Expression';
const BASH_COMPLETION_LINE = 'eval "$(work2 completion)"';
const MARKER = '# work2 tab completions';

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

    if (shell.includes('zsh')) {
      profiles.push({
        shell: 'Zsh',
        profilePath: path.join(home, '.zshrc'),
        completionLine: BASH_COMPLETION_LINE,
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

/** Idempotently install the completion line into a shell profile. */
export function installCompletionLine(profile: ShellProfile): CompletionResult {
  try {
    let createdFile = false;

    if (fs.existsSync(profile.profilePath)) {
      const content = fs.readFileSync(profile.profilePath, 'utf-8');
      if (content.includes(MARKER)) {
        return { profile, status: 'already-exists' };
      }
    } else {
      createdFile = true;
    }

    // Ensure parent directory exists
    fs.mkdirSync(path.dirname(profile.profilePath), { recursive: true });

    const snippet = `\n${MARKER}\n${profile.completionLine}\n`;
    fs.appendFileSync(profile.profilePath, snippet);

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
}
