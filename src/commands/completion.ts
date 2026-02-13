import type { CommandModule } from 'yargs';

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

export const completionCommand: CommandModule = {
  command: 'completion',
  describe: 'Generate shell completion script',
  builder: (yargs) =>
    yargs.option('shell', {
      describe: 'Shell type',
      choices: ['bash', 'powershell', 'ps'] as const,
      type: 'string',
    }),
  handler: (argv) => {
    const shell = argv.shell as string | undefined;

    if (shell === 'powershell' || shell === 'ps') {
      console.log(POWERSHELL_SCRIPT);
    } else {
      // Default to bash (also works for zsh)
      console.log(BASH_SCRIPT);
    }
  },
};
