[CmdletBinding()]
param(
    [string]$RepoPath = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path,
    [ValidateRange(5, 1440)]
    [int]$IntervalMinutes = 15
)

$ErrorActionPreference = "Stop"

if (-not $IsWindows -and $PSVersionTable.PSVersion.Major -ge 6) {
    throw "This installer registers a Windows Scheduled Task and must run on Windows."
}

$resolvedRepo = (Resolve-Path -LiteralPath $RepoPath).Path
$workerPath = Join-Path $resolvedRepo "scripts\hermes-worker.ps1"

if (-not (Test-Path -LiteralPath $workerPath)) {
    throw "Worker script not found: $workerPath"
}

foreach ($command in @("git", "gh", "hermes")) {
    if (-not (Get-Command $command -ErrorAction SilentlyContinue)) {
        throw "Required command not found or not on PATH: $command"
    }
}

gh auth status 2>&1 | Out-Null
if ($LASTEXITCODE -ne 0) {
    throw "GitHub CLI is not authenticated. Run gh auth login once, then rerun this installer."
}

$taskName = "ALIA-Hermes-Worker"
$quotedWorker = '"' + $workerPath + '"'
$quotedRepo = '"' + $resolvedRepo + '"'
$arguments = "-NoProfile -ExecutionPolicy Bypass -File $quotedWorker -RepoPath $quotedRepo"

$action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument $arguments
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes $IntervalMinutes)
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Hours 2)
$currentUser = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$principal = New-ScheduledTaskPrincipal -UserId $currentUser -LogonType Interactive -RunLevel Limited

Register-ScheduledTask -TaskName $taskName -Description "Runs the ALIA Hermes implementation worker against GitHub task branches." -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null
Start-ScheduledTask -TaskName $taskName

Write-Host "Installed and started $taskName."
Write-Host "Repository: $resolvedRepo"
Write-Host "Interval: every $IntervalMinutes minutes while $currentUser is signed in."
Write-Host "Logs: $env:LOCALAPPDATA\Hermes\ALIA\logs"
