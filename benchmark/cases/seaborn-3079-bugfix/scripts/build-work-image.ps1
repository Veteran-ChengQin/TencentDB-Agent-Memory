param([string]$Image = '')

$ErrorActionPreference = 'Stop'
$caseRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$config = Get-Content -Raw -Encoding utf8 (Join-Path $caseRoot 'case-config.json') | ConvertFrom-Json
$tag = if ($Image) { $Image } else { $config.work_image }
$environmentPath = Join-Path $caseRoot 'environment'
$wslPath = (wsl wslpath -a ($environmentPath -replace '\\', '/')).Trim()
if (-not $wslPath) { throw 'Unable to resolve the Docker build context in WSL.' }
wsl bash -lc "cd '$wslPath' && docker build -t '$tag' ."
if ($LASTEXITCODE -ne 0) { throw "Docker image build failed: $tag" }
Write-Host "Built work image: $tag"
