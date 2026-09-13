param(
  [string]$Workspace = (Join-Path $PSScriptRoot '..\workspaces\codex-sol'),
  [string]$RuntimeDir = (Join-Path $PSScriptRoot '..\artifacts\runs\codex-sol'),
  [string]$Model = 'gpt-5.6-sol'
)

$ErrorActionPreference = 'Stop'
$caseRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$runtimeDir = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($RuntimeDir)
$workspacePath = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($Workspace)
$null = New-Item -ItemType Directory -Path $runtimeDir -Force

function Resolve-CodexNativeExecutable {
  # On Windows, piping a prompt through npm's codex.ps1 shim can turn ordinary
  # native stderr diagnostics into a terminating NativeCommandError. Prefer the
  # native executable shipped by the installed @openai/codex package.
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

$codexExecutable = Resolve-CodexNativeExecutable
$contextPath = Join-Path $runtimeDir 'tdai-context.json'
if (-not (Test-Path -LiteralPath $contextPath)) {
  throw 'tdai-context.json is missing. Create the TDAI task before running Codex.'
}
if (-not (Test-Path -LiteralPath (Join-Path $workspacePath '.git'))) {
  throw 'The clean Seaborn workspace is missing. Run prepare-workspace.ps1 first.'
}

$config = Get-Content -Raw -Encoding utf8 (Join-Path $caseRoot 'case-config.json') | ConvertFrom-Json
$condaInfo = conda env list --json | ConvertFrom-Json
$condaPrefix = $condaInfo.envs | Where-Object { (Split-Path $_ -Leaf) -eq $config.conda_environment } | Select-Object -First 1
if (-not $condaPrefix) {
  throw 'The Conda test environment is missing. Run prepare-workspace.ps1 first.'
}

$previousPath = $env:PATH
$previousCondaPrefix = $env:CONDA_PREFIX
$previousCondaDefaultEnv = $env:CONDA_DEFAULT_ENV
$env:PATH = "$condaPrefix;$condaPrefix\Scripts;$condaPrefix\Library\bin;$previousPath"
$env:CONDA_PREFIX = $condaPrefix
$env:CONDA_DEFAULT_ENV = $config.conda_environment

$sessionId = 'codex-doc2feat-seaborn-2643-' + [guid]::NewGuid().ToString('N')
$sessionRecord = [ordered]@{
  session_id = $sessionId
  harness = 'Codex CLI'
  model = $Model
  request_model = $Model
  connection_mode = 'openai_direct'
  run_kind = 'codex'
  started_at = (Get-Date).ToUniversalTime().ToString('o')
}
$sessionPath = Join-Path $runtimeDir 'codebuddy-session.json'
$transcriptPath = Join-Path $runtimeDir 'codebuddy-session.jsonl'
$stderrPath = Join-Path $runtimeDir 'codex-stderr.log'
$lastMessagePath = Join-Path $runtimeDir 'codex-last-message.md'
[IO.File]::WriteAllText($sessionPath, ($sessionRecord | ConvertTo-Json), [Text.UTF8Encoding]::new($false))
$isolationNotice = @'
EVALUATION ISOLATION RULES:
- Use only files present in the current workspace and the task description below.
- Do not use web search, browsers, network access, Git remotes, future branches, reflogs, or hidden Git objects.
- Do not look up the referenced pull request, issue, release, benchmark, or an upstream implementation.
- The evaluator will reject a solution derived from future project history.
'@
$testPython = Join-Path $condaPrefix 'python.exe'
$testNotice = @"
TEST ENVIRONMENT:
- The repository test environment is already prepared.
- Do not use plain `python` or `py`; they may resolve to the base environment.
- Run tests with the exact interpreter: & '$testPython' -m pytest <test targets>
"@
$instruction = $isolationNotice + "`r`n" + $testNotice + "`r`n" + (Get-Content -Raw -Encoding utf8 (Join-Path $caseRoot 'instruction.zh-CN.md'))

# Keep both directions of the Windows PowerShell/native-process boundary in
# UTF-8. `$OutputEncoding` controls the prompt sent on stdin; console output
# encoding controls how the JSONL emitted by Codex is decoded before capture.
$previousOutputEncoding = $OutputEncoding
$previousConsoleOutputEncoding = [Console]::OutputEncoding
$utf8NoBom = [Text.UTF8Encoding]::new($false)
$OutputEncoding = $utf8NoBom
[Console]::OutputEncoding = $utf8NoBom

try {
  $commandErrorPreference = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  $instruction | & $codexExecutable exec `
    --ignore-user-config `
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
  $OutputEncoding = $previousOutputEncoding
  [Console]::OutputEncoding = $previousConsoleOutputEncoding
}

# Windows PowerShell may write UTF-16LE through Tee-Object; normalize it to UTF-8.
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

if ($exitCode -ne 0) { throw "Codex failed with exit code: $exitCode" }
if (-not $turnEvent) {
  throw "Codex exited before completing a turn. See diagnostics: $stderrPath"
}
if (-not (git -C $workspacePath status --porcelain)) {
  throw 'Codex finished successfully but did not change the workspace.'
}
