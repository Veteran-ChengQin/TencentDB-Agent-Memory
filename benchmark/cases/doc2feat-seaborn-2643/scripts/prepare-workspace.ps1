param(
  [string]$Workspace = (Join-Path $PSScriptRoot '..\workspace'),
  [switch]$SkipInstall
)

$ErrorActionPreference = 'Stop'
$caseRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$config = Get-Content -Raw -Encoding utf8 (Join-Path $caseRoot 'case-config.json') | ConvertFrom-Json
$workspacePath = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($Workspace)

if (Test-Path -LiteralPath $workspacePath) {
  if (-not (Test-Path -LiteralPath (Join-Path $workspacePath '.git'))) {
    throw "Workspace exists but is not a Git repository: $workspacePath"
  }
  $head = git -C $workspacePath rev-parse HEAD
  if ($head -ne $config.base_commit) {
    throw "Unexpected workspace commit. Actual: $head; expected: $($config.base_commit)"
  }
  if (git -C $workspacePath status --porcelain) {
    throw 'Workspace has local changes. Use a new -Workspace path to avoid overwriting work.'
  }
} else {
  New-Item -ItemType Directory -Path (Split-Path $workspacePath -Parent) -Force | Out-Null
  New-Item -ItemType Directory -Path $workspacePath -Force | Out-Null
  # Fetch only the task base revision. Keeping origin/main would expose future
  # commits and let an Agent discover the reference implementation.
  git -C $workspacePath init
  git -C $workspacePath remote add origin $config.repository
  git -C $workspacePath fetch --depth 1 origin $config.base_commit
  git -C $workspacePath switch -c $config.default_branch FETCH_HEAD
  git -C $workspacePath remote remove origin
}

$remotes = @(git -C $workspacePath remote)
if ($remotes.Count -ne 0) {
  throw "Workspace exposes remote references and is not benchmark-isolated: $($remotes -join ', ')"
}

$excludePath = git -C $workspacePath rev-parse --git-path info/exclude
if (-not [IO.Path]::IsPathRooted($excludePath)) { $excludePath = Join-Path $workspacePath $excludePath }
Add-Content -LiteralPath $excludePath -Value "`n.codebuddy/`n"

if (-not $SkipInstall) {
  $envName = $config.conda_environment
  $existing = conda env list --json | ConvertFrom-Json
  $found = $existing.envs | Where-Object { (Split-Path $_ -Leaf) -eq $envName }
  if (-not $found) {
    conda create -y -n $envName python=3.8
  }
  conda run -n $envName python -m pip install --upgrade 'pip<25'
  conda run -n $envName python -m pip install `
    'matplotlib==3.7.5' 'numpy==1.24.3' 'pandas==1.5.3' `
    'scipy==1.10.1' 'pytest<8' 'pillow' 'packaging'
  conda run -n $envName python -m pip install -e "$workspacePath[dev]"
}

Write-Host "Prepared clean workspace: $workspacePath"
Write-Host "Base commit: $($config.base_commit)"
