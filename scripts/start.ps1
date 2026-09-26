<#
.SYNOPSIS
    One-stop manual start for the Minecraft status heartbeat.

.DESCRIPTION
    Use this when you want to bring everything up by hand (for example after
    you disabled it, or to check that it is healthy):

      1. makes sure the watchdog task and the logon startup shortcut exist
         (re-registered with -Force, so a stale definition gets fixed);
      2. starts the resident watcher - a named mutex keeps it single-instance,
         so this is safe to run while it is already running;
      3. prints the task/watcher status, the log tail and the status page URL.

    ASCII-only on purpose (Windows PowerShell 5.1 encoding safety).

.EXAMPLE
    .\start.ps1
    .\start.ps1 -SkipInstall      # only start + report, do not touch the task
#>
[CmdletBinding()]
param(
    [string]$TaskName = 'MC-Server-Status-Heartbeat',
    [int]$IntervalMinutes = 30,
    [switch]$SkipInstall
)

$ErrorActionPreference = 'Stop'
$here = $PSScriptRoot

Write-Host '=== 1/4  install check (startup shortcut + watchdog task) ==='
if ($SkipInstall) {
    Write-Host 'skipped (-SkipInstall)'
} else {
    & (Join-Path $here 'register-task.ps1') -TaskName $TaskName -IntervalMinutes $IntervalMinutes
}

Write-Host ''
Write-Host '=== 2/4  start the resident watcher ==='
Start-ScheduledTask -TaskName $TaskName
Start-Sleep -Seconds 8

Write-Host ''
Write-Host '=== 3/4  status ==='
& (Join-Path $here 'register-task.ps1') -TaskName $TaskName -Status

$url = ''
$cfgPath = Join-Path $here 'host.config.json'
if (Test-Path -LiteralPath $cfgPath) {
    try {
        $cfg = Get-Content -LiteralPath $cfgPath -Raw -Encoding UTF8 | ConvertFrom-Json
        if ($cfg.owner -and $cfg.repo) { $url = "https://$($cfg.owner).github.io/$($cfg.repo)/" }
    } catch { }
}

Write-Host ''
Write-Host '=== 4/4  heartbeat.log (tail) ==='
$log = Join-Path $here 'heartbeat.log'
if (Test-Path -LiteralPath $log) { Get-Content -LiteralPath $log -Tail 6 }

Write-Host ''
if ($url) { Write-Host ("status page : {0}" -f $url) }
Write-Host 'single check : powershell -ExecutionPolicy Bypass -File scripts\update_status.ps1 -DryRun'
Write-Host 'force push   : powershell -ExecutionPolicy Bypass -File scripts\update_status.ps1 -Force'
Write-Host 'tunnel only  : powershell -ExecutionPolicy Bypass -File scripts\update_status.ps1 -TunnelOnly'
Write-Host 'stop watcher : powershell -ExecutionPolicy Bypass -File scripts\register-task.ps1 -Stop'
