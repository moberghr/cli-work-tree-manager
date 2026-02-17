import chalk from 'chalk';
import type { CommandModule } from 'yargs';
import {
  setupCompletions,
  printCompletionResults,
  printManualInstructions,
} from '../core/setup-completions.js';

const POWERSHELL_SCRIPT = `
Register-ArgumentCompleter -CommandName work2 -Native -ScriptBlock {
    param($wordToComplete, $commandAst, $cursorPosition)

    # When $wordToComplete is non-empty, the last CommandElement IS that word.
    # Exclude it so we don't double-pass it.
    $endIdx = $commandAst.CommandElements.Count
    if ($wordToComplete -ne '') { $endIdx -= 1 }

    $completedArgs = @()
    for ($i = 1; $i -lt $endIdx; $i++) {
        $el = $commandAst.CommandElements[$i]
        if ($el -is [System.Management.Automation.Language.CommandParameterAst]) { continue }
        $completedArgs += $el.ToString()
    }

    $results = & work2 --get-yargs-completions work2 @completedArgs $wordToComplete 2>$null
    $results | ForEach-Object {
        if ($_.Trim()) {
            [System.Management.Automation.CompletionResult]::new($_, $_, 'ParameterValue', $_)
        }
    }
}
`.trim();

const BASH_SCRIPT = `
###-begin-work2-completions-###
_work2_yargs_completions()
{
    local cur_word args type_list
    cur_word="\${COMP_WORDS[COMP_CWORD]}"
    args=("\${COMP_WORDS[@]}")
    type_list=$(work2 --get-yargs-completions "\${args[@]}")
    COMPREPLY=( $(compgen -W "\${type_list}" -- \${cur_word}) )
    if [ \${#COMPREPLY[@]} -eq 0 ]; then
      COMPREPLY=()
    fi
    return 0
}
complete -o bashdefault -o default -F _work2_yargs_completions work2
###-end-work2-completions-###
`.trim();

const FISH_SCRIPT = `
# work2 tab completions
function __work2_complete
    set -l cmd (commandline -opc)
    set -l cur (commandline -ct)
    work2 --get-yargs-completions $cmd $cur 2>/dev/null
end

complete -c work2 -f -a '(__work2_complete)'
`.trim();

export const completionCommand: CommandModule = {
  command: 'completion',
  describe: 'Generate shell completion script',
  builder: (yargs) =>
    yargs
      .option('shell', {
        describe: 'Shell type',
        choices: ['bash', 'fish', 'powershell', 'ps'] as const,
        type: 'string',
      })
      .option('install', {
        describe: 'Install completions into shell profile(s)',
        type: 'boolean',
        default: false,
      }),
  handler: (argv) => {
    if (argv.install) {
      const results = setupCompletions();
      if (results.length > 0) {
        printCompletionResults(results);
        console.log('');
        console.log(
          chalk.gray('  Restart your shell for completions to take effect.'),
        );
      } else {
        printManualInstructions();
      }
      return;
    }

    const shell = argv.shell as string | undefined;

    if (shell === 'powershell' || shell === 'ps') {
      console.log(POWERSHELL_SCRIPT);
    } else if (shell === 'fish') {
      console.log(FISH_SCRIPT);
    } else {
      // Default to bash (also works for zsh)
      console.log(BASH_SCRIPT);
    }
  },
};
