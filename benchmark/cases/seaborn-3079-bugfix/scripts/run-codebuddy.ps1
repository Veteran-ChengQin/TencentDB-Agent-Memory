param(
  [string]$Workspace = (Join-Path $PSScriptRoot '..\workspaces\codebuddy-sol-500'),
  [string]$RuntimeDir = (Join-Path $PSScriptRoot '..\artifacts\runtime'),
  [int]$MaxTurns = 500,
  [string]$Model = 'gpt-5.6-sol'
)

$ErrorActionPreference = 'Stop'
$caseRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$repoRoot = (Resolve-Path (Join-Path $caseRoot '..\..\..')).Path
$runtimeDir = [IO.Path]::GetFullPath($RuntimeDir)
$workspacePath = [IO.Path]::GetFullPath($Workspace)
$contextPath = Join-Path $runtimeDir 'tdai-context.json'
if (-not (Test-Path -LiteralPath $contextPath)) { throw 'Run prepare-tdai-context.mjs first.' }
if (-not (Test-Path -LiteralPath (Join-Path $workspacePath '.git'))) { throw 'Run prepare-workspace.ps1 first.' }

$context = Get-Content -Raw -Encoding utf8 $contextPath | ConvertFrom-Json
$config = Get-Content -Raw -Encoding utf8 (Join-Path $caseRoot 'case-config.json') | ConvertFrom-Json
$condaInfo = conda env list --json | ConvertFrom-Json
$condaPrefix = $condaInfo.envs | Where-Object { (Split-Path $_ -Leaf) -eq $config.conda_environment } | Select-Object -First 1
if (-not $condaPrefix) { throw 'Conda environment is missing. Run prepare-workspace.ps1 first.' }

$userKey = if ($env:TDAI_USER_KEY) { $env:TDAI_USER_KEY } else {
  (Get-Content -Raw -Encoding utf8 (Join-Path $repoRoot 'deploy\global-images\.admin-key')).Trim()
}
$proxyPort = if ($env:TDAI_PROXY_PORT) { $env:TDAI_PROXY_PORT } else { '8096' }
$proxyUrl = "http://127.0.0.1:$proxyPort/codebuddy/$($context.instance_id)/v1/chat/completions"
$modelTemplate = Get-Content -Raw -Encoding utf8 (Join-Path $caseRoot 'assets\codebuddy-models.template.json')
$modelConfig = $modelTemplate.Replace('__MODEL_ID__', $Model).Replace('__TDAI_USER_KEY__', $userKey).Replace('__TDAI_PROXY_URL__', $proxyUrl)
$codebuddyDir = Join-Path $env:USERPROFILE '.codebuddy'
New-Item -ItemType Directory -Path $codebuddyDir -Force | Out-Null
$modelConfigPath = Join-Path $codebuddyDir 'models.json'
$hadModelsFile = Test-Path -LiteralPath $modelConfigPath
$previousModelsJson = if ($hadModelsFile) { Get-Content -Raw -Encoding utf8 $modelConfigPath } else { $null }
[IO.File]::WriteAllText($modelConfigPath, $modelConfig, [Text.UTF8Encoding]::new($false))

$previousPath = $env:PATH
$previousCondaPrefix = $env:CONDA_PREFIX
$previousCondaDefaultEnv = $env:CONDA_DEFAULT_ENV
$previousMplBackend = $env:MPLBACKEND
$env:PATH = "$condaPrefix;$condaPrefix\Scripts;$condaPrefix\Library\bin;$previousPath"
$env:CONDA_PREFIX = $condaPrefix
$env:CONDA_DEFAULT_ENV = $config.conda_environment
$env:MPLBACKEND = 'Agg'

$sessionId = 'seaborn-3079-' + [guid]::NewGuid().ToString('N')
$sessionRecord = [ordered]@{
  session_id = $sessionId
  harness = 'CodeBuddy Code'
  model = $Model
  request_model = $Model
  connection_mode = 'tdai_proxy'
  started_at = (Get-Date).ToUniversalTime().ToString('o')
}
[IO.File]::WriteAllText((Join-Path $runtimeDir 'codebuddy-session.json'), ($sessionRecord | ConvertTo-Json), [Text.UTF8Encoding]::new($false))
$instruction = Get-Content -Raw -Encoding utf8 (Join-Path $caseRoot 'instruction.zh-CN.md')
$transcriptPath = Join-Path $runtimeDir 'codebuddy-session.jsonl'

# Windows PowerShell 5.1 uses ASCII for native-process stdin by default.
# Force UTF-8 in both directions so Chinese task text and streamed JSON survive.
$previousOutputEncoding = $OutputEncoding
$previousConsoleOutputEncoding = [Console]::OutputEncoding
$utf8NoBom = [Text.UTF8Encoding]::new($false)
$OutputEncoding = $utf8NoBom
[Console]::OutputEncoding = $utf8NoBom

try {
  Push-Location $workspacePath
  $instruction | & codebuddy -p -y --output-format stream-json --model $Model --session-id $sessionId --max-turns $MaxTurns `
    -H "x-team-id: $($context.team_id)" `
    -H "x-agent-id: $($context.agent_id)" `
    -H "x-task-id: $($context.task_id)" `
    --disallowedTools EnterPlanMode ExitPlanMode `
    2>&1 | Tee-Object -FilePath $transcriptPath
  $exitCode = $LASTEXITCODE
} finally {
  Pop-Location
  $env:PATH = $previousPath
  if ($null -eq $previousCondaPrefix) { Remove-Item Env:CONDA_PREFIX -ErrorAction SilentlyContinue } else { $env:CONDA_PREFIX = $previousCondaPrefix }
  if ($null -eq $previousCondaDefaultEnv) { Remove-Item Env:CONDA_DEFAULT_ENV -ErrorAction SilentlyContinue } else { $env:CONDA_DEFAULT_ENV = $previousCondaDefaultEnv }
  if ($null -eq $previousMplBackend) { Remove-Item Env:MPLBACKEND -ErrorAction SilentlyContinue } else { $env:MPLBACKEND = $previousMplBackend }
  if ($hadModelsFile) {
    [IO.File]::WriteAllText($modelConfigPath, $previousModelsJson, [Text.UTF8Encoding]::new($false))
  } else {
    Remove-Item -LiteralPath $modelConfigPath -Force -ErrorAction SilentlyContinue
  }
  $OutputEncoding = $previousOutputEncoding
  [Console]::OutputEncoding = $previousConsoleOutputEncoding
}

$lines = Get-Content -Encoding utf8 $transcriptPath
$resultLine = $lines | Where-Object { $_ -match '"type":"result"' } | Select-Object -Last 1
$turns = $null
if ($resultLine -match '"num_turns":(\d+)') { $turns = [int]$Matches[1] }
$failed = $exitCode -ne 0 -or ($resultLine -and $resultLine -match '"is_error":true')
$sessionRecord.outcome = if ($failed) { 'failed' } else { 'completed' }
$sessionRecord.turns = $turns
$sessionRecord.finished_at = (Get-Date).ToUniversalTime().ToString('o')
$sessionRecord.exit_code = $exitCode
[IO.File]::WriteAllText((Join-Path $runtimeDir 'codebuddy-session.json'), ($sessionRecord | ConvertTo-Json), [Text.UTF8Encoding]::new($false))
if ($failed) { throw "CodeBuddy failed; inspect $transcriptPath" }
if (-not (git -C $workspacePath status --porcelain)) { throw 'CodeBuddy completed without changing the workspace.' }
