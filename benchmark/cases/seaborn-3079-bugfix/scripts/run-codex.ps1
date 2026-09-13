param(
  [string]$Workspace = (Join-Path $PSScriptRoot '..\workspaces\codex-sol'),
  [string]$RuntimeDir = (Join-Path $PSScriptRoot '..\artifacts\codex-sol'),
  [string]$Model = 'gpt-5.6-sol'
)

$ErrorActionPreference = 'Stop'
$caseRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$repoRoot = (Resolve-Path (Join-Path $caseRoot '..\..\..')).Path
$runtimeDir = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($RuntimeDir)
$workspacePath = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($Workspace)
$null = New-Item -ItemType Directory -Path $runtimeDir -Force

function Resolve-CodexNativeExecutable {
  $npmCommand = Get-Command npm.cmd -ErrorAction SilentlyContinue
  if (-not $npmCommand) { $npmCommand = Get-Command npm -ErrorAction SilentlyContinue }
  if ($npmCommand) {
    $npmRootOutput = & $npmCommand.Source root -g 2>$null
    $npmRoot = ($npmRootOutput | Select-Object -First 1).Trim()
    if ($npmRoot) {
      $codexPackageModules = Join-Path $npmRoot '@openai\codex\node_modules\@openai'
      if (Test-Path -LiteralPath $codexPackageModules) {
        $packagedExecutable = Get-ChildItem -LiteralPath $codexPackageModules `
          -Filter 'codex.exe' -File -Recurse -ErrorAction SilentlyContinue |
          Where-Object { $_.FullName -match '[\\/]codex-win32-[^\\/]+[\\/]' } |
          Select-Object -First 1
        if ($packagedExecutable) { return $packagedExecutable.FullName }
      }
    }
  }

  $pathExecutable = Get-Command codex.exe -ErrorAction SilentlyContinue
  if ($pathExecutable) { return $pathExecutable.Source }
  throw 'Cannot find the native Codex executable. Install @openai/codex or add codex.exe to PATH.'
}

function ConvertTo-TomlString([string]$Value) {
  return $Value.Replace('\', '\\').Replace('"', '\"')
}

$codexExecutable = Resolve-CodexNativeExecutable
$contextPath = Join-Path $runtimeDir 'tdai-context.json'
if (-not (Test-Path -LiteralPath $contextPath)) { throw 'Run prepare-tdai-context.mjs first.' }
if (-not (Test-Path -LiteralPath (Join-Path $workspacePath '.git'))) { throw 'Run prepare-workspace.ps1 first.' }

$context = Get-Content -Raw -Encoding utf8 $contextPath | ConvertFrom-Json
foreach ($property in @('instance_id', 'team_id', 'agent_id', 'task_id')) {
  if (-not $context.$property) { throw "tdai-context.json is missing $property" }
}
$config = Get-Content -Raw -Encoding utf8 (Join-Path $caseRoot 'case-config.json') | ConvertFrom-Json
$condaInfo = conda env list --json | ConvertFrom-Json
$condaPrefix = $condaInfo.envs | Where-Object { (Split-Path $_ -Leaf) -eq $config.conda_environment } | Select-Object -First 1
if (-not $condaPrefix) { throw 'Conda environment is missing. Run prepare-workspace.ps1 first.' }

$userKey = if ($env:TDAI_USER_KEY) { $env:TDAI_USER_KEY.Trim() } else {
  (Get-Content -Raw -Encoding utf8 (Join-Path $repoRoot 'deploy\global-images\.admin-key')).Trim()
}
$proxyPort = if ($env:TDAI_PROXY_PORT) { $env:TDAI_PROXY_PORT } else { '8096' }
$proxyBaseUrl = "http://127.0.0.1:$proxyPort/codex/$($context.instance_id)/v1"
$codexHome = Join-Path $runtimeDir 'codex-home'
$null = New-Item -ItemType Directory -Path $codexHome -Force
$codexConfigPath = Join-Path $codexHome 'config.toml'
$codexConfig = @"
model = "$(ConvertTo-TomlString $Model)"
model_provider = "tdai"
suppress_unstable_features_warning = true

[model_providers.tdai]
name = "TDAI MemoryProxy"
base_url = "$(ConvertTo-TomlString $proxyBaseUrl)"
env_key = "OPENAI_API_KEY"
wire_api = "responses"
http_headers = { "x-team-id" = "$(ConvertTo-TomlString $context.team_id)", "x-agent-id" = "$(ConvertTo-TomlString $context.agent_id)", "x-task-id" = "$(ConvertTo-TomlString $context.task_id)" }

[features]
default_mode_request_user_input = true
"@
[IO.File]::WriteAllText($codexConfigPath, $codexConfig, [Text.UTF8Encoding]::new($false))

$sessionRecord = [ordered]@{
  session_id = 'codex-seaborn-3079-' + [guid]::NewGuid().ToString('N')
  harness = 'Codex CLI'
  model = $Model
  request_model = $Model
  connection_mode = 'tdai_proxy'
  run_kind = 'codex'
  started_at = (Get-Date).ToUniversalTime().ToString('o')
}
$sessionPath = Join-Path $runtimeDir 'codebuddy-session.json'
$transcriptPath = Join-Path $runtimeDir 'codebuddy-session.jsonl'
$stderrPath = Join-Path $runtimeDir 'codex-stderr.log'
$lastMessagePath = Join-Path $runtimeDir 'codex-last-message.md'
[IO.File]::WriteAllText($sessionPath, ($sessionRecord | ConvertTo-Json), [Text.UTF8Encoding]::new($false))

$testPython = Join-Path $condaPrefix 'python.exe'
$instruction = @"
EVALUATION ISOLATION RULES:
- Use only files present in the current workspace, the task description, and assets exposed by TDAI.
- Do not use web search, Git remotes, future branches, reflogs, hidden Git objects, or upstream fixes.
- Run tests with the exact interpreter: & '$testPython' -m pytest <test targets>

$(Get-Content -Raw -Encoding utf8 (Join-Path $caseRoot 'instruction.zh-CN.md'))
"@

$previousPath = $env:PATH
$previousCondaPrefix = $env:CONDA_PREFIX
$previousCondaDefaultEnv = $env:CONDA_DEFAULT_ENV
$previousMplBackend = $env:MPLBACKEND
$previousCodexHome = $env:CODEX_HOME
$previousOpenAiApiKey = $env:OPENAI_API_KEY
$previousOutputEncoding = $OutputEncoding
$previousConsoleOutputEncoding = [Console]::OutputEncoding
$utf8NoBom = [Text.UTF8Encoding]::new($false)
$env:PATH = "$condaPrefix;$condaPrefix\Scripts;$condaPrefix\Library\bin;$previousPath"
$env:CONDA_PREFIX = $condaPrefix
$env:CONDA_DEFAULT_ENV = $config.conda_environment
$env:MPLBACKEND = 'Agg'
$env:CODEX_HOME = $codexHome
$env:OPENAI_API_KEY = $userKey
$OutputEncoding = $utf8NoBom
[Console]::OutputEncoding = $utf8NoBom

try {
  $commandErrorPreference = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  $instruction | & $codexExecutable exec `
    --ignore-rules `
    --ephemeral `
    --disable browser_use `
    --disable browser_use_external `
    --disable in_app_browser `
    --disable standalone_web_search `
    --json `
    --color never `
    --model $Model `
    --approve-for-me `
    --cd $workspacePath `
    --output-last-message $lastMessagePath `
    - 2> $stderrPath | Tee-Object -FilePath $transcriptPath
  $exitCode = $LASTEXITCODE
} finally {
  $ErrorActionPreference = $commandErrorPreference
  $env:PATH = $previousPath
  if ($null -eq $previousCondaPrefix) { Remove-Item Env:CONDA_PREFIX -ErrorAction SilentlyContinue } else { $env:CONDA_PREFIX = $previousCondaPrefix }
  if ($null -eq $previousCondaDefaultEnv) { Remove-Item Env:CONDA_DEFAULT_ENV -ErrorAction SilentlyContinue } else { $env:CONDA_DEFAULT_ENV = $previousCondaDefaultEnv }
  if ($null -eq $previousMplBackend) { Remove-Item Env:MPLBACKEND -ErrorAction SilentlyContinue } else { $env:MPLBACKEND = $previousMplBackend }
  if ($null -eq $previousCodexHome) { Remove-Item Env:CODEX_HOME -ErrorAction SilentlyContinue } else { $env:CODEX_HOME = $previousCodexHome }
  if ($null -eq $previousOpenAiApiKey) { Remove-Item Env:OPENAI_API_KEY -ErrorAction SilentlyContinue } else { $env:OPENAI_API_KEY = $previousOpenAiApiKey }
  $OutputEncoding = $previousOutputEncoding
  [Console]::OutputEncoding = $previousConsoleOutputEncoding
}

$transcriptBytes = [IO.File]::ReadAllBytes($transcriptPath)
$isUtf16Le = $transcriptBytes.Length -ge 2 -and $transcriptBytes[0] -eq 0xFF -and $transcriptBytes[1] -eq 0xFE
$transcriptLines = if ($isUtf16Le) { Get-Content -Encoding Unicode $transcriptPath } else { Get-Content -Encoding utf8 $transcriptPath }
if ($isUtf16Le) {
  [IO.File]::WriteAllLines($transcriptPath, $transcriptLines, [Text.UTF8Encoding]::new($false))
}
$events = @($transcriptLines | ForEach-Object {
  try { $_ | ConvertFrom-Json } catch { $null }
} | Where-Object { $null -ne $_ })
$threadEvent = $events | Where-Object { $_.type -eq 'thread.started' } | Select-Object -First 1
$turnEvents = @($events | Where-Object { $_.type -eq 'turn.completed' })
$turnEvent = $turnEvents | Select-Object -Last 1
if ($threadEvent.thread_id) {
  $sessionRecord.session_id = $threadEvent.thread_id
  $sessionRecord.codex_thread_id = $threadEvent.thread_id
}
$sessionRecord.outcome = if ($exitCode -eq 0 -and $turnEvent) { 'completed' } else { 'failed' }
$sessionRecord.turns = $turnEvents.Count
$sessionRecord.finished_at = (Get-Date).ToUniversalTime().ToString('o')
$sessionRecord.exit_code = $exitCode
[IO.File]::WriteAllText($sessionPath, ($sessionRecord | ConvertTo-Json), [Text.UTF8Encoding]::new($false))

if ($exitCode -ne 0) { throw "Codex failed with exit code $exitCode. See $stderrPath" }
if (-not $turnEvent) { throw "Codex exited before completing a turn. See $stderrPath" }
if (-not (git -C $workspacePath status --porcelain)) { throw 'Codex completed without changing the workspace.' }
