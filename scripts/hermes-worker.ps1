[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$RepoPath
)

$ErrorActionPreference = "Stop"
$mutex = New-Object System.Threading.Mutex($false, "ALIA-Hermes-Worker")
$hasLock = $false
$logPath = $null
$pushedLocation = $false

function Invoke-NativeLogged {
    param(
        [Parameter(Mandatory = $true)]
        [scriptblock]$Command,

        [Parameter(Mandatory = $true)]
        [string]$LogPath,

        [switch]$Append
    )

    $previousPreference = $ErrorActionPreference
    try {
        # Windows PowerShell 5.1 can convert harmless native stderr output,
        # such as Git's "Already on main", into a terminating error when
        # ErrorActionPreference is Stop. Native exit codes remain authoritative.
        $ErrorActionPreference = "Continue"

        if ($Append) {
            & $Command 2>&1 |
                Tee-Object -FilePath $LogPath -Append |
                Out-Host
        }
        else {
            & $Command 2>&1 |
                Tee-Object -FilePath $LogPath |
                Out-Host
        }

        $nativeExitCode = $LASTEXITCODE
    }
    finally {
        $ErrorActionPreference = $previousPreference
    }

    return [int]$nativeExitCode
}

try {
    $hasLock = $mutex.WaitOne(0)
    if (-not $hasLock) {
        Write-Host "ALIA Hermes worker is already running."
        exit 0
    }

    $resolvedRepo = (Resolve-Path -LiteralPath $RepoPath -ErrorAction Stop).Path
    $promptPath = Join-Path $resolvedRepo "coordination\HERMES-PROMPT.md"

    if (-not (Test-Path -LiteralPath (Join-Path $resolvedRepo ".git"))) {
        throw "Not a Git repository: $resolvedRepo"
    }

    if (-not (Test-Path -LiteralPath $promptPath)) {
        throw "Hermes prompt not found: $promptPath"
    }

    $logRoot = Join-Path $env:LOCALAPPDATA "Hermes\ALIA\logs"
    New-Item -ItemType Directory -Path $logRoot -Force -ErrorAction Stop | Out-Null
    $stamp = Get-Date -Format "yyyyMMdd-HHmmss"
    $logPath = Join-Path $logRoot "worker-$stamp.log"

    foreach ($command in @("git", "gh", "hermes")) {
        if (-not (Get-Command $command -ErrorAction SilentlyContinue)) {
            throw "Required command not found: $command"
        }
    }

    $authExit = Invoke-NativeLogged -Command { gh auth status } -LogPath $logPath
    if ($authExit -ne 0) {
        throw "GitHub CLI is not authenticated. Run gh auth login once."
    }

    Push-Location $resolvedRepo
    $pushedLocation = $true

    $dirty = git status --porcelain
    $statusExit = $LASTEXITCODE
    if ($statusExit -ne 0) {
        throw "Unable to inspect Git status."
    }
    if ($dirty) {
        throw "Worktree is not clean. Resolve or preserve local changes before the autonomous worker runs."
    }

    $fetchExit = Invoke-NativeLogged -Command { git fetch --prune origin } -LogPath $logPath -Append
    if ($fetchExit -ne 0) {
        throw "git fetch failed."
    }

    $switchExit = Invoke-NativeLogged -Command { git switch main } -LogPath $logPath -Append
    if ($switchExit -ne 0) {
        throw "Unable to switch to main."
    }

    $pullExit = Invoke-NativeLogged -Command { git pull --ff-only origin main } -LogPath $logPath -Append
    if ($pullExit -ne 0) {
        throw "Unable to fast-forward main."
    }

    $hermesExit = Invoke-NativeLogged -Command {
        & hermes chat --query-file $promptPath
    } -LogPath $logPath -Append

    if ($hermesExit -ne 0) {
        throw "Hermes exited with code $hermesExit. See $logPath"
    }

    Write-Host "ALIA Hermes run completed. Log: $logPath"
}
catch {
    $failure = "ALIA Hermes worker failed: $($_.Exception.Message)"
    if ($logPath) {
        Add-Content -LiteralPath $logPath -Value $failure -ErrorAction SilentlyContinue
    }
    Write-Host $failure -ForegroundColor Red
    exit 1
}
finally {
    if ($pushedLocation) {
        Pop-Location
    }
    if ($hasLock) {
        $mutex.ReleaseMutex()
    }
    $mutex.Dispose()
}
