<#
.SYNOPSIS
    Registers / removes the Windows scheduled task that runs the heartbeat.

.DESCRIPTION
    Creates a task that runs scripts\update_status.ps1 every N minutes in a
    hidden window. The task runs as the current user, only while logged on,
    which is exactly what a game host needs.

    ASCII-only on purpose (Windows PowerShell 5.1 encoding safety).

.EXAMPLE
    .\register-task.ps1                 # install, every 1 minute (default)
    .\register-task.ps1 -IntervalMinutes 2
    .\register-task.ps1 -Status
    .\register-task.ps1 -Uninstall
#>
[CmdletBinding()]
param(
    [string]$TaskName = 'MC-Server-Status-Heartbeat',
    [int]$IntervalMinutes = 1,
    [string]$ScriptPath,
    [switch]$Uninstall,
    [switch]$Status
)

$ErrorActionPreference = 'Stop'

if (-not $ScriptPath) { $ScriptPath = Join-Path $PSScriptRoot 'update_status.ps1' }

if ($Status) {
    $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if (-not $task) { Write-Host "Task '$TaskName' is not installed."; exit 1 }
    $info = Get-ScheduledTaskInfo -TaskName $TaskName
    [pscustomobject]@{
        TaskName      = $TaskName
        State         = $task.State
        LastRunTime   = $info.LastRunTime
        LastResult    = $info.LastTaskResult
        NextRunTime   = $info.NextRunTime
        NumberOfRuns  = $info.NumberOfMissedRuns
    } | Format-List
    exit 0
}

if ($Uninstall) {
    if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
        Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
        Write-Host "Removed scheduled task '$TaskName'."
    } else {
        Write-Host "Task '$TaskName' was not installed."
    }
    exit 0
}

if (-not (Test-Path -LiteralPath $ScriptPath)) {
    Write-Host "Heartbeat script not found: $ScriptPath"
    exit 1
}

$action = New-ScheduledTaskAction -Execute 'powershell.exe' `
    -Argument "-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$ScriptPath`""

# Repeat indefinitely: omitting -RepetitionDuration means "forever" on Windows 10+.
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) `
    -RepetitionInterval (New-TimeSpan -Minutes $IntervalMinutes)

$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
    -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 5)

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings `
    -Description 'Publishes Minecraft server online status to the mc-server-status GitHub repository.' -Force | Out-Null

Write-Host "Installed scheduled task '$TaskName' (every $IntervalMinutes minute(s))."
Write-Host "Script : $ScriptPath"
Write-Host 'Check:  .\register-task.ps1 -Status'
Write-Host 'Remove: .\register-task.ps1 -Uninstall'
