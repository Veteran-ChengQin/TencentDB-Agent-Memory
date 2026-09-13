param(
  [string]$Workspace = (Join-Path $PSScriptRoot '..\workspace'),
  [string]$RuntimeDir = (Join-Path $PSScriptRoot '..\artifacts\runtime'),
  [int]$MaxTurns = 500,
  [string]$RequestModelId = '',
  [switch]$DirectCloud,
  [switch]$DebugCodeBuddy
)

$ErrorActionPreference = 'Stop'
$caseRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$repoRoot = (Resolve-Path (Join-Path $caseRoot '..\..\..')).Path
$runtimeDir = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($RuntimeDir)
$null = New-Item -ItemType Directory -Path $runtimeDir -Force
$contextPath = Join-Path $runtimeDir 'tdai-context.json'
if (-not (Test-Path -LiteralPath $contextPath)) {
  throw 'tdai-context.json is missing. Start TDAI and run node scripts/create-tdai-task.mjs first.'
}
$manifestPath = Join-Path $runtimeDir 'run-manifest.json'
if (-not (Test-Path -LiteralPath $manifestPath)) {
  throw 'run-manifest.json is missing. Complete section 6.3 before starting CodeBuddy.'
}
if (-not (Test-Path -LiteralPath (Join-Path $Workspace '.git'))) {
  throw 'Seaborn workspace is missing. Run scripts/prepare-workspace.ps1 first.'
}

$context = Get-Content -Raw -Encoding utf8 $contextPath | ConvertFrom-Json
$config = Get-Content -Raw -Encoding utf8 (Join-Path $caseRoot 'case-config.json') | ConvertFrom-Json
$condaInfo = conda env list --json | ConvertFrom-Json
$condaPrefix = $condaInfo.envs | Where-Object { (Split-Path $_ -Leaf) -eq $config.conda_environment } | Select-Object -First 1
if (-not $condaPrefix) {
  throw 'Conda environment is missing. Run scripts/prepare-workspace.ps1 first.'
}
$previousPath = $env:PATH
$previousCondaPrefix = $env:CONDA_PREFIX
$previousCondaDefaultEnv = $env:CONDA_DEFAULT_ENV
$env:PATH = "$condaPrefix;$condaPrefix\Scripts;$condaPrefix\Library\bin;$previousPath"
$env:CONDA_PREFIX = $condaPrefix
$env:CONDA_DEFAULT_ENV = $config.conda_environment
$modelId = if ($DirectCloud) {
  if ($env:CODEBUDDY_CLOUD_MODEL) { $env:CODEBUDDY_CLOUD_MODEL } else { 'glm-5.2' }
} else {
  if ($env:TDAI_UPSTREAM_MODEL) { $env:TDAI_UPSTREAM_MODEL } else { 'gpt-5.4' }
}
$requestModel = if ($RequestModelId) { $RequestModelId } else { $modelId }
$connectionMode = if ($DirectCloud) { 'codebuddy_cloud' } else { 'tdai_proxy' }
$modelConfigPath = $null
$hadModelsFile = $false
$previousModelsJson = $null
if (-not $DirectCloud) {
  $userKey = $env:TDAI_USER_KEY
  if (-not $userKey) {
    $userKey = (Get-Content -Raw -Encoding utf8 (Join-Path $repoRoot 'deploy\global-images\.admin-key')).Trim()
  }
  $proxyPort = if ($env:TDAI_PROXY_PORT) { $env:TDAI_PROXY_PORT } else { '8096' }
  # Current CodeBuddy custom-model configuration expects the complete
  # OpenAI-compatible chat-completions endpoint, not only a base URL.
  $proxyUrl = "http://127.0.0.1:$proxyPort/codebuddy/$($context.instance_id)/v1/chat/completions"
  $modelTemplate = Get-Content -Raw -Encoding utf8 (Join-Path $caseRoot 'assets\codebuddy-models.template.json')
  $modelConfig = $modelTemplate.Replace('__MODEL_ID__', $modelId).Replace('__TDAI_USER_KEY__', $userKey).Replace('__TDAI_PROXY_URL__', $proxyUrl)
  $codebuddyDir = Join-Path $env:USERPROFILE '.codebuddy'
  New-Item -ItemType Directory -Path $codebuddyDir -Force | Out-Null
  $modelConfigPath = Join-Path $codebuddyDir 'models.json'
  $hadModelsFile = Test-Path -LiteralPath $modelConfigPath
  $previousModelsJson = if ($hadModelsFile) { Get-Content -Raw -Encoding utf8 $modelConfigPath } else { $null }
  [IO.File]::WriteAllText($modelConfigPath, $modelConfig, [Text.UTF8Encoding]::new($false))
}

$sessionId = 'doc2feat-seaborn-2643-' + [guid]::NewGuid().ToString('N')
$sessionRecord = [ordered]@{
  session_id = $sessionId
  harness = 'CodeBuddy Code'
  model = $modelId
  request_model = $requestModel
  connection_mode = $connectionMode
  started_at = (Get-Date).ToUniversalTime().ToString('o')
}
$sessionJson = $sessionRecord | ConvertTo-Json
[IO.File]::WriteAllText((Join-Path $runtimeDir 'codebuddy-session.json'), $sessionJson, [Text.UTF8Encoding]::new($false))
$instruction = Get-Content -Raw -Encoding utf8 (Join-Path $caseRoot 'instruction.zh-CN.md')
$transcriptPath = Join-Path $runtimeDir 'codebuddy-session.jsonl'

# Windows PowerShell 5.1 defaults `$OutputEncoding` to ASCII. Without an
# explicit UTF-8 boundary, Chinese piped to the native CodeBuddy process is
# replaced with '?', while UTF-8 JSON emitted by CodeBuddy may be decoded with
# the active console code page and become mojibake before Tee-Object sees it.
$previousOutputEncoding = $OutputEncoding
$previousConsoleOutputEncoding = [Console]::OutputEncoding
$utf8NoBom = [Text.UTF8Encoding]::new($false)
$OutputEncoding = $utf8NoBom
[Console]::OutputEncoding = $utf8NoBom

try {
  Push-Location $Workspace
  $debugArgs = if ($DebugCodeBuddy) { @('--debug=config') } else { @() }
  if ($DirectCloud) {
    # Pipe the prompt through stdin. On Windows PowerShell, passing a multiline
    # prompt as a native-process argument can corrupt embedded quotes.
    $instruction | & codebuddy @debugArgs -p -y --output-format stream-json --model $requestModel --session-id $sessionId --max-turns $MaxTurns `
      --disallowedTools EnterPlanMode ExitPlanMode `
      2>&1 | Tee-Object -FilePath $transcriptPath
  } else {
    # -H is variadic in current CodeBuddy versions, so a trailing positional
    # prompt would be consumed as another header. Stdin keeps it unambiguous.
    $instruction | & codebuddy @debugArgs -p -y --output-format stream-json --model $requestModel --session-id $sessionId --max-turns $MaxTurns `
      -H "x-team-id: $($context.team_id)" `
      -H "x-agent-id: $($context.agent_id)" `
      -H "x-task-id: $($context.task_id)" `
      --disallowedTools EnterPlanMode ExitPlanMode `
      2>&1 | Tee-Object -FilePath $transcriptPath
  }
  $exitCode = $LASTEXITCODE
} finally {
  Pop-Location
  $env:PATH = $previousPath
  if ($null -eq $previousCondaPrefix) { Remove-Item Env:CONDA_PREFIX -ErrorAction SilentlyContinue } else { $env:CONDA_PREFIX = $previousCondaPrefix }
  if ($null -eq $previousCondaDefaultEnv) { Remove-Item Env:CONDA_DEFAULT_ENV -ErrorAction SilentlyContinue } else { $env:CONDA_DEFAULT_ENV = $previousCondaDefaultEnv }
  if ($modelConfigPath) {
    if ($hadModelsFile) {
      [IO.File]::WriteAllText($modelConfigPath, $previousModelsJson, [Text.UTF8Encoding]::new($false))
    } else {
      Remove-Item -LiteralPath $modelConfigPath -Force -ErrorAction SilentlyContinue
    }
  }
  $OutputEncoding = $previousOutputEncoding
  [Console]::OutputEncoding = $previousConsoleOutputEncoding
}

# CodeBuddy 某些版本在 stream-json 模式下遇到 max-turns 仍返回进程码 0，
# 因此以最后一条 result 事件为真实执行结果。
$transcriptBytes = [IO.File]::ReadAllBytes($transcriptPath)
$isUtf16Le = $transcriptBytes.Length -ge 2 -and $transcriptBytes[0] -eq 0xFF -and $transcriptBytes[1] -eq 0xFE
$transcriptLines = if ($isUtf16Le) { Get-Content -Encoding Unicode $transcriptPath } else { Get-Content -Encoding utf8 $transcriptPath }
if ($isUtf16Le) {
  [IO.File]::WriteAllLines($transcriptPath, $transcriptLines, [Text.UTF8Encoding]::new($false))
}
$resultLine = $transcriptLines | Where-Object { $_ -match '"type":"result"' } | Select-Object -Last 1
$resultTurns = $null
if ($resultLine -match '"num_turns":(\d+)') { $resultTurns = [int]$Matches[1] }
if ($resultLine -and $resultLine -match '"is_error":true') {
  $exitCode = 1
  $sessionRecord['outcome'] = 'failed'
  $outcomeSummary = if ($resultLine -match '"errors":\["([^"\\]*(?:\\.[^"\\]*)*)"') { $Matches[1] } else { $null }
  $sessionRecord['outcome_summary'] = if ($outcomeSummary) { $outcomeSummary } else { 'CodeBuddy 执行异常' }
  $sessionRecord['turns'] = $resultTurns
} else {
  $sessionRecord['outcome'] = 'completed'
  if ($resultLine) { $sessionRecord['turns'] = $resultTurns }
}

$sessionRecord.finished_at = (Get-Date).ToUniversalTime().ToString('o')
$sessionRecord.exit_code = $exitCode
$sessionJson = $sessionRecord | ConvertTo-Json
[IO.File]::WriteAllText((Join-Path $runtimeDir 'codebuddy-session.json'), $sessionJson, [Text.UTF8Encoding]::new($false))
if ($exitCode -ne 0) { throw "CodeBuddy failed with exit code: $exitCode" }
if (-not (git -C $Workspace status --porcelain)) {
  throw 'CodeBuddy returned successfully but did not change the workspace.'
}
