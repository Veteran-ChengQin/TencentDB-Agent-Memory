[CmdletBinding()]
param(
    [string]$Server = '121.40.46.108',
    [int]$PublicPort = 18125,
    [int]$RemoteTunnelPort = 18126,
    [int]$LocalPanelPort = 8125,
    [string]$IdentityFile = (Join-Path $env:USERPROFILE '.ssh\tdai-panel-tunnel')
)

$ErrorActionPreference = 'Stop'

if (-not (Test-Path -LiteralPath $IdentityFile -PathType Leaf)) {
    throw "SSH tunnel key does not exist: $IdentityFile"
}

$localUrl = "http://127.0.0.1:$LocalPanelPort/"
try {
    $localStatus = (Invoke-WebRequest -UseBasicParsing -Uri $localUrl -Method Get -TimeoutSec 5).StatusCode
} catch {
    throw "Local Panel UI is unavailable: $localUrl. Start TDAI first."
}
if ($localStatus -ne 200) {
    throw "Local Panel UI returned HTTP ${localStatus}: $localUrl"
}

$forwardSpec = "127.0.0.1:${RemoteTunnelPort}:127.0.0.1:${LocalPanelPort}"
$runner = Join-Path $PSScriptRoot 'run-public-panel-tunnel.ps1'
if (-not (Test-Path -LiteralPath $runner -PathType Leaf)) {
    throw "Tunnel runner does not exist: $runner"
}

$existing = Get-CimInstance Win32_Process -Filter "Name = 'powershell.exe'" |
    Where-Object { $_.CommandLine -like "*$runner*" -and $_.CommandLine -like "*$forwardSpec*" }
if ($existing) {
    Write-Host "Public tunnel monitor is already running (PID: $($existing.ProcessId -join ', '))."
    Write-Host "URL: http://${Server}:${PublicPort}/"
    exit 0
}

$errorLog = Join-Path $env:TEMP 'tdai-panel-tunnel.err.log'
Remove-Item -LiteralPath $errorLog -Force -ErrorAction SilentlyContinue

$runnerArgs = @(
    '-NoProfile',
    '-ExecutionPolicy', 'Bypass',
    '-File', $runner,
    '-Server', $Server,
    '-ForwardSpec', $forwardSpec,
    '-IdentityFile', $IdentityFile,
    '-LogFile', $errorLog
)

$process = Start-Process -FilePath 'powershell.exe' -ArgumentList $runnerArgs `
    -WindowStyle Hidden -PassThru
Start-Sleep -Seconds 2

if ($process.HasExited) {
    $detail = if (Test-Path -LiteralPath $errorLog) {
        (Get-Content -Raw -LiteralPath $errorLog).Trim()
    } else {
        'No error log was produced.'
    }
    throw "Failed to start SSH tunnel monitor: $detail"
}

Write-Host "Public tunnel monitor started (PID: $($process.Id))."
Write-Host "URL: http://${Server}:${PublicPort}/"
