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
