# Work - Git Worktree Manager for Multiple Repositories
# A flexible tool for managing git worktrees across multiple projects

# Get config file path
function Get-WorkConfigPath {
    $configDir = Join-Path $env:USERPROFILE ".work"
    if (-not (Test-Path $configDir)) {
        New-Item -ItemType Directory -Path $configDir -Force | Out-Null
    }
    return Join-Path $configDir "config.json"
}

# Load configuration
function Get-WorkConfig {
    $configPath = Get-WorkConfigPath
    if (-not (Test-Path $configPath)) {
        return $null
    }

    try {
        $config = Get-Content $configPath -Raw | ConvertFrom-Json
        return $config
    } catch {
        Write-Error "Failed to parse config file: $configPath"
        return $null
    }
}

# Save configuration
function Set-WorkConfig {
    param([PSCustomObject]$Config)

    $configPath = Get-WorkConfigPath
    $Config | ConvertTo-Json -Depth 10 | Set-Content $configPath -Encoding UTF8
}

# Safely read groups from config (backward compatible with old configs)
function Get-ConfigGroups {
    param([PSCustomObject]$Config)

    if (-not $Config -or -not ($Config.PSObject.Properties.Name -contains 'groups')) {
        return [PSCustomObject]@{}
    }

    return $Config.groups
}

# Resolve whether a name is a group or single repo
function Resolve-ProjectTarget {
    param(
        [string]$Name,
        [PSCustomObject]$Config
    )

    $groups = Get-ConfigGroups -Config $Config

    # Check if it's a group
    if ($groups.PSObject.Properties.Name -contains $Name) {
        $repoAliases = @($groups.$Name)
        return [PSCustomObject]@{
            IsGroup     = $true
            Name        = $Name
            RepoAliases = $repoAliases
        }
    }

    # Check if it's a repo
    if ($Config.repos.PSObject.Properties.Name -contains $Name) {
        return [PSCustomObject]@{
            IsGroup     = $false
            Name        = $Name
            RepoAliases = @($Name)
        }
    }

    return $null
}

# Create a single git worktree with config file copying
# Returns $true on success, $false on failure. Does NOT cd or launch Claude.
function New-SingleWorktree {
    param(
        [string]$RepoPath,
        [string]$WorkTreePath,
        [string]$BranchName,
        [PSCustomObject]$Config
    )

    # Check if the worktree already exists at the target path (idempotent re-run)
    if (Test-Path $WorkTreePath) {
        Push-Location $WorkTreePath
        $isValidWorktree = git rev-parse --is-inside-work-tree 2>$null
        $currentBranch = git branch --show-current 2>$null
        Pop-Location

        if ($isValidWorktree -and $currentBranch -eq $BranchName) {
            Write-Host "  Worktree already exists at: $WorkTreePath" -ForegroundColor Yellow
            return $true
        }
    }

    Push-Location $RepoPath

    # Check if the branch is already checked out in another worktree
    $worktreeData = @{}
    $currentWtPath = $null
    git worktree list --porcelain 2>$null | ForEach-Object {
        if ($_ -match "^worktree (.+)$") {
            $currentWtPath = $matches[1]
            $worktreeData[$currentWtPath] = @{ Path = $currentWtPath; Branch = "" }
        } elseif ($_ -match "^branch refs/heads/(.+)$") {
            if ($currentWtPath) {
                $worktreeData[$currentWtPath].Branch = $matches[1]
            }
        }
    }

    $existingForBranch = $worktreeData.Values | Where-Object { $_.Branch -eq $BranchName } | Select-Object -First 1
    if ($existingForBranch -and $existingForBranch.Path -ne $WorkTreePath) {
        Write-Host "  Branch '$BranchName' is already checked out in a worktree at: $($existingForBranch.Path)" -ForegroundColor Red
        Write-Host "  Remove that worktree first, or use the existing one." -ForegroundColor Red
        Pop-Location
        return $false
    }

    # Create parent directory
    $parentDir = Split-Path $WorkTreePath -Parent
    if (-not (Test-Path $parentDir)) {
        New-Item -ItemType Directory -Path $parentDir | Out-Null
    }

    # Pull latest changes for current branch in main repo
    Write-Host "  Pulling latest changes for main repo..."
    $null = git pull --quiet 2>$null

    # Check if branch exists locally or remotely
    $null = git fetch --quiet 2>$null
    $localExists = git rev-parse --verify $BranchName 2>$null
    $remoteExists = git rev-parse --verify "origin/$BranchName" 2>$null

    # Pull latest changes if branch exists locally
    if ($localExists) {
        Write-Host "  Pulling latest changes for $BranchName..."
        $prevBranch = git branch --show-current
        $null = git checkout $BranchName --quiet 2>$null
        $null = git pull --quiet 2>$null
        $null = git checkout $prevBranch --quiet 2>$null
    }

    # Create worktree
    if ($localExists -or $remoteExists) {
        if ($remoteExists -and -not $localExists) {
            git worktree add $WorkTreePath -b $BranchName --track "origin/$BranchName"
        } else {
            git worktree add $WorkTreePath $BranchName
        }
    } else {
        git worktree add $WorkTreePath -b $BranchName
    }

    if ($LASTEXITCODE -ne 0) {
        Write-Host "  Failed to create worktree" -ForegroundColor Red
        Pop-Location
        return $false
    }

    # Copy configuration files from main repo based on config
    if ($Config.copyFiles) {
        foreach ($pattern in $Config.copyFiles) {
            # Handle .claude directory specially
            if ($pattern -like ".claude\*") {
                $claudeFile = $pattern -replace "^\.claude\\", ""
                $claudeSettingsSource = Join-Path $RepoPath ".claude" | Join-Path -ChildPath $claudeFile
                if (Test-Path $claudeSettingsSource) {
                    $claudeDir = Join-Path $WorkTreePath ".claude"
                    if (-not (Test-Path $claudeDir)) {
                        New-Item -ItemType Directory -Path $claudeDir -Force | Out-Null
                    }
                    $claudeSettingsDest = Join-Path $claudeDir $claudeFile
                    Copy-Item $claudeSettingsSource $claudeSettingsDest -Force
                    Write-Host "  Copied: .claude\$claudeFile"
                }
                continue
            }

            $files = Get-ChildItem -Path $RepoPath -Filter $pattern -Recurse -ErrorAction SilentlyContinue |
                Where-Object {
                    $_.FullName -notlike "*\bin\*" -and
                    $_.FullName -notlike "*\obj\*" -and
                    $_.FullName -notlike "*\node_modules\*" -and
                    $_.FullName -notlike "*\.git\*"
                }

            foreach ($file in $files) {
                $relativePath = $file.FullName.Substring($RepoPath.Length + 1)
                $destPath = Join-Path $WorkTreePath $relativePath
                $destDir = Split-Path $destPath -Parent

                if (-not (Test-Path $destDir)) {
                    New-Item -ItemType Directory -Path $destDir -Force | Out-Null
                }

                Copy-Item $file.FullName $destPath -Force
                Write-Host "  Copied: $relativePath"
            }
        }
    }

    Pop-Location
    Write-Host "  Created worktree: $WorkTreePath" -ForegroundColor Green
    return $true
}

# Remove a single git worktree
# Returns $true on success, $false if blocked (uncommitted/unpushed changes)
function Remove-SingleWorktree {
    param(
        [string]$RepoPath,
        [string]$WorkTreePath,
        [string]$BranchName,
        [switch]$Force
    )

    if (-not (Test-Path $WorkTreePath)) {
        Write-Host "  Worktree does not exist at: $WorkTreePath" -ForegroundColor Yellow
        return $true  # Nothing to remove is success
    }

    Push-Location $RepoPath

    # Check if it's a valid git worktree
    Push-Location $WorkTreePath
    $isValidWorktree = git rev-parse --is-inside-work-tree 2>$null
    Pop-Location

    if (-not $isValidWorktree) {
        Remove-Item -Path $WorkTreePath -Recurse -Force
        $null = git worktree prune
        Write-Host "  Removed invalid worktree directory: $WorkTreePath"
        Pop-Location
        return $true
    }

    if (-not $Force) {
        Push-Location $WorkTreePath

        $status = git status --porcelain
        if ($status) {
            Write-Host "  Uncommitted changes in: $WorkTreePath" -ForegroundColor Yellow
            Write-Host $status
            Pop-Location
            Pop-Location
            return $false
        }

        $currentBranch = git branch --show-current
        $upstream = git rev-parse --abbrev-ref "$currentBranch@{upstream}" 2>$null
        if ($LASTEXITCODE -eq 0) {
            $unpushed = git log --oneline "$upstream..HEAD"
            if ($unpushed) {
                Write-Host "  Unpushed commits in: $WorkTreePath" -ForegroundColor Yellow
                Write-Host $unpushed
                Pop-Location
                Pop-Location
                return $false
            }
        }

        Pop-Location
    }

    if ($Force) {
        git worktree remove $WorkTreePath --force
    } else {
        git worktree remove $WorkTreePath
    }

    if ($LASTEXITCODE -eq 0) {
        Write-Host "  Removed worktree: $WorkTreePath" -ForegroundColor Green
        Pop-Location
        return $true
    } else {
        Write-Host "  Failed to remove worktree: $WorkTreePath" -ForegroundColor Red
        Pop-Location
        return $false
    }
}

# Generate a combined CLAUDE.md for a group using claude -p
function Generate-GroupClaudeMd {
    param(
        [string]$GroupName,
        [string[]]$RepoAliases,
        [PSCustomObject]$Config
    )

    $workDir = Join-Path $env:USERPROFILE ".work"
    $outputPath = Join-Path $workDir "$GroupName.claude.md"

    # Build prompt with each repo's CLAUDE.md
    $promptParts = @()
    $promptParts += "You are generating a CLAUDE.md file for a multi-repository workspace."
    $promptParts += "The workspace contains the following repositories as subdirectories:"
    $promptParts += ""

    foreach ($alias in $RepoAliases) {
        $repoPath = $Config.repos.$alias
        $repoName = Split-Path $repoPath -Leaf
        $claudeMdPath = Join-Path $repoPath "CLAUDE.md"

        $promptParts += "## Repository: $repoName/ (alias: $alias)"

        if (Test-Path $claudeMdPath) {
            $content = Get-Content $claudeMdPath -Raw
            $promptParts += "### CLAUDE.md contents:"
            $promptParts += '```'
            $promptParts += $content
            $promptParts += '```'
        } else {
            $promptParts += "(no CLAUDE.md found)"
        }
        $promptParts += ""
    }

    $promptParts += "Generate a combined CLAUDE.md for this workspace that:"
    $promptParts += "1. Explains the workspace structure (which subdirectories contain which repos)"
    $promptParts += "2. Merges and synthesizes the instructions from all repos' CLAUDE.md files"
    $promptParts += "3. Notes any cross-repo relationships or considerations"
    $promptParts += "4. Keeps all specific technical instructions (build commands, test commands, etc.) organized by repository"
    $promptParts += ""
    $promptParts += "Output ONLY the markdown content for the combined CLAUDE.md, with no additional commentary."

    $prompt = $promptParts -join "`n"

    Write-Host "Generating combined CLAUDE.md for group '$GroupName'..." -ForegroundColor Cyan
    Write-Host "(This will call Claude to generate the combined file)" -ForegroundColor Gray

    $result = $prompt | claude -p 2>$null

    if ($LASTEXITCODE -ne 0 -or -not $result) {
        Write-Host "Failed to generate CLAUDE.md via Claude. Creating a basic template instead." -ForegroundColor Yellow

        # Fallback: create a basic template
        $templateParts = @()
        $templateParts += "# Multi-Repository Workspace: $GroupName"
        $templateParts += ""
        $templateParts += "This workspace contains the following repositories:"
        $templateParts += ""
        foreach ($alias in $RepoAliases) {
            $repoPath = $Config.repos.$alias
            $repoName = Split-Path $repoPath -Leaf
            $templateParts += "- **$repoName/** (alias: $alias)"
        }
        $templateParts += ""
        $templateParts += "## Per-Repository Instructions"
        $templateParts += ""
        foreach ($alias in $RepoAliases) {
            $repoPath = $Config.repos.$alias
            $repoName = Split-Path $repoPath -Leaf
            $claudeMdPath = Join-Path $repoPath "CLAUDE.md"
            $templateParts += "### $repoName"
            if (Test-Path $claudeMdPath) {
                $content = Get-Content $claudeMdPath -Raw
                $templateParts += $content
            } else {
                $templateParts += "(no CLAUDE.md found)"
            }
            $templateParts += ""
        }

        $result = $templateParts -join "`n"
    }

    $result | Set-Content $outputPath -Encoding UTF8
    Write-Host "Saved: $outputPath" -ForegroundColor Green
}

# Initialize work configuration
function Initialize-Work {
    Write-Host ""
    Write-Host "Welcome to Work - Git Worktree Manager" -ForegroundColor Cyan
    Write-Host "======================================" -ForegroundColor Cyan
    Write-Host ""

    # Check if config already exists
    $configPath = Get-WorkConfigPath
    if (Test-Path $configPath) {
        Write-Host "Configuration file already exists at: $configPath" -ForegroundColor Yellow
        $overwrite = Read-Host "Do you want to reconfigure? This will keep existing repos. (y/n)"
        if ($overwrite -ne 'y') {
            Write-Host "Initialization cancelled."
            return
        }
    }

    # Get or keep existing config
    $config = Get-WorkConfig
    if (-not $config) {
        $config = [PSCustomObject]@{
            worktreesRoot = ""
            repos = @{}
            groups = @{}
            copyFiles = @("*.Development.json", "*.Local.json", ".claude\settings.local.json")
        }
    }

    # Configure worktrees root
    Write-Host "Where should all worktrees be created?" -ForegroundColor Green
    $defaultWorktreesRoot = Join-Path (Split-Path $env:USERPROFILE) "worktrees"
    if ($config.worktreesRoot) {
        $defaultWorktreesRoot = $config.worktreesRoot
    }
    Write-Host "Default: $defaultWorktreesRoot"
    $worktreesInput = Read-Host "Press Enter to accept or type a custom path"

    if ([string]::IsNullOrWhiteSpace($worktreesInput)) {
        $config.worktreesRoot = $defaultWorktreesRoot
    } else {
        $config.worktreesRoot = $worktreesInput
    }

    Write-Host ""
    Write-Host "Great! Worktrees will be created in: $($config.worktreesRoot)" -ForegroundColor Green
    Write-Host ""

    # Add repositories
    Write-Host "Now let's add your repositories." -ForegroundColor Green
    Write-Host "(You can add more later with: work config add <alias> <path>)" -ForegroundColor Gray
    Write-Host ""

    $repoCount = 1
    $addMore = $true

    while ($addMore) {
        Write-Host "Repository #${repoCount}:" -ForegroundColor Yellow

        $alias = Read-Host "  Alias (short name, e.g., 'ai', 'frontend')"
        if ([string]::IsNullOrWhiteSpace($alias)) {
            Write-Host "Alias cannot be empty. Skipping." -ForegroundColor Red
            continue
        }

        $repoPath = Read-Host "  Repository path"
        if ([string]::IsNullOrWhiteSpace($repoPath)) {
            Write-Host "Repository path cannot be empty. Skipping." -ForegroundColor Red
            continue
        }

        # Validate repository path
        if (-not (Test-Path $repoPath)) {
            Write-Host "Path does not exist: $repoPath" -ForegroundColor Red
            continue
        }

        # Check if it's a git repository
        Push-Location $repoPath
        $isGitRepo = git rev-parse --is-inside-work-tree 2>$null
        Pop-Location

        if (-not $isGitRepo) {
            Write-Host "Path is not a git repository: $repoPath" -ForegroundColor Red
            continue
        }

        # Add to config
        $config.repos | Add-Member -NotePropertyName $alias -NotePropertyValue $repoPath -Force
        Write-Host "  Added: $alias -> $repoPath" -ForegroundColor Green
        Write-Host ""

        $repoCount++

        $response = Read-Host "Add another repository? (y/n)"
        $addMore = $response -eq 'y'
    }

    # Save configuration
    Set-WorkConfig -Config $config

    Write-Host ""
    Write-Host "Configuration saved to: $configPath" -ForegroundColor Green
    Write-Host ""
    Write-Host "You're all set! Try: work tree <project> feature/my-branch" -ForegroundColor Cyan
    Write-Host ""
}

# Manage work configuration
function Manage-WorkConfig {
    param(
        [Parameter(Mandatory=$false)]
        [string]$Action,
        [Parameter(Mandatory=$false)]
        [string]$Alias,
        [Parameter(Mandatory=$false)]
        [string]$Path,
        [Parameter(Mandatory=$false)]
        [string[]]$RemainingArgs
    )

    $config = Get-WorkConfig

    # Default to 'list' if no action provided
    if ([string]::IsNullOrWhiteSpace($Action)) {
        $Action = "list"
    }

    switch ($Action) {
        "add" {
            if ([string]::IsNullOrWhiteSpace($Alias) -or [string]::IsNullOrWhiteSpace($Path)) {
                Write-Error "Usage: work config add <alias> <path>"
                return
            }

            if (-not (Test-Path $Path)) {
                Write-Error "Path does not exist: $Path"
                return
            }

            # Check if it's a git repository
            Push-Location $Path
            $isGitRepo = git rev-parse --is-inside-work-tree 2>$null
            Pop-Location

            if (-not $isGitRepo) {
                Write-Error "Path is not a git repository: $Path"
                return
            }

            if (-not $config) {
                Write-Error "Configuration not initialized. Run 'work init' first."
                return
            }

            $config.repos | Add-Member -NotePropertyName $Alias -NotePropertyValue $Path -Force
            Set-WorkConfig -Config $config
            Write-Host "Added: $Alias -> $Path" -ForegroundColor Green
        }

        "list" {
            if (-not $config) {
                Write-Host "No configuration found. Run 'work init' to set up." -ForegroundColor Yellow
                return
            }

            Write-Host ""
            Write-Host "Work Configuration" -ForegroundColor Cyan
            Write-Host "==================" -ForegroundColor Cyan
            Write-Host "Worktrees Root: $($config.worktreesRoot)" -ForegroundColor Green
            Write-Host ""
            Write-Host "Repositories:" -ForegroundColor Green

            if ($config.repos.PSObject.Properties.Count -eq 0) {
                Write-Host "  (none configured)" -ForegroundColor Gray
            } else {
                $config.repos.PSObject.Properties | ForEach-Object {
                    Write-Host "  $($_.Name) -> $($_.Value)" -ForegroundColor White
                }
            }
            Write-Host ""

            # Show groups
            $groups = Get-ConfigGroups -Config $config
            Write-Host "Groups:" -ForegroundColor Green
            if ($groups.PSObject.Properties.Count -eq 0) {
                Write-Host "  (none configured)" -ForegroundColor Gray
            } else {
                $groups.PSObject.Properties | ForEach-Object {
                    $aliases = @($_.Value) -join ', '
                    Write-Host "  $($_.Name) -> [$aliases]" -ForegroundColor White
                }
            }
            Write-Host ""
        }

        "remove" {
            if ([string]::IsNullOrWhiteSpace($Alias)) {
                Write-Error "Usage: work config remove <alias>"
                return
            }

            if (-not $config) {
                Write-Error "Configuration not initialized."
                return
            }

            if (-not ($config.repos.PSObject.Properties.Name -contains $Alias)) {
                Write-Error "Repository alias not found: $Alias"
                return
            }

            $config.repos.PSObject.Properties.Remove($Alias)
            Set-WorkConfig -Config $config
            Write-Host "Removed: $Alias" -ForegroundColor Green
        }

        "addgroup" {
            if ([string]::IsNullOrWhiteSpace($Alias)) {
                Write-Error "Usage: work config addgroup <name> <alias1> <alias2> [alias3...]"
                return
            }

            if (-not $config) {
                Write-Error "Configuration not initialized. Run 'work init' first."
                return
            }

            # Collect all repo aliases from $Path and $RemainingArgs
            $allAliases = @()
            if (-not [string]::IsNullOrWhiteSpace($Path)) {
                $allAliases += $Path
            }
            if ($RemainingArgs) {
                $allAliases += $RemainingArgs
            }

            if ($allAliases.Count -lt 2) {
                Write-Error "A group must contain at least 2 repository aliases."
                Write-Host "Usage: work config addgroup <name> <alias1> <alias2> [alias3...]" -ForegroundColor Yellow
                return
            }

            # Validate: all aliases exist in repos
            foreach ($a in $allAliases) {
                if (-not ($config.repos.PSObject.Properties.Name -contains $a)) {
                    Write-Error "Repository alias not found: $a"
                    Write-Host "Available aliases: $($config.repos.PSObject.Properties.Name -join ', ')" -ForegroundColor Yellow
                    return
                }
            }

            # Validate: group name doesn't collide with repo aliases
            if ($config.repos.PSObject.Properties.Name -contains $Alias) {
                Write-Error "Group name '$Alias' conflicts with an existing repository alias."
                return
            }

            # Validate: group name doesn't collide with repo folder names
            $repoFolderNames = $config.repos.PSObject.Properties | ForEach-Object { Split-Path $_.Value -Leaf }
            if ($repoFolderNames -contains $Alias) {
                Write-Error "Group name '$Alias' conflicts with a repository folder name."
                return
            }

            # Add groups property if missing
            if (-not ($config.PSObject.Properties.Name -contains 'groups')) {
                $config | Add-Member -NotePropertyName 'groups' -NotePropertyValue ([PSCustomObject]@{}) -Force
            }

            # Add the group
            $config.groups | Add-Member -NotePropertyName $Alias -NotePropertyValue $allAliases -Force
            Set-WorkConfig -Config $config
            Write-Host "Added group: $Alias -> [$($allAliases -join ', ')]" -ForegroundColor Green

            # Generate combined CLAUDE.md
            Generate-GroupClaudeMd -GroupName $Alias -RepoAliases $allAliases -Config $config
        }

        "removegroup" {
            if ([string]::IsNullOrWhiteSpace($Alias)) {
                Write-Error "Usage: work config removegroup <name>"
                return
            }

            if (-not $config) {
                Write-Error "Configuration not initialized."
                return
            }

            $groups = Get-ConfigGroups -Config $config
            if (-not ($groups.PSObject.Properties.Name -contains $Alias)) {
                Write-Error "Group not found: $Alias"
                return
            }

            $config.groups.PSObject.Properties.Remove($Alias)
            Set-WorkConfig -Config $config

            # Delete the .claude.md file
            $claudeMdPath = Join-Path $env:USERPROFILE ".work" | Join-Path -ChildPath "$Alias.claude.md"
            if (Test-Path $claudeMdPath) {
                Remove-Item $claudeMdPath -Force
                Write-Host "Deleted: $claudeMdPath"
            }

            Write-Host "Removed group: $Alias" -ForegroundColor Green
        }

        "regengroup" {
            if ([string]::IsNullOrWhiteSpace($Alias)) {
                Write-Error "Usage: work config regengroup <name>"
                return
            }

            if (-not $config) {
                Write-Error "Configuration not initialized."
                return
            }

            $groups = Get-ConfigGroups -Config $config
            if (-not ($groups.PSObject.Properties.Name -contains $Alias)) {
                Write-Error "Group not found: $Alias"
                return
            }

            $repoAliases = @($groups.$Alias)
            Generate-GroupClaudeMd -GroupName $Alias -RepoAliases $repoAliases -Config $config
        }

        "show" {
            $configPath = Get-WorkConfigPath
            if (Test-Path $configPath) {
                Write-Host "Config file: $configPath" -ForegroundColor Green
                Write-Host ""
                Get-Content $configPath | Write-Host
            } else {
                Write-Host "No configuration file found. Run 'work init' to set up." -ForegroundColor Yellow
            }
        }

        "edit" {
            $configPath = Get-WorkConfigPath
            if (Test-Path $configPath) {
                Start-Process notepad.exe $configPath
            } else {
                Write-Error "No configuration file found. Run 'work init' first."
            }
        }

        default {
            Write-Host "Usage: work config <action>" -ForegroundColor Yellow
            Write-Host ""
            Write-Host "Actions:" -ForegroundColor Green
            Write-Host "  add <alias> <path>                    - Add a repository"
            Write-Host "  list                                  - List all configured repositories and groups"
            Write-Host "  remove <alias>                        - Remove a repository"
            Write-Host "  addgroup <name> <alias1> <alias2> ... - Create a repository group"
            Write-Host "  removegroup <name>                    - Remove a repository group"
            Write-Host "  regengroup <name>                     - Regenerate group CLAUDE.md"
            Write-Host "  show                                  - Show configuration file contents"
            Write-Host "  edit                                  - Open configuration file in editor"
        }
    }
}

# List worktrees
function List-Worktrees {
    param(
        [Parameter(Mandatory=$false)]
        [string]$Project
    )

    $config = Get-WorkConfig
    if (-not $config) {
        Write-Error "Configuration not found. Run 'work init' to set up."
        return
    }

    $groups = Get-ConfigGroups -Config $config
    $worktreesRoot = $config.worktreesRoot

    Write-Host ""
    Write-Host "Worktrees" -ForegroundColor Cyan
    Write-Host "=========" -ForegroundColor Cyan
    Write-Host ""

    # Determine what to list
    $showRepos = @()
    $showGroups = @()

    if ($Project) {
        $target = Resolve-ProjectTarget -Name $Project -Config $config
        if (-not $target) {
            $allNames = @($config.repos.PSObject.Properties.Name) + @($groups.PSObject.Properties.Name)
            Write-Error "Project or group not found: $Project"
            Write-Host "Available: $($allNames -join ', ')" -ForegroundColor Yellow
            return
        }
        if ($target.IsGroup) {
            $showGroups = @($Project)
        } else {
            $showRepos = @($Project)
        }
    } else {
        $showRepos = @($config.repos.PSObject.Properties.Name)
        $showGroups = @($groups.PSObject.Properties.Name)
    }

    $foundAny = $false

    # Show per-repo worktrees
    foreach ($proj in $showRepos) {
        $repoPath = $config.repos.$proj

        if (-not (Test-Path $repoPath)) {
            Write-Host "$proj -> Repository path not found: $repoPath" -ForegroundColor Red
            continue
        }

        Push-Location $repoPath

        # Parse worktree list output properly
        $worktreeList = @()
        $currentWorktree = @{}

        git worktree list --porcelain 2>$null | ForEach-Object {
            if ($_ -match "^worktree (.+)$") {
                if ($currentWorktree.Count -gt 0) {
                    $worktreeList += [PSCustomObject]$currentWorktree
                }
                $currentWorktree = @{ Path = $matches[1]; Branch = ""; HEAD = "" }
            } elseif ($_ -match "^HEAD (.+)$") {
                $currentWorktree.HEAD = $matches[1].Substring(0, 7)
            } elseif ($_ -match "^branch (.+)$") {
                $currentWorktree.Branch = $matches[1] -replace "^refs/heads/", ""
            }
        }

        # Add last worktree
        if ($currentWorktree.Count -gt 0) {
            $worktreeList += [PSCustomObject]$currentWorktree
        }

        Pop-Location

        # Filter out the main repo worktree
        $worktreeList = $worktreeList | Where-Object { $_.Path -ne $repoPath }

        if ($worktreeList.Count -gt 0) {
            $foundAny = $true
            Write-Host "$proj ($($worktreeList.Count) worktree$(if($worktreeList.Count -ne 1){'s'})):" -ForegroundColor Green

            foreach ($wt in $worktreeList) {
                $branchDisplay = if ($wt.Branch) { $wt.Branch } else { "detached at $($wt.HEAD)" }
                Write-Host "  $branchDisplay" -ForegroundColor White
                Write-Host "    $($wt.Path)" -ForegroundColor Gray
            }
            Write-Host ""
        }
    }

    # Show group worktrees
    foreach ($groupName in $showGroups) {
        $groupDir = Join-Path $worktreesRoot $groupName
        if (-not (Test-Path $groupDir)) { continue }

        $branchDirs = Get-ChildItem -Path $groupDir -Directory -ErrorAction SilentlyContinue
        if (-not $branchDirs -or $branchDirs.Count -eq 0) { continue }

        $foundAny = $true
        Write-Host "$groupName [group] ($($branchDirs.Count) worktree$(if($branchDirs.Count -ne 1){'s'})):" -ForegroundColor Magenta

        foreach ($bd in $branchDirs) {
            # Try to determine the actual branch name from a sub-worktree
            $repoSubDirs = Get-ChildItem -Path $bd.FullName -Directory -ErrorAction SilentlyContinue |
                Where-Object { $_.Name -ne '.git' -and $_.Name -ne 'CLAUDE.md' }

            $actualBranch = $null
            foreach ($rd in $repoSubDirs) {
                Push-Location $rd.FullName
                $b = git branch --show-current 2>$null
                Pop-Location
                if ($b) { $actualBranch = $b; break }
            }

            $displayBranch = if ($actualBranch) { $actualBranch } else { $bd.Name }
            Write-Host "  $displayBranch" -ForegroundColor White
            Write-Host "    $($bd.FullName)" -ForegroundColor Gray
            $repoNames = ($repoSubDirs | ForEach-Object { $_.Name }) -join ', '
            if ($repoNames) {
                Write-Host "    Repos: $repoNames" -ForegroundColor DarkGray
            }
        }
        Write-Host ""
    }

    if (-not $foundAny) {
        if ($Project) {
            Write-Host "No worktrees found for: $Project" -ForegroundColor Yellow
        } else {
            Write-Host "No worktrees found for any project or group" -ForegroundColor Yellow
        }
        Write-Host ""
    }
}

# Main work function (simple function — no [Parameter()] attrs — so $args captures extra positional args
# and ValueFromRemainingArguments doesn't pollute tab-completion with filesystem paths)
function work {
    param(
        [string]$Command,
        [string]$Project,
        [string]$BranchName,
        [string]$Action,
        [switch]$Force,
        [switch]$Unsafe
    )

    # Show help if no parameters
    if ([string]::IsNullOrWhiteSpace($Command)) {
        Write-Host ""
        Write-Host "Work - Git Worktree Manager" -ForegroundColor Cyan
        Write-Host "============================" -ForegroundColor Cyan
        Write-Host ""
        Write-Host "Usage:" -ForegroundColor Green
        Write-Host "  work init                                          - Set up configuration"
        Write-Host "  work config <action>                               - Manage configuration"
        Write-Host "  work list [project|group]                          - List all worktrees"
        Write-Host "  work tree <project|group> <branch>                 - Create/switch to worktree"
        Write-Host "  work tree <project|group> <branch> open            - Also open solution in IDE"
        Write-Host "  work tree <project|group> <branch> -Unsafe         - Skip Claude permission checks"
        Write-Host "  work remove <project|group> <branch>               - Remove worktree"
        Write-Host "  work remove <project|group> <branch> -Force        - Force remove worktree"
        Write-Host ""
        Write-Host "Config Actions:" -ForegroundColor Green
        Write-Host "  work config add <alias> <path>                     - Add a repository"
        Write-Host "  work config addgroup <name> <alias1> <alias2> ...  - Create a repository group"
        Write-Host "  work config removegroup <name>                     - Remove a repository group"
        Write-Host "  work config regengroup <name>                      - Regenerate group CLAUDE.md"
        Write-Host "  work config list                                   - List repos and groups"
        Write-Host ""
        Write-Host "Examples:" -ForegroundColor Green
        Write-Host "  work init"
        Write-Host "  work list"
        Write-Host "  work list ai"
        Write-Host "  work tree ai feature/login"
        Write-Host "  work tree frontend feature/login open"
        Write-Host "  work tree ai feature/hotfix -Unsafe"
        Write-Host "  work remove ai feature/login"
        Write-Host ""
        Write-Host "  # Groups (multi-repo worktrees):" -ForegroundColor DarkGray
        Write-Host "  work config addgroup fullstack api frontend"
        Write-Host "  work tree fullstack feature/login"
        Write-Host "  work remove fullstack feature/login"
        Write-Host "  work config regengroup fullstack"
        Write-Host ""
        return
    }

    # Handle init command
    if ($Command -eq "init") {
        Initialize-Work
        return
    }

    # Handle config command
    if ($Command -eq "config") {
        Manage-WorkConfig -Action $Project -Alias $BranchName -Path $Action -RemainingArgs $args
        return
    }

    # Handle list command
    if ($Command -eq "list") {
        List-Worktrees -Project $Project
        return
    }

    # Validate command
    if ($Command -ne "tree" -and $Command -ne "remove") {
        Write-Error "Unknown command: $Command"
        Write-Host "Valid commands: tree, remove, init, config, list" -ForegroundColor Yellow
        return
    }

    # Load configuration
    $config = Get-WorkConfig
    if (-not $config) {
        Write-Error "Configuration not found. Run 'work init' to set up."
        return
    }

    # Validate project/group name
    if ([string]::IsNullOrWhiteSpace($Project)) {
        $groups = Get-ConfigGroups -Config $config
        $allNames = @($config.repos.PSObject.Properties.Name) + @($groups.PSObject.Properties.Name)
        Write-Error "Project or group name is required"
        Write-Host "Usage: work $Command <project|group> <branch>" -ForegroundColor Yellow
        Write-Host "Available: $($allNames -join ', ')" -ForegroundColor Yellow
        return
    }

    # Resolve project target (group or single repo)
    $target = Resolve-ProjectTarget -Name $Project -Config $config
    if (-not $target) {
        $groups = Get-ConfigGroups -Config $config
        $allNames = @($config.repos.PSObject.Properties.Name) + @($groups.PSObject.Properties.Name)
        Write-Error "Project or group not found: $Project"
        Write-Host "Available: $($allNames -join ', ')" -ForegroundColor Yellow
        Write-Host "Add a new project with: work config add <alias> <path>" -ForegroundColor Yellow
        Write-Host "Add a new group with: work config addgroup <name> <alias1> <alias2> ..." -ForegroundColor Yellow
        return
    }

    # Validate branch name
    if ([string]::IsNullOrWhiteSpace($BranchName)) {
        Write-Error "Branch name is required"
        Write-Host "Usage: work $Command $Project <branch>" -ForegroundColor Yellow
        return
    }

    $worktreesRoot = $config.worktreesRoot
    $workTreeDirName = $BranchName -replace '/', '-'

    # ========== REMOVE COMMAND ==========
    if ($Command -eq "remove") {
        if ($target.IsGroup) {
            # --- Group remove ---
            $groupWorktreePath = Join-Path $worktreesRoot $target.Name | Join-Path -ChildPath $workTreeDirName

            if (-not (Test-Path $groupWorktreePath)) {
                Write-Error "Group worktree does not exist at: $groupWorktreePath"
                return
            }

            Write-Host "Removing group worktree: $Project/$BranchName" -ForegroundColor Cyan
            Write-Host ""

            $allRemoved = $true
            foreach ($alias in $target.RepoAliases) {
                $repoPath = $config.repos.$alias
                $repoName = Split-Path $repoPath -Leaf
                $subWorktreePath = Join-Path $groupWorktreePath $repoName

                Write-Host "[$alias] ($repoName):" -ForegroundColor Cyan
                $removed = Remove-SingleWorktree -RepoPath $repoPath -WorkTreePath $subWorktreePath -BranchName $BranchName -Force:$Force
                if (-not $removed) {
                    $allRemoved = $false
                }
            }

            if (-not $allRemoved) {
                Write-Host ""
                Write-Host "Some worktrees could not be removed due to uncommitted/unpushed changes." -ForegroundColor Yellow
                Write-Host "Use 'work remove $Project $BranchName -Force' to force remove all." -ForegroundColor Yellow
            }

            # Clean up CLAUDE.md in worktree
            $claudeMdInWorktree = Join-Path $groupWorktreePath "CLAUDE.md"
            if (Test-Path $claudeMdInWorktree) {
                Remove-Item $claudeMdInWorktree -Force
            }

            # Remove parent dir only if empty
            if ((Test-Path $groupWorktreePath) -and @(Get-ChildItem $groupWorktreePath).Count -eq 0) {
                Remove-Item $groupWorktreePath -Recurse -Force
                Write-Host "Cleaned up group directory: $groupWorktreePath" -ForegroundColor Green
            }
        } else {
            # --- Single repo remove ---
            $repoPath = $config.repos.$Project
            $repoName = Split-Path $repoPath -Leaf
            $workTreePath = Join-Path $worktreesRoot $repoName | Join-Path -ChildPath $workTreeDirName

            if (-not (Test-Path $workTreePath)) {
                Write-Error "Worktree does not exist at: $workTreePath"
                return
            }

            $removed = Remove-SingleWorktree -RepoPath $repoPath -WorkTreePath $workTreePath -BranchName $BranchName -Force:$Force
            if (-not $removed) {
                Write-Host ""
                Write-Host "Use 'work remove $Project $BranchName -Force' to force remove." -ForegroundColor Yellow
            }
        }
        return
    }

    # ========== TREE COMMAND ==========
    if ($Command -eq "tree") {
        if ($target.IsGroup) {
            # --- Group tree ---
            $groupWorktreePath = Join-Path $worktreesRoot $target.Name | Join-Path -ChildPath $workTreeDirName

            Write-Host "Creating group worktree: $Project/$BranchName" -ForegroundColor Cyan
            Write-Host "Directory: $groupWorktreePath" -ForegroundColor Gray
            Write-Host ""

            # Create parent directory
            if (-not (Test-Path $groupWorktreePath)) {
                New-Item -ItemType Directory -Path $groupWorktreePath -Force | Out-Null
            }

            $createdWorktrees = @()
            $allSuccess = $true

            foreach ($alias in $target.RepoAliases) {
                $repoPath = $config.repos.$alias
                $repoName = Split-Path $repoPath -Leaf
                $subWorktreePath = Join-Path $groupWorktreePath $repoName

                Write-Host "[$alias] ($repoName):" -ForegroundColor Cyan
                $success = New-SingleWorktree -RepoPath $repoPath -WorkTreePath $subWorktreePath -BranchName $BranchName -Config $config

                if ($success) {
                    $createdWorktrees += @{ RepoPath = $repoPath; WorkTreePath = $subWorktreePath; BranchName = $BranchName }
                } else {
                    $allSuccess = $false
                    break
                }
            }

            if (-not $allSuccess) {
                # Rollback already-created worktrees
                Write-Host ""
                Write-Host "Rolling back created worktrees due to failure..." -ForegroundColor Yellow
                foreach ($wt in $createdWorktrees) {
                    $null = Remove-SingleWorktree -RepoPath $wt.RepoPath -WorkTreePath $wt.WorkTreePath -BranchName $wt.BranchName -Force
                }
                # Clean up empty parent dir
                if ((Test-Path $groupWorktreePath) -and @(Get-ChildItem $groupWorktreePath).Count -eq 0) {
                    Remove-Item $groupWorktreePath -Recurse -Force
                }
                Write-Error "Failed to create group worktree. Changes have been rolled back."
                return
            }

            # Copy group CLAUDE.md to worktree root
            $groupClaudeMdSource = Join-Path $env:USERPROFILE ".work" | Join-Path -ChildPath "$($target.Name).claude.md"
            $groupClaudeMdDest = Join-Path $groupWorktreePath "CLAUDE.md"
            if (Test-Path $groupClaudeMdSource) {
                Copy-Item $groupClaudeMdSource $groupClaudeMdDest -Force
                Write-Host ""
                Write-Host "Copied group CLAUDE.md to worktree root" -ForegroundColor Green
            } else {
                Write-Host ""
                Write-Host "Warning: Group CLAUDE.md not found at $groupClaudeMdSource" -ForegroundColor Yellow
                Write-Host "Run 'work config regengroup $Project' to generate it." -ForegroundColor Yellow
            }

            Write-Host ""
            Write-Host "Branch: $BranchName"

            # Open solutions if requested
            if ($Action -eq "open") {
                foreach ($alias in $target.RepoAliases) {
                    $repoPath = $config.repos.$alias
                    $repoName = Split-Path $repoPath -Leaf
                    $subWorktreePath = Join-Path $groupWorktreePath $repoName

                    $slnFiles = Get-ChildItem -Path $subWorktreePath -Filter "*.sln" -Recurse | Select-Object -First 1
                    if ($slnFiles) {
                        Write-Host "Opening solution: $($slnFiles.FullName)"
                        Start-Process -FilePath $slnFiles.FullName -WorkingDirectory $subWorktreePath
                    }
                }
            }

            # cd to group parent and launch Claude
            Set-Location $groupWorktreePath
            Write-Host "Starting Claude Code..."

            if ($Unsafe) {
                claude --dangerously-skip-permissions
            } else {
                claude
            }
        } else {
            # --- Single repo tree ---
            $repoPath = $config.repos.$Project
            $repoName = Split-Path $repoPath -Leaf
            $workTreePath = Join-Path $worktreesRoot $repoName | Join-Path -ChildPath $workTreeDirName

            if (-not (Test-Path $repoPath)) {
                Write-Error "Repository path does not exist: $repoPath"
                return
            }

            Set-Location $repoPath

            # Check for existing worktree at any path (backward compat: reuse wherever it is)
            $worktreeData = @{}
            $currentWtPath = $null
            git worktree list --porcelain 2>$null | ForEach-Object {
                if ($_ -match "^worktree (.+)$") {
                    $currentWtPath = $matches[1]
                    $worktreeData[$currentWtPath] = @{ Path = $currentWtPath; Branch = "" }
                } elseif ($_ -match "^branch refs/heads/(.+)$") {
                    if ($currentWtPath) {
                        $worktreeData[$currentWtPath].Branch = $matches[1]
                    }
                }
            }

            $existingWorktree = $worktreeData.Values | Where-Object { $_.Branch -eq $BranchName } | Select-Object -First 1

            if ($existingWorktree) {
                Write-Host "Worktree already exists at: $($existingWorktree.Path)"
                Set-Location $existingWorktree.Path
                $workTreePath = $existingWorktree.Path
            } else {
                $success = New-SingleWorktree -RepoPath $repoPath -WorkTreePath $workTreePath -BranchName $BranchName -Config $config
                if (-not $success) {
                    return
                }
                Set-Location $workTreePath
            }

            Write-Host "Branch: $BranchName"

            # Open solution if requested
            if ($Action -eq "open") {
                $slnFiles = Get-ChildItem -Path $workTreePath -Filter "*.sln" -Recurse | Select-Object -First 1
                if ($slnFiles) {
                    Write-Host "Opening solution: $($slnFiles.FullName)"
                    Start-Process -FilePath $slnFiles.FullName -WorkingDirectory $workTreePath
                } else {
                    Write-Warning "No .sln file found in worktree"
                }
            }

            Write-Host "Starting Claude Code..."

            if ($Unsafe) {
                claude --dangerously-skip-permissions
            } else {
                claude
            }
        }
    }
}

# Single native completer — gives full control, no filesystem pollution
Register-ArgumentCompleter -CommandName work -Native -ScriptBlock {
    param($wordToComplete, $commandAst, $cursorPosition)

    # Extract positional args (skip 'work', skip switch parameters like -Force)
    $allElements = @()
    for ($i = 1; $i -lt $commandAst.CommandElements.Count; $i++) {
        $el = $commandAst.CommandElements[$i]
        if ($el -is [System.Management.Automation.Language.CommandParameterAst]) { continue }
        $allElements += @{ Text = $el.ToString(); Start = $el.Extent.StartOffset; End = $el.Extent.EndOffset }
    }

    # Handle switch completion (-Force, -Unsafe)
    if ($wordToComplete -like '-*') {
        $posArgs = $allElements | ForEach-Object { $_.Text }
        $command = if ($posArgs.Count -gt 0) { $posArgs[0] } else { $null }
        $switches = @()
        if ($command -eq 'tree') { $switches += '-Unsafe' }
        if ($command -eq 'tree' -or $command -eq 'remove') { $switches += '-Force' }
        $switches | Where-Object { $_ -like "$wordToComplete*" } | ForEach-Object {
            [System.Management.Automation.CompletionResult]::new($_, $_, 'ParameterValue', $_)
        }
        return
    }

    # Determine which positional index is being completed
    $completingIndex = $allElements.Count
    for ($i = 0; $i -lt $allElements.Count; $i++) {
        if ($cursorPosition -ge $allElements[$i].Start -and $cursorPosition -le $allElements[$i].End) {
            $completingIndex = $i
            break
        }
    }

    $posArgs = $allElements | ForEach-Object { $_.Text }

    # Position 0: Command
    if ($completingIndex -eq 0) {
        @('tree', 'remove', 'list', 'init', 'config') | Where-Object { $_ -like "$wordToComplete*" } | ForEach-Object {
            [System.Management.Automation.CompletionResult]::new($_, $_, 'ParameterValue', $_)
        }
        return
    }

    $command = if ($posArgs.Count -gt 0) { $posArgs[0] } else { return }

    # Position 1
    if ($completingIndex -eq 1) {
        if ($command -eq 'config') {
            @('add', 'list', 'remove', 'show', 'edit', 'addgroup', 'removegroup', 'regengroup') | Where-Object { $_ -like "$wordToComplete*" } | ForEach-Object {
                [System.Management.Automation.CompletionResult]::new($_, $_, 'ParameterValue', $_)
            }
            return
        }
        if ($command -eq 'init') { return }
        if ($command -eq 'tree' -or $command -eq 'remove' -or $command -eq 'list') {
            $config = Get-WorkConfig
            if (-not $config) { return }
            $config.repos.PSObject.Properties.Name | Where-Object { $_ -like "$wordToComplete*" } | ForEach-Object {
                [System.Management.Automation.CompletionResult]::new($_, $_, 'ParameterValue', $_)
            }
            $groups = Get-ConfigGroups -Config $config
            $groups.PSObject.Properties.Name | Where-Object { $_ -like "$wordToComplete*" } | ForEach-Object {
                [System.Management.Automation.CompletionResult]::new($_, $_, 'ParameterValue', "$_ [group]")
            }
        }
        return
    }

    $arg1 = if ($posArgs.Count -gt 1) { $posArgs[1] } else { $null }

    # Position 2+: config subcommands
    if ($command -eq 'config') {
        $config = Get-WorkConfig
        if (-not $config) { return }

        if ($completingIndex -eq 2) {
            if ($arg1 -eq 'remove') {
                # Repo alias completion
                $config.repos.PSObject.Properties.Name | Where-Object { $_ -like "$wordToComplete*" } | ForEach-Object {
                    [System.Management.Automation.CompletionResult]::new($_, $_, 'ParameterValue', $_)
                }
            } elseif ($arg1 -eq 'removegroup' -or $arg1 -eq 'regengroup') {
                # Group name completion
                $groups = Get-ConfigGroups -Config $config
                $groups.PSObject.Properties.Name | Where-Object { $_ -like "$wordToComplete*" } | ForEach-Object {
                    [System.Management.Automation.CompletionResult]::new($_, $_, 'ParameterValue', $_)
                }
            }
            # addgroup pos 2 = group name (user types it), add pos 2 = alias (user types it)
        } elseif ($completingIndex -eq 3 -and $arg1 -eq 'add') {
            # Directory completion for repo path
            [System.Management.Automation.CompletionCompleters]::CompleteFilename($wordToComplete) | ForEach-Object { $_ }
        } elseif ($completingIndex -ge 3 -and $arg1 -eq 'addgroup') {
            # Repo alias completion (excluding already used)
            $alreadyUsed = @()
            for ($i = 3; $i -lt $posArgs.Count; $i++) {
                if ($i -ne $completingIndex) { $alreadyUsed += $posArgs[$i] }
            }
            $config.repos.PSObject.Properties.Name | Where-Object {
                $_ -like "$wordToComplete*" -and $_ -notin $alreadyUsed
            } | ForEach-Object {
                [System.Management.Automation.CompletionResult]::new($_, $_, 'ParameterValue', $_)
            }
        }
        return
    }

    # Position 2+: tree/remove commands
    if ($command -eq 'tree' -or $command -eq 'remove') {
        $project = $arg1

        if ($completingIndex -eq 2) {
            # Branch completion
            $config = Get-WorkConfig
            if (-not $config -or -not $project) { return }

            $target = Resolve-ProjectTarget -Name $project -Config $config
            if (-not $target) { return }

            if ($target.IsGroup) {
                if ($command -eq 'remove') {
                    $worktreesRoot = $config.worktreesRoot
                    $groupDir = Join-Path $worktreesRoot $target.Name
                    if (Test-Path $groupDir) {
                        Get-ChildItem -Path $groupDir -Directory -ErrorAction SilentlyContinue | ForEach-Object {
                            $actualBranch = $null
                            $subDirs = Get-ChildItem -Path $_.FullName -Directory -ErrorAction SilentlyContinue
                            foreach ($sd in $subDirs) {
                                Push-Location $sd.FullName
                                $b = git branch --show-current 2>$null
                                Pop-Location
                                if ($b) { $actualBranch = $b; break }
                            }
                            if ($actualBranch) { $actualBranch } else { $_.Name }
                        } | Where-Object { $_ -like "$wordToComplete*" } | ForEach-Object {
                            [System.Management.Automation.CompletionResult]::new($_, $_, 'ParameterValue', $_)
                        }
                    }
                } else {
                    $firstAlias = $target.RepoAliases[0]
                    $repoPath = $config.repos.$firstAlias
                    if (Test-Path $repoPath) {
                        Push-Location $repoPath
                        git worktree list --porcelain 2>$null | Select-String "^branch " | ForEach-Object {
                            $_.Line -replace "^branch refs/heads/", ""
                        } | Where-Object { $_ -like "$wordToComplete*" } | ForEach-Object {
                            [System.Management.Automation.CompletionResult]::new($_, $_, 'ParameterValue', $_)
                        }
                        Pop-Location
                    }
                }
            } else {
                $repoPath = $config.repos.$project
                if (-not (Test-Path $repoPath)) { return }
                Push-Location $repoPath
                git worktree list --porcelain 2>$null | Select-String "^branch " | ForEach-Object {
                    $_.Line -replace "^branch refs/heads/", ""
                } | Where-Object { $_ -like "$wordToComplete*" } | ForEach-Object {
                    [System.Management.Automation.CompletionResult]::new($_, $_, 'ParameterValue', $_)
                }
                Pop-Location
            }
            return
        }

        if ($completingIndex -eq 3 -and $command -eq 'tree') {
            @('open') | Where-Object { $_ -like "$wordToComplete*" } | ForEach-Object {
                [System.Management.Automation.CompletionResult]::new($_, $_, 'ParameterValue', $_)
            }
        }
    }
}
