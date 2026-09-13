param(
  [string]$Workspace = (Join-Path $PSScriptRoot '..\workspace'),
  [string]$RuntimeDir = (Join-Path $PSScriptRoot '..\artifacts\runtime')
)

$ErrorActionPreference = 'Stop'
$caseRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$runtimeDir = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($RuntimeDir)
$contextPath = Join-Path $runtimeDir 'tdai-context.json'
$manifestPath = Join-Path $runtimeDir 'run-manifest.json'
if (-not (Test-Path -LiteralPath $contextPath)) {
  throw "tdai-context.json is missing: $runtimeDir"
}
if (-not (Test-Path -LiteralPath $manifestPath)) {
  throw "run-manifest.json is missing: $runtimeDir"
}
$config = Get-Content -Raw -Encoding utf8 (Join-Path $caseRoot 'case-config.json') | ConvertFrom-Json
$envName = $config.conda_environment
$logPath = Join-Path $runtimeDir 'test-results.log'
$f2pXmlPath = Join-Path $runtimeDir 'f2p-junit.xml'
$p2pXmlPath = Join-Path $runtimeDir 'p2p-junit.xml'
New-Item -ItemType Directory -Path $runtimeDir -Force | Out-Null

$testFile = Join-Path $Workspace 'seaborn\tests\_doc2feat_2643_f2p.py'
Copy-Item -LiteralPath (Join-Path $caseRoot 'verifier\test_move_legend_doc2feat.py') -Destination $testFile -Force
$previousMplBackend = $env:MPLBACKEND
$env:MPLBACKEND = 'Agg'
try {
  Push-Location $Workspace
  "=== Doc2Feat F2P ===" | Set-Content -Encoding utf8 $logPath
  $testErrorPreference = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  conda run -n $envName python -m pytest -q `
    "--junitxml=$f2pXmlPath" `
    'seaborn/tests/_doc2feat_2643_f2p.py::test_move_legend_input_checks' `
    'seaborn/tests/test_utils.py::test_load_datasets' `
    'seaborn/tests/_doc2feat_2643_f2p.py::test_move_legend_matplotlib_objects' `
    'seaborn/tests/_doc2feat_2643_f2p.py::test_move_legend_grid_object' 2>&1 | Tee-Object -FilePath $logPath -Append
  $f2pExit = $LASTEXITCODE
  "`n=== Selected P2P regression ===" | Add-Content -Encoding utf8 $logPath
  conda run -n $envName python -m pytest -q `
    "--junitxml=$p2pXmlPath" `
    'seaborn/tests/test_utils.py::test_draw_figure' `
    'seaborn/tests/test_utils.py::test_get_dataset_names' `
    'seaborn/tests/test_utils.py::test_desaturate' `
    'seaborn/tests/test_utils.py::test_saturate' `
    'seaborn/tests/test_utils.py::test_assign_default_kwargs' `
    'seaborn/tests/test_utils.py::test_relative_luminance' 2>&1 | Tee-Object -FilePath $logPath -Append
  $p2pExit = $LASTEXITCODE
  $ErrorActionPreference = $testErrorPreference
} finally {
  $ErrorActionPreference = 'Stop'
  Pop-Location
  Remove-Item -LiteralPath $testFile -Force -ErrorAction SilentlyContinue
  if ($null -eq $previousMplBackend) { Remove-Item Env:MPLBACKEND -ErrorAction SilentlyContinue } else { $env:MPLBACKEND = $previousMplBackend }
}

$patchText = git -C $Workspace diff --binary -- . | Out-String
[IO.File]::WriteAllText((Join-Path $runtimeDir 'change.patch'), $patchText, [Text.UTF8Encoding]::new($false))
$repoRoot = (Resolve-Path (Join-Path $caseRoot '..\..\..')).Path
node (Join-Path $repoRoot 'benchmark\lib\task-run-finalizer.mjs') --manifest $manifestPath
if ($LASTEXITCODE -ne 0) { throw 'Task artifact synchronization failed.' }
if ($f2pExit -ne 0 -or $p2pExit -ne 0) { exit 1 }
