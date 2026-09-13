param(
  [string]$Workspace = (Join-Path $PSScriptRoot '..\workspaces\golden-local'),
  [string]$RuntimeDir = (Join-Path $PSScriptRoot '..\artifacts\runs\golden'),
  [string]$SourceWorkspace = (Join-Path $PSScriptRoot '..\workspace')
)

$ErrorActionPreference = 'Stop'
$caseRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$config = Get-Content -Raw -Encoding utf8 (Join-Path $caseRoot 'case-config.json') | ConvertFrom-Json
$workspacePath = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($Workspace)
$runtimePath = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($RuntimeDir)
$sourcePath = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($SourceWorkspace)

if (-not (Test-Path -LiteralPath (Join-Path $workspacePath '.git'))) {
  New-Item -ItemType Directory -Path (Split-Path $workspacePath -Parent) -Force | Out-Null
  git -C $sourcePath worktree add --detach $workspacePath $config.reference_merge_commit
  if ($LASTEXITCODE -ne 0) { throw 'Failed to create Golden worktree from the local object store.' }
  git -C $workspacePath reset --soft $config.base_commit
  git -C $workspacePath reset --quiet
}

$head = git -C $workspacePath rev-parse HEAD
if ($head -ne $config.base_commit) { throw "Unexpected Golden workspace HEAD: $head" }
if (-not (git -C $workspacePath status --porcelain)) { throw 'Golden workspace has no patch.' }

New-Item -ItemType Directory -Path $runtimePath -Force | Out-Null
$env:DOC2FEAT_RUNTIME_DIR = $runtimePath
$env:DOC2FEAT_RUN_KIND = 'golden'
node (Join-Path $PSScriptRoot 'create-tdai-task.mjs')

$context = Get-Content -Raw -Encoding utf8 (Join-Path $runtimePath 'tdai-context.json') | ConvertFrom-Json
$session = [ordered]@{
  session_id = 'golden-patch-2643-' + [guid]::NewGuid().ToString('N')
  harness = 'Doc2Feat Golden Patch Validator'
  model = 'reference-oracle'
  connection_mode = 'local_reference'
  run_kind = 'golden'
  reference_commit = $config.reference_merge_commit
  started_at = (Get-Date).ToUniversalTime().ToString('o')
  finished_at = (Get-Date).ToUniversalTime().ToString('o')
  outcome = 'completed'
  outcome_summary = 'Golden Patch applied; pending independent F2P/P2P verification.'
  exit_code = 0
}
[IO.File]::WriteAllText((Join-Path $runtimePath 'codebuddy-session.json'), ($session | ConvertTo-Json), [Text.UTF8Encoding]::new($false))

& (Join-Path $PSScriptRoot 'verify-and-collect.ps1') -Workspace $workspacePath -RuntimeDir $runtimePath
if ($LASTEXITCODE -ne 0) { throw 'Golden Patch failed independent verification.' }

Write-Host "Golden asset-chain validation completed: $($context.task_id)"
