param(
  [string]$Workspace = (Join-Path $PSScriptRoot '..\workspaces\codebuddy-sol-500'),
  [switch]$SkipInstall
)

$ErrorActionPreference = 'Stop'
$caseRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$config = Get-Content -Raw -Encoding utf8 (Join-Path $caseRoot 'case-config.json') | ConvertFrom-Json
$workspacePath = [IO.Path]::GetFullPath($Workspace)

if (Test-Path -LiteralPath $workspacePath) {
  if (-not (Test-Path -LiteralPath (Join-Path $workspacePath '.git'))) {
    throw "Workspace exists but is not a Git repository: $workspacePath"
  }
  $head = git -C $workspacePath rev-parse HEAD
  if ($head -ne $config.base_commit) {
    throw "Unexpected workspace commit. Actual: $head; expected: $($config.base_commit)"
  }
  if (git -C $workspacePath status --porcelain) {
    throw 'Workspace is not clean. Use a new -Workspace path so existing work is preserved.'
  }
} else {
  New-Item -ItemType Directory -Path (Split-Path $workspacePath -Parent) -Force | Out-Null
  New-Item -ItemType Directory -Path $workspacePath -Force | Out-Null
  # Fetch only the task base commit. A normal clone leaves origin/main and
  # future commits visible through `git log --all`, leaking the golden fix.
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
if (-not (Select-String -LiteralPath $excludePath -SimpleMatch '.codebuddy/' -Quiet -ErrorAction SilentlyContinue)) {
  Add-Content -LiteralPath $excludePath -Value "`n.codebuddy/`n"
}

if (-not $SkipInstall) {
  $envName = $config.conda_environment
  $existing = conda env list --json | ConvertFrom-Json
  $found = $existing.envs | Where-Object { (Split-Path $_ -Leaf) -eq $envName }
  if (-not $found) {
    $source = $existing.envs | Where-Object { (Split-Path $_ -Leaf) -eq 'doc2feat-seaborn-2643' } | Select-Object -First 1
    if ($source) {
      conda create -y -n $envName --clone $source
    } else {
      conda create -y -n $envName python=3.8
      conda run -n $envName python -m pip install `
        'matplotlib==3.7.5' 'numpy==1.24.3' 'pandas==1.5.3' `
        'scipy==1.10.1' 'pytest<8' 'flit_core>=3.2,<4'
    }
  }
  conda run -n $envName python -m pip install --no-deps -e $workspacePath
}

Write-Host "Prepared clean workspace: $workspacePath"
Write-Host "Base commit: $($config.base_commit)"
Write-Host "Conda environment: $($config.conda_environment)"
