[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$RepoPath
)

$ErrorActionPreference = "Stop"
$mutex = New-Object System.Threading.Mutex($false, "ALIA-Hermes-Worker")
$hasLock = $false

try {
    $hasLock = $mutex.WaitOne(0)
    if (-not $hasLock) {
        Write-Host "ALIA Hermes worker is already running."
        exit 0
    }

    foreach ($command in @("git", "gh", "hermes")) {
        if (-not (Get-Command $command -ErrorAction SilentlyContinue)) {
            throw "Required command not found: $command"
        }
    }

    gh auth status 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0) {
        throw "GitHub CLI is not authenticated. Run gh auth login once."
    }

    $resolvedRepo = (Resolve-Path -LiteralPath $RepoPath).Path
    $promptPath = Join-Path $resolvedRepo "coordination\HERMES-PROMPT.md"

    if (-not (Test-Path -LiteralPath (Join-Path $resolvedRepo ".git"))) {
        throw "Not a Git repository: $resolvedRepo"
    }

    if (-not (Test-Path -LiteralPath $promptPath)) {
        throw "Hermes prompt not found: $promptPath"
    }

    $logRoot = Join-Path $env:LOCALAPPDATA "Hermes\ALIA\logs"
    New-Item -ItemType Directory -Path $logRoot -Force | Out-Null
    $stamp = Get-Date -Format "yyyyMMdd-HHmmss"
    $logPath = Join-Path $logRoot "worker-$stamp.log"

    Push-Location $resolvedRepo
    try {
        $dirty = git status --porcelain
        if ($LASTEXITCODE -ne 0) {
            throw "Unable to inspect Git status."
        }
        if ($dirty) {
            throw "Worktree is not clean. Resolve or preserve local changes before the autonomous worker runs."
        }

        git fetch --prune origin 2>&1 | Tee-Object -FilePath $logPath
        if ($LASTEXITCODE -ne 0) {
            throw "git fetch failed."
        }

        git switch main 2>&1 | Tee-Object -FilePath $logPath -Append
        if ($LASTEXITCODE -ne 0) {
            throw "Unable to switch to main."
        }

        git pull --ff-only origin main 2>&1 | Tee-Object -FilePath $logPath -Append
        if ($LASTEXITCODE -ne 0) {
            throw "Unable to fast-forward main."
        }

        & hermes chat --query-file $promptPath 2>&1 | Tee-Object -FilePath $logPath -Append
        $hermesExit = $LASTEXITCODE
        if ($hermesExit -ne 0) {
            throw "Hermes exited with code $hermesExit. See $logPath"
        }

        Write-Host "ALIA Hermes run completed. Log: $logPath"
    }
    finally {
        Pop-Location
    }
}
catch {
    Write-Error $_
    exit 1
}
finally {
    if ($hasLock) {
        $mutex.ReleaseMutex()
    }
    $mutex.Dispose()
}
