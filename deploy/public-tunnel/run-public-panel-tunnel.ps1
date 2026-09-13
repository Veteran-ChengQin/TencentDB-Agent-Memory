[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$Server,
    [Parameter(Mandatory = $true)]
    [string]$ForwardSpec,
    [Parameter(Mandatory = $true)]
    [string]$IdentityFile,
    [Parameter(Mandatory = $true)]
    [string]$LogFile
)

$ErrorActionPreference = 'Continue'
$sshArgs = @(
    '-NT',
    '-i', $IdentityFile,
    '-o', 'BatchMode=yes',
    '-o', 'ExitOnForwardFailure=yes',
    '-o', 'ServerAliveInterval=30',
    '-o', 'ServerAliveCountMax=3',
    '-o', 'ConnectTimeout=10',
    '-o', 'StrictHostKeyChecking=yes',
    '-R', $ForwardSpec,
    "root@$Server"
)

while ($true) {
    Add-Content -LiteralPath $LogFile -Value "[$(Get-Date -Format o)] Connecting SSH reverse tunnel."
    & ssh.exe @sshArgs 2>> $LogFile
    Add-Content -LiteralPath $LogFile -Value "[$(Get-Date -Format o)] SSH exited with code $LASTEXITCODE; retrying in 3 seconds."
    Start-Sleep -Seconds 3
}
