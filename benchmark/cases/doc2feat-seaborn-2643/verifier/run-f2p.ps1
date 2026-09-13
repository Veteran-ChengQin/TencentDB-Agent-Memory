param(
  [string]$Workspace = (Join-Path $PSScriptRoot '..\workspace'),
  [string]$CondaEnvironment = 'doc2feat-seaborn-2643'
)

$ErrorActionPreference = 'Stop'
$testFile = Join-Path $Workspace 'seaborn\tests\_doc2feat_2643_f2p.py'
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'test_move_legend_doc2feat.py') -Destination $testFile -Force
try {
  Push-Location $Workspace
  conda run -n $CondaEnvironment python -m pytest -q `
    'seaborn/tests/_doc2feat_2643_f2p.py::test_move_legend_input_checks' `
    'seaborn/tests/test_utils.py::test_load_datasets' `
    'seaborn/tests/_doc2feat_2643_f2p.py::test_move_legend_matplotlib_objects' `
    'seaborn/tests/_doc2feat_2643_f2p.py::test_move_legend_grid_object'
  $testExit = $LASTEXITCODE
} finally {
  Pop-Location
  Remove-Item -LiteralPath $testFile -Force -ErrorAction SilentlyContinue
}
exit $testExit
