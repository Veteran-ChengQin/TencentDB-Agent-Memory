[CmdletBinding()]
param(
    [int]$RemoteTunnelPort = 18126,
    [int]$LocalPanelPort = 8125,
    [string]$IdentityFile = (Join-Path $env:USERPROFILE '.ssh\tdai-panel-tunnel')
)

$forwardSpec = "127.0.0.1:${RemoteTunnelPort}:127.0.0.1:${LocalPanelPort}"
$sshProcesses = Get-CimInstance Win32_Process -Filter "Name = 'ssh.exe'" |
    Where-Object { $_.CommandLine -like "*$IdentityFile*" -and $_.CommandLine -like "*$forwardSpec*" }
$runnerName = 'run-public-panel-tunnel.ps1'
$monitorProcesses = Get-CimInstance Win32_Process -Filter "Name = 'powershell.exe'" |
    Where-Object { $_.CommandLine -like "*$runnerName*" -and $_.CommandLine -like "*$forwardSpec*" }

if (-not $sshProcesses -and -not $monitorProcesses) {
    Write-Host 'Public tunnel is not running.'
    exit 0
}

foreach ($process in $sshProcesses) {
    Stop-Process -Id $process.ProcessId -Force
    Write-Host "Stopped SSH tunnel (PID: $($process.ProcessId))."
}
foreach ($process in $monitorProcesses) {
    Stop-Process -Id $process.ProcessId -Force
    Write-Host "Stopped tunnel monitor (PID: $($process.ProcessId))."
}
