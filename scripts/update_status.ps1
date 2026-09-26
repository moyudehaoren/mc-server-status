<#
.SYNOPSIS
    Minecraft server status heartbeat for the mc-server-status GitHub Pages site.

.DESCRIPTION
    Pings the local Minecraft server using the Server List Ping protocol (TCP),
    reads online player count / player names / version, then publishes the result
    to the GitHub repository as status.json via the GitHub Contents API.
    No git installation is required.

    Push policy (keeps commit noise low):
      * push whenever state changes (online <-> offline, player list changes)
      * while online, push again at most every -KeepAliveMinutes (freshness signal)
      * while offline and the remote copy is already offline, never push

    NOTE: this file is intentionally ASCII-only so that Windows PowerShell 5.1
    parses it correctly regardless of file encoding.

.PARAMETER DryRun
    Only ping the server and print the JSON that would be published. Never
    contacts GitHub, so it is safe to run for testing.

.EXAMPLE
    .\update_status.ps1 -DryRun
    .\update_status.ps1 -Owner alice -Repo mc-server-status -Token $env:MC_STATUS_TOKEN
#>
[CmdletBinding()]
param(
    [string]$Owner,
    [string]$Repo,
    [string]$Branch,
    [string]$Token,
    [string]$ServerHost,
    [int]$ServerPort,
    [int]$ProtocolVersion,
    [int]$TimeoutMs,
    [int]$KeepAliveMinutes,
    [int]$MinPushIntervalMinutes = -1,
    [string]$ConfigPath,
    [string]$LogFile,
    [switch]$Force,
    [switch]$DryRun,
    [switch]$SelfTest
)

$ErrorActionPreference = 'Stop'
# Windows PowerShell 5.1 defaults to TLS 1.0; the GitHub API needs 1.2+
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

# ---------------------------------------------------------------- configuration
if (-not $ConfigPath) { $ConfigPath = Join-Path $PSScriptRoot 'host.config.json' }
if (-not $LogFile) { $LogFile = Join-Path $PSScriptRoot 'heartbeat.log' }

$cfg = $null
if (Test-Path -LiteralPath $ConfigPath) {
    try {
        $cfg = Get-Content -LiteralPath $ConfigPath -Raw -Encoding UTF8 | ConvertFrom-Json
    } catch {
        Write-Warning "Failed to read config '$ConfigPath': $($_.Exception.Message)"
    }
}

function Get-CfgValue {
    param([string]$Name)
    if ($cfg -and $cfg.PSObject.Properties[$Name]) { return $cfg.PSObject.Properties[$Name].Value }
    return $null
}

if (-not $PSBoundParameters.ContainsKey('Owner')) { $Owner = Get-CfgValue 'owner' }
if (-not $PSBoundParameters.ContainsKey('Repo')) { $Repo = Get-CfgValue 'repo' }
if (-not $PSBoundParameters.ContainsKey('Branch')) { $Branch = Get-CfgValue 'branch' }
if (-not $PSBoundParameters.ContainsKey('Token')) { $Token = Get-CfgValue 'token' }
if (-not $PSBoundParameters.ContainsKey('ServerHost')) { $ServerHost = Get-CfgValue 'serverHost' }
if (-not $PSBoundParameters.ContainsKey('ServerPort')) { $ServerPort = [int](Get-CfgValue 'serverPort') }
if (-not $PSBoundParameters.ContainsKey('ProtocolVersion')) { $ProtocolVersion = [int](Get-CfgValue 'protocolVersion') }
if (-not $PSBoundParameters.ContainsKey('TimeoutMs')) { $TimeoutMs = [int](Get-CfgValue 'timeoutMs') }
if (-not $PSBoundParameters.ContainsKey('KeepAliveMinutes')) { $KeepAliveMinutes = [int](Get-CfgValue 'keepAliveMinutes') }

if (-not $Token -and $env:MC_STATUS_TOKEN) { $Token = $env:MC_STATUS_TOKEN }
if (-not $Repo) { $Repo = 'mc-server-status' }
if (-not $Branch) { $Branch = 'main' }
if (-not $ServerHost) { $ServerHost = '127.0.0.1' }
if (-not $ServerPort -or $ServerPort -le 0) { $ServerPort = 25565 }
if (-not $ProtocolVersion -or $ProtocolVersion -le 0) { $ProtocolVersion = 767 }
if (-not $TimeoutMs -or $TimeoutMs -le 0) { $TimeoutMs = 3000 }
if ($KeepAliveMinutes -le 0) { $KeepAliveMinutes = 10 }
# -1 means "not specified": take it from config, else 2 minutes; explicit 0 disables throttling
if ($MinPushIntervalMinutes -lt 0) {
    $cfgMinPush = Get-CfgValue 'minPushIntervalMinutes'
    if ($null -ne $cfgMinPush -and "$cfgMinPush" -ne '') { $MinPushIntervalMinutes = [int]$cfgMinPush }
    if ($MinPushIntervalMinutes -lt 0) { $MinPushIntervalMinutes = 2 }
}

# ------------------------------------------------------------------- logging
function Write-Log {
    param([string]$Message)
    $line = '[{0}] {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Message
    Write-Host $line
    try {
        Add-Content -LiteralPath $LogFile -Value $line -Encoding UTF8
        $info = Get-Item -LiteralPath $LogFile
        if ($info.Length -gt 256KB) {
            $tail = Get-Content -LiteralPath $LogFile -Tail 400
            Set-Content -LiteralPath $LogFile -Value $tail -Encoding UTF8
        }
    } catch {
        # logging must never break the heartbeat
    }
}

# ------------------------------------------------------- minecraft protocol
function ConvertTo-VarInt {
    param([Parameter(Mandatory = $true)][int]$Value)
    $v = [int64]$Value
    if ($v -lt 0) { $v += 4294967296 }   # allow -1 style "unknown protocol"
    $bytes = New-Object System.Collections.Generic.List[byte]
    do {
        $b = [int]($v -band 0x7F)
        $v = $v -shr 7
        if ($v -ne 0) { $b = $b -bor 0x80 }
        $bytes.Add([byte]$b)
    } while ($v -ne 0)
    return , $bytes.ToArray()
}

function Read-VarInt {
    param([Parameter(Mandatory = $true)][System.IO.Stream]$Stream)
    $result = [int64]0
    $shift = 0
    while ($true) {
        $b = $Stream.ReadByte()
        if ($b -lt 0) { throw 'connection closed while reading VarInt' }
        $result = $result -bor ([int64]($b -band 0x7F) -shl $shift)
        if (($b -band 0x80) -eq 0) { break }
        $shift += 7
        if ($shift -gt 35) { throw 'VarInt is too long' }
    }
    return $result
}

function Read-StatusResponse {
    param([Parameter(Mandatory = $true)][System.IO.Stream]$Stream)
    $null = Read-VarInt -Stream $Stream                    # packet length
    $packetId = Read-VarInt -Stream $Stream
    if ($packetId -ne 0) { throw "unexpected packet id $packetId" }

    $jsonLength = Read-VarInt -Stream $Stream
    if ($jsonLength -le 0 -or $jsonLength -gt 4MB) { throw "unexpected status length $jsonLength" }

    $jsonBuffer = New-Object byte[] $jsonLength
    $offset = 0
    while ($offset -lt $jsonLength) {
        $read = $Stream.Read($jsonBuffer, $offset, $jsonLength - $offset)
        if ($read -le 0) { throw 'connection closed while reading status json' }
        $offset += $read
    }
    return ([Text.Encoding]::UTF8.GetString($jsonBuffer) | ConvertFrom-Json)
}

function ConvertFrom-MinecraftStatus {
    param([Parameter(Mandatory = $true)]$Status)

    $names = @()
    if ($Status.players -and $Status.players.sample) {
        foreach ($p in $Status.players.sample) { if ($p.name) { $names += [string]$p.name } }
    }
    $online = 0
    $max = $null
    $version = $null
    if ($Status.players) {
        if ($null -ne $Status.players.online) { $online = [int]$Status.players.online }
        if ($null -ne $Status.players.max) { $max = [int]$Status.players.max }
    }
    if ($Status.version -and $Status.version.name) { $version = [string]$Status.version.name }

    return [pscustomobject]@{ Online = $online; Max = $max; Players = $names; Version = $version }
}

function Get-MinecraftStatus {
    param(
        [string]$TargetHost,
        [int]$Port,
        [int]$TimeoutMs,
        [int]$ProtocolVersion
    )

    $client = New-Object System.Net.Sockets.TcpClient
    try {
        $async = $client.BeginConnect($TargetHost, $Port, $null, $null)
        if (-not $async.AsyncWaitHandle.WaitOne($TimeoutMs, $false)) {
            return [pscustomobject]@{ Reachable = $false; Reason = 'connect timeout'; Online = 0; Max = $null; Players = @(); Version = $null }
        }
        $client.EndConnect($async)

        $stream = $client.GetStream()
        $stream.ReadTimeout = $TimeoutMs
        $stream.WriteTimeout = $TimeoutMs

        # --- handshake packet ---
        $payload = New-Object System.Collections.Generic.List[byte]
        $payload.Add([byte]0)                                                    # packet id
        $payload.AddRange([byte[]](ConvertTo-VarInt -Value $ProtocolVersion))
        $addrBytes = [Text.Encoding]::UTF8.GetBytes($TargetHost)
        $payload.AddRange([byte[]](ConvertTo-VarInt -Value $addrBytes.Length))
        $payload.AddRange($addrBytes)
        $payload.Add([byte](($Port -shr 8) -band 0xFF))                          # port, big endian
        $payload.Add([byte]($Port -band 0xFF))
        $payload.Add([byte]1)                                                    # next state = status

        # --- frame: length + handshake + status request ---
        $frame = New-Object System.Collections.Generic.List[byte]
        $frame.AddRange([byte[]](ConvertTo-VarInt -Value $payload.Count))
        $frame.AddRange($payload)
        $frame.Add([byte]1)                                                      # status request: length
        $frame.Add([byte]0)                                                      # status request: packet id

        $out = $frame.ToArray()
        $stream.Write($out, 0, $out.Length)
        $stream.Flush()

        # --- response: length, packet id, json string ---
        $status = Read-StatusResponse -Stream $stream
        $parsed = ConvertFrom-MinecraftStatus -Status $status

        return [pscustomobject]@{
            Reachable = $true
            Reason    = $null
            Online    = $parsed.Online
            Max       = $parsed.Max
            Players   = $parsed.Players
            Version   = $parsed.Version
        }
    } catch {
        return [pscustomobject]@{ Reachable = $false; Reason = $_.Exception.Message; Online = 0; Max = $null; Players = @(); Version = $null }
    } finally {
        if ($client) { $client.Close() }
    }
}

# ----------------------------------------------------------------- self test
function Invoke-SelfTest {
    $failures = @()

    # 1) VarInt encoding against known-good byte sequences
    #    (array of hashtables: PowerShell cannot reliably look up integer keys
    #     in an [ordered]@{...} literal, so string keys are used instead)
    $cases = @(
        @{ value = 0;     bytes = @(0x00) },
        @{ value = 1;     bytes = @(0x01) },
        @{ value = 127;   bytes = @(0x7F) },
        @{ value = 128;   bytes = @(0x80, 0x01) },
        @{ value = 255;   bytes = @(0xFF, 0x01) },
        @{ value = 767;   bytes = @(0xFF, 0x05) },
        @{ value = 25565; bytes = @(0xDD, 0xC7, 0x01) }
    )
    foreach ($c in $cases) {
        $actual = @([byte[]](ConvertTo-VarInt -Value $c.value))
        $expected = @($c.bytes)
        if (($actual -join ',') -ne ($expected -join ',')) {
            $failures += "VarInt($($c.value)) => $($actual -join ',') expected $($expected -join ',')"
        }
    }

    # 2) VarInt round-trip through a stream
    foreach ($n in @(0, 1, 127, 128, 767, 25565, 2147483647)) {
        $ms = New-Object System.IO.MemoryStream
        $bytes = [byte[]](ConvertTo-VarInt -Value $n)
        $ms.Write($bytes, 0, $bytes.Length)
        $ms.Position = 0
        $back = Read-VarInt -Stream $ms
        if ($back -ne $n) { $failures += "VarInt round-trip $n => $back" }
    }

    # 3) full status response (framed like a real server reply, player names included)
    $fakeJson = '{"version":{"name":"1.21.4","protocol":767},"players":{"max":20,"online":2,"sample":[{"name":"Steve","id":"1"},{"name":"Alex","id":"2"}]},"description":{"text":"mock"}}'
    $jsonBytes = [Text.Encoding]::UTF8.GetBytes($fakeJson)
    $body = New-Object System.Collections.Generic.List[byte]
    $body.Add([byte]0)
    $body.AddRange([byte[]](ConvertTo-VarInt -Value $jsonBytes.Length))
    $body.AddRange($jsonBytes)
    $frame = New-Object System.Collections.Generic.List[byte]
    $frame.AddRange([byte[]](ConvertTo-VarInt -Value $body.Count))
    $frame.AddRange($body)

    $stream = New-Object System.IO.MemoryStream
    $frameBytes = $frame.ToArray()
    $stream.Write($frameBytes, 0, $frameBytes.Length)
    $stream.Position = 0

    $parsed = ConvertFrom-MinecraftStatus -Status (Read-StatusResponse -Stream $stream)
    if ($parsed.Online -ne 2) { $failures += "online => $($parsed.Online) expected 2" }
    if ($parsed.Max -ne 20) { $failures += "max => $($parsed.Max) expected 20" }
    if (($parsed.Players -join ',') -ne 'Steve,Alex') { $failures += "players => '$($parsed.Players -join ',')' expected 'Steve,Alex'" }
    if ($parsed.Version -ne '1.21.4') { $failures += "version => '$($parsed.Version)' expected '1.21.4'" }

    # 4) servers that hide the player list (most big public servers) must not break
    $noSample = '{"version":{"name":"Requires MC 1.8 / 1.21"},"players":{"max":200000,"online":19434},"description":{"text":"x"}}' | ConvertFrom-Json
    $parsed2 = ConvertFrom-MinecraftStatus -Status $noSample
    if ($parsed2.Online -ne 19434) { $failures += "no-sample online => $($parsed2.Online) expected 19434" }
    if (@($parsed2.Players).Count -ne 0) { $failures += 'no-sample players should be empty' }
    if ($parsed2.Version -ne 'Requires MC 1.8 / 1.21') { $failures += "no-sample version => '$($parsed2.Version)'" }

    # 5) minimal / missing fields
    $empty = '{"players":{},"version":{}}' | ConvertFrom-Json
    $parsed3 = ConvertFrom-MinecraftStatus -Status $empty
    if ($parsed3.Online -ne 0 -or $null -ne $parsed3.Max -or $null -ne $parsed3.Version) {
        $failures += 'minimal status mapping is wrong'
    }

    if ($failures.Count -eq 0) {
        Write-Host 'SelfTest: ALL PASS'
        return 0
    }
    foreach ($f in $failures) { Write-Host "SelfTest FAIL: $f" }
    Write-Host ('SelfTest: {0} failure(s)' -f $failures.Count)
    return 1
}

if ($SelfTest) { exit (Invoke-SelfTest) }

# ----------------------------------------------------------------- main flow
$status = $null
$result = Get-MinecraftStatus -TargetHost $ServerHost -Port $ServerPort -TimeoutMs $TimeoutMs -ProtocolVersion $ProtocolVersion
$now = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')

if ($result.Reachable) {
    $status = [ordered]@{
        online     = $true
        players    = @($result.Players)
        count      = $result.Online
        max        = $result.Max
        version    = $result.Version
        updated_at = $now
        source     = 'host-heartbeat'
    }
    Write-Log ("Server is UP at {0}:{1} - {2}/{3} player(s) [{4}] version {5}" -f `
        $ServerHost, $ServerPort, $result.Online, $result.Max, ($result.Players -join ', '), $result.Version)
} else {
    $status = [ordered]@{
        online     = $false
        players    = @()
        count      = 0
        max        = $null
        version    = $null
        updated_at = $now
        source     = 'host-heartbeat'
    }
    Write-Log ("Server is DOWN at {0}:{1} - {2}" -f $ServerHost, $ServerPort, $result.Reason)
}

$json = ($status | ConvertTo-Json -Depth 4) + "`n"

if ($DryRun) {
    Write-Log '--- DryRun: this JSON would be published as status.json ---'
    Write-Host $json
    exit 0
}

if (-not $Owner -or -not $Repo -or -not $Token) {
    Write-Log 'ERROR: Owner / Repo / Token missing. Copy scripts/host.config.example.json to host.config.json and fill it in, or pass -Owner and -Token.'
    exit 2
}

$headers = @{
    Authorization = "Bearer $Token"
    'User-Agent'  = 'mc-server-status-heartbeat'
    Accept        = 'application/vnd.github+json'
}
$contentsUri = "https://api.github.com/repos/$Owner/$Repo/contents/status.json"

# --- read current remote state ---
$remote = $null
$remoteSha = $null
try {
    $remoteRaw = Invoke-RestMethod -Uri "$contentsUri`?ref=$Branch" -Headers $headers -Method Get
    $remoteText = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String(($remoteRaw.content -replace '\s', '')))
    $remote = $remoteText | ConvertFrom-Json
    $remoteSha = $remoteRaw.sha
} catch {
    Write-Log "No readable status.json on GitHub yet ($($_.Exception.Message))"
}

# --- decide whether to push ---
$stateKey = '{0}|{1}' -f $status.online, ($status.players -join ',')
$shouldPush = [bool]$Force

if (-not $shouldPush -and $null -eq $remote) { $shouldPush = $true }

if (-not $shouldPush) {
    $remoteKey = '{0}|{1}' -f $remote.online, ((@($remote.players)) -join ',')
    $remoteAgeMinutes = [double]::MaxValue
    if ($remote.updated_at) {
        try {
            $remoteAgeMinutes = ((Get-Date).ToUniversalTime() - [datetime]::Parse($remote.updated_at).ToUniversalTime()).TotalMinutes
        } catch { }
    }

    if ($remote.online -ne $status.online) {
        # online/offline transition: publish immediately
        $shouldPush = $true
        Write-Log 'Online state changed, publishing.'
    } elseif ($remoteKey -ne $stateKey) {
        # only the player list changed: throttle to avoid commit spam (Pages has a build rate limit)
        if ($MinPushIntervalMinutes -le 0 -or $remoteAgeMinutes -ge $MinPushIntervalMinutes) {
            $shouldPush = $true
            Write-Log 'Player list changed, publishing.'
        } else {
            Write-Log ("Player list changed but last push was {0:N1} min ago (< {1} min), holding off." -f $remoteAgeMinutes, $MinPushIntervalMinutes)
        }
    } elseif ($status.online -eq $true -and $remoteAgeMinutes -ge $KeepAliveMinutes) {
        # keep-alive refresh while online, so the page can tell the host is still alive
        $shouldPush = $true
        Write-Log ("Keep-alive refresh (last update {0:N1} min ago)." -f $remoteAgeMinutes)
    }
}

if (-not $shouldPush) {
    Write-Log 'State unchanged and still fresh - nothing to publish.'
    exit 0
}

# --- publish ---
$stateText = if ($status.online) { 'online' } else { 'offline' }
$message = "chore(status): $stateText"
if ($status.online -and $status.count) { $message += " ($($status.count) player)" }

$body = @{
    message = $message
    content = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($json))
    branch  = $Branch
}
if ($remoteSha) { $body['sha'] = $remoteSha }

try {
    $response = Invoke-RestMethod -Uri $contentsUri -Headers $headers -Method Put -Body ($body | ConvertTo-Json -Compress) -ContentType 'application/json'
    $shaShort = if ($response.commit.sha) { $response.commit.sha.Substring(0, 7) } else { '?' }
    Write-Log "Published status.json (commit $shaShort)."
} catch {
    Write-Log "ERROR: failed to publish status.json: $($_.Exception.Message)"
    exit 1
}

exit 0
