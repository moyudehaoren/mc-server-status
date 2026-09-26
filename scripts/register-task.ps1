<#
.SYNOPSIS
    Registers / removes the scheduled task that keeps the status heartbeat alive.

.DESCRIPTION
    Two moving parts:

      1. A resident watcher (update_status.ps1 -Watch), started hidden at logon.
         It probes the server every few seconds and publishes only when the state
         changes or a keep-alive is due, so no per-minute process is spawned.

      2. This scheduled task acts as a WATCHDOG: it asks the watcher to start
         again every N minutes. A named mutex inside the watcher makes that a
         no-op while it is already running, and restarts it if it died.

    The task launches scripts\run-hidden.vbs through wscript.exe. wscript has no
    console of its own and starts the child with window style 0, so nothing
    flashes on screen (a task running powershell.exe directly always flashes).

    ASCII-only on purpose (Windows PowerShell 5.1 encoding safety).

.EXAMPLE
    .\register-task.ps1                     # install: at logon + 30 min watchdog
    .\register-task.ps1 -IntervalMinutes 15
    .\register-task.ps1 -Status
    .\register-task.ps1 -Stop
    .\register-task.ps1 -Uninstall
#>
[CmdletBinding()]
param(
    [string]$TaskName = 'MC-Server-Status-Heartbeat',
    [int]$IntervalMinutes = 30,
    [string]$ScriptPath,
    [switch]$Uninstall,
    [switch]$Status,
    [switch]$Stop
)

$ErrorActionPreference = 'Stop'

if (-not $ScriptPath) { $ScriptPath = Join-Path $PSScriptRoot 'update_status.ps1' }
$vbsPath = Join-Path $PSScriptRoot 'run-hidden.vbs'
$mutexName = 'Local\MC-Server-Status-Watch'

function Test-WatcherRunning {
    $probe = New-Object System.Threading.Mutex($false, $mutexName)
    try {
        if ($probe.WaitOne(0)) { $probe.ReleaseMutex(); return $false }
        return $true
    } catch {
        return $false
    } finally {
        $probe.Dispose()
    }
}

function Stop-Watcher {
    # CommandLine needs CIM, which works in a normal user session
    try {
        $procs = Get-CimInstance Win32_Process -Filter "Name = 'powershell.exe'" -ErrorAction Stop |
            Where-Object { $_.CommandLine -and $_.CommandLine -like '*update_status.ps1*' }
        if (-not $procs) { Write-Host 'No running watcher found.'; return }
        foreach ($p in $procs) {
            Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
            Write-Host ("Stopped watcher process {0}." -f $p.ProcessId)
        }
    } catch {
        Write-Host ("Could not enumerate processes ({0}). If a watcher is running, end the powershell.exe process that runs update_status.ps1." -f $_.Exception.Message)
    }
}

$startupDir = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Startup'
$startupLnk = Join-Path $startupDir 'Minecraft-Status-Heartbeat.lnk'

function Install-StartupShortcut {
    if (-not (Test-Path -LiteralPath $vbsPath)) { return $false }
    if (-not (Test-Path -LiteralPath $startupDir)) { return $false }
    try {
        $shell = New-Object -ComObject WScript.Shell
        $sc = $shell.CreateShortcut($startupLnk)
        $sc.TargetPath = Join-Path $env:SystemRoot 'System32\wscript.exe'
        $sc.Arguments = "//B //Nologo `"$vbsPath`" -Watch"
        $sc.WorkingDirectory = $PSScriptRoot
        $sc.WindowStyle = 7
        $sc.Description = 'Minecraft status heartbeat watcher (starts hidden)'
        $sc.Save()
        return $true
    } catch {
        Write-Host ("Could not create the startup shortcut: {0}" -f $_.Exception.Message)
        return $false
    }
}

function Remove-StartupShortcut {
    if (Test-Path -LiteralPath $startupLnk) {
        Remove-Item -LiteralPath $startupLnk -Force
        return $true
    }
    return $false
}

if ($Status) {
    $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if ($task) {
        $info = Get-ScheduledTaskInfo -TaskName $TaskName
        Write-Host ("Task        : {0} ({1})" -f $TaskName, $task.State)
        Write-Host ("Last run    : {0} (result {1})" -f $info.LastRunTime, $info.LastTaskResult)
        Write-Host ("Next run    : {0}" -f $info.NextRunTime)
        $act = @($task.Actions)[0]
        Write-Host ("Action      : {0} {1}" -f $act.Execute, $act.Arguments)
    } else {
        Write-Host ("Task        : {0} is not installed" -f $TaskName)
    }
    Write-Host ("Startup lnk : {0}" -f $(if (Test-Path -LiteralPath $startupLnk) { $startupLnk } else { 'missing' }))
    Write-Host ("Watcher     : {0}" -f $(if (Test-WatcherRunning) { 'running' } else { 'not running' }))
    exit 0
}

if ($Stop) {
    Stop-Watcher
    exit 0
}

if ($Uninstall) {
    Stop-Watcher
    if (Remove-StartupShortcut) { Write-Host 'Removed the startup shortcut.' }
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

if (Test-Path -LiteralPath $vbsPath) {
    $action = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument "//B //Nologo `"$vbsPath`" -Watch"
    $launcher = 'wscript.exe (no window)'
} else {
    $launcher = 'powershell.exe -WindowStyle Hidden (may flash briefly)'
    $action = New-ScheduledTaskAction -Execute 'powershell.exe' `
        -Argument "-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$ScriptPath`" -Watch"
}

# Watchdog only. An -AtLogOn trigger requires administrator rights, so startup
# at logon is handled by a shortcut in the user's Startup folder instead
# (wscript.exe, window style 7 - no console window either way).
$triggerWatchdog = New-ScheduledTaskTrigger -Once -At ((Get-Date).AddMinutes(1)) `
    -RepetitionInterval (New-TimeSpan -Minutes $IntervalMinutes)

# no execution time limit: the watcher is meant to stay resident
$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
    -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero)

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $triggerWatchdog `
    -Settings $settings `
    -Description 'Keeps the Minecraft status heartbeat watcher running (hidden) and publishes to the mc-server-status repository.' -Force | Out-Null

$startupOk = Install-StartupShortcut

Write-Host "Installed scheduled task '$TaskName'."
Write-Host ("  launcher : {0}" -f $launcher)
Write-Host ("  watchdog : every {0} minute(s) - restarts the watcher if it died" -f $IntervalMinutes)
Write-Host ("  startup  : {0}" -f $(if ($startupOk) { $startupLnk } else { 'NOT created - check -Status' }))
Write-Host ''
Write-Host ("Start now    : Start-ScheduledTask -TaskName '{0}'" -f $TaskName)
Write-Host 'Check status : .\register-task.ps1 -Status'
Write-Host 'Stop watcher : .\register-task.ps1 -Stop'
Write-Host 'Uninstall    : .\register-task.ps1 -Uninstall'
