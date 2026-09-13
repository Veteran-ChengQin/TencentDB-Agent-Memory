param(
  [string]$Workspace = (Join-Path $PSScriptRoot '..\workspaces\codebuddy-sol-500'),
  [string]$RuntimeDir = (Join-Path $PSScriptRoot '..\artifacts\runtime'),
  [switch]$ExpectF2PFailure
)

$ErrorActionPreference = 'Stop'
$caseRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$config = Get-Content -Raw -Encoding utf8 (Join-Path $caseRoot 'case-config.json') | ConvertFrom-Json
$runtimeDir = [IO.Path]::GetFullPath($RuntimeDir)
New-Item -ItemType Directory -Path $runtimeDir -Force | Out-Null
$testFile = Join-Path $Workspace 'tests\_tdai_3079_f2p.py'
Copy-Item -LiteralPath (Join-Path $caseRoot 'verifier\test_move_legend_labels.py') -Destination $testFile -Force
$logPath = Join-Path $runtimeDir 'test-results.log'
$f2pXml = Join-Path $runtimeDir 'f2p-junit.xml'
$p2pXml = Join-Path $runtimeDir 'p2p-junit.xml'
$previousMplBackend = $env:MPLBACKEND
$env:MPLBACKEND = 'Agg'

try {
  Push-Location $Workspace
  '=== F2P: Issue #3079 ===' | Set-Content -Encoding utf8 $logPath
  $oldPreference = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  conda run -n $config.conda_environment python -m pytest -q "--junitxml=$f2pXml" @($config.fail_to_pass) 2>&1 | Tee-Object -FilePath $logPath -Append
  $f2pExit = $LASTEXITCODE
  "`n=== P2P: selected regressions ===" | Add-Content -Encoding utf8 $logPath
  conda run -n $config.conda_environment python -m pytest -q "--junitxml=$p2pXml" @($config.pass_to_pass) 2>&1 | Tee-Object -FilePath $logPath -Append
  $p2pExit = $LASTEXITCODE
  $ErrorActionPreference = $oldPreference
} finally {
  $ErrorActionPreference = 'Stop'
  Pop-Location
  Remove-Item -LiteralPath $testFile -Force -ErrorAction SilentlyContinue
  if ($null -eq $previousMplBackend) { Remove-Item Env:MPLBACKEND -ErrorAction SilentlyContinue } else { $env:MPLBACKEND = $previousMplBackend }
}

$patchText = git -C $Workspace diff --binary -- . | Out-String
[IO.File]::WriteAllText((Join-Path $runtimeDir 'change.patch'), $patchText, [Text.UTF8Encoding]::new($false))
[IO.File]::WriteAllText((Join-Path $runtimeDir 'verification-summary.json'), (@{
  f2p_exit = $f2pExit
  p2p_exit = $p2pExit
  expected_f2p_failure = [bool]$ExpectF2PFailure
} | ConvertTo-Json), [Text.UTF8Encoding]::new($false))

# A TDAI-associated run must never finish verification without synchronizing
# its artifacts. The manifest contains task data only; collection and metadata
# updates are implemented by the shared finalizer.
$contextPath = Join-Path $runtimeDir 'tdai-context.json'
if (Test-Path -LiteralPath $contextPath) {
  $manifestPath = Join-Path $runtimeDir 'run-manifest.json'
  if (-not (Test-Path -LiteralPath $manifestPath)) {
    throw "TDAI run context exists but run-manifest.json is missing: $runtimeDir"
  }
  $repoRoot = (Resolve-Path (Join-Path $caseRoot '..\..\..')).Path
  node (Join-Path $repoRoot 'benchmark\lib\task-run-finalizer.mjs') --manifest $manifestPath
  if ($LASTEXITCODE -ne 0) { throw 'Task artifact synchronization failed.' }
}

if ($p2pExit -ne 0) { exit 2 }
if ($ExpectF2PFailure) {
  if ($f2pExit -eq 0) { throw 'Baseline unexpectedly passes F2P.' }
  exit 0
}
if ($f2pExit -ne 0) { exit 1 }
