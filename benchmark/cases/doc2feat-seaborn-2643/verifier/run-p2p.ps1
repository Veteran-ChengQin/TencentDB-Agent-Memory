param(
  [string]$Workspace = (Join-Path $PSScriptRoot '..\workspace'),
  [string]$CondaEnvironment = 'doc2feat-seaborn-2643'
)

$ErrorActionPreference = 'Stop'
Push-Location $Workspace
try {
  conda run -n $CondaEnvironment python -m pytest -q `
    'seaborn/tests/test_utils.py::test_draw_figure' `
    'seaborn/tests/test_utils.py::test_get_dataset_names' `
    'seaborn/tests/test_utils.py::test_desaturate' `
    'seaborn/tests/test_utils.py::test_saturate' `
    'seaborn/tests/test_utils.py::test_assign_default_kwargs' `
    'seaborn/tests/test_utils.py::test_relative_luminance'
  $testExit = $LASTEXITCODE
} finally {
  Pop-Location
}
exit $testExit
