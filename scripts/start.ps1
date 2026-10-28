# Start the backend and Core; Electron is the normal user entry point.
$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
$AppData = if ($env:FATFISH_APPDATA) { $env:FATFISH_APPDATA } else { Join-Path $env:APPDATA "FatFish" }
$Secrets = Join-Path $AppData "secrets"
$Logs = Join-Path $AppData "logs"
$Runtime = Join-Path $AppData "runtime"
New-Item -ItemType Directory -Force -Path $Secrets, $Logs, $Runtime | Out-Null
$env:FATFISH_APPDATA = $AppData

function Resolve-Node {
  foreach ($candidate in @((Join-Path $Root "vendor\node\node.exe"), (Join-Path $Root "bin\node\node.exe"))) {
    if (Test-Path -LiteralPath $candidate) { return $candidate }
  }
  $cmd = Get-Command node -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  throw "未找到运行环境，请先运行 fetch-vendor。"
}
$node = Resolve-Node
$tokenPath = Join-Path $Secrets "local_token"
if (-not (Test-Path -LiteralPath $tokenPath)) { [guid]::NewGuid().ToString("N") | Set-Content -Encoding ASCII -LiteralPath $tokenPath }
$configPath = Join-Path $AppData "config.json"
if (-not (Test-Path -LiteralPath $configPath)) {
  $cfg = @{ onebot_url="ws://127.0.0.1:3001"; onebot_host="127.0.0.1"; onebot_port=3001; login_ui_port=6099; owners=@(); channels=@{qq=@{enabled=$false}}; bind="127.0.0.1" }
  [System.IO.File]::WriteAllText($configPath, ($cfg | ConvertTo-Json -Depth 6), (New-Object System.Text.UTF8Encoding($false)))
}
& $node -e 'require(process.argv[1]).ensurePersonaLib(process.env.FATFISH_APPDATA)' (Join-Path $Root "app\electron-ui\persona-lib.js")
if ($LASTEXITCODE -ne 0) { throw "无法准备人格数据。" }

function Test-Port([int]$Port) {
  $client = New-Object System.Net.Sockets.TcpClient
  try {
    $pending = $client.BeginConnect("127.0.0.1", $Port, $null, $null)
    if (-not $pending.AsyncWaitHandle.WaitOne(800, $false)) { return $false }
    $client.EndConnect($pending); return $true
  } catch { return $false } finally { $client.Close() }
}
$cfg = Get-Content -LiteralPath $configPath -Raw -Encoding UTF8 | ConvertFrom-Json
$port = if ($cfg.onebot_port) { [int]$cfg.onebot_port } else { 3001 }
$login = if ($cfg.login_ui_port) { [int]$cfg.login_ui_port } else { 6099 }
$enabledText = & $node -e 'const c=require(process.argv[1]);try{process.stdout.write(String(c.qqEnabled(c.readConfig(process.argv[2]))))}catch{process.stdout.write(String(false))}' (Join-Path $Root "app\core\channel-config.cjs") $configPath
if ($enabledText -eq "true" -and -not (Test-Port $port) -and -not (Test-Port $login)) {
  $backend = @((Join-Path $Root "vendor\napcat"), (Join-Path $Root "bin\napcat")) | Where-Object { (Test-Path (Join-Path $_ "launcher-user.bat")) -or (Test-Path (Join-Path $_ "launcher.bat")) } | Select-Object -First 1
  if ($backend) {
    $launcher = Join-Path $backend "launcher-user.bat"
    if (-not (Test-Path -LiteralPath $launcher)) { $launcher = Join-Path $backend "launcher.bat" }
    $args = @('/c', ('"' + $launcher + '"'))
    $child = Start-Process -FilePath "cmd.exe" -ArgumentList $args -WorkingDirectory $backend -WindowStyle Hidden -PassThru
    $child.Id | Set-Content -Encoding ASCII -LiteralPath (Join-Path $Runtime "napcat.pid")
    Write-Host "后台登录服务已启动，请在肥鱼窗口完成登录。"
  } else { Write-Warning "后台组件缺失，伙伴核心仍将启动以便诊断。" }
}
$corePid = Join-Path $Runtime "core.pid"
if (Test-Path -LiteralPath $corePid) {
  $old = (Get-Content -LiteralPath $corePid -Raw).Trim()
  $running = if ($old -match '^\d+$') { Get-CimInstance Win32_Process -Filter "ProcessId = $old" -ErrorAction SilentlyContinue } else { $null }
  if ($running -and $running.CommandLine -like "*app*core*server.mjs*") { Write-Host "伙伴核心已在运行，请先停止后再启动。"; exit 0 }
}
$core = Join-Path $Root "app\core\server.mjs"
$quoted = '"' + $core + '"'
$child = Start-Process -FilePath $node -ArgumentList @($quoted) -WorkingDirectory (Split-Path -Parent $core) -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $Logs "core.log") -RedirectStandardError (Join-Path $Logs "core.err.log")
$child.Id | Set-Content -Encoding ASCII -LiteralPath $corePid
Write-Host "伙伴核心已启动，PID=$($child.Id)。独立诊断模式没有审批界面，操作请求将按拒绝处理。"
Write-Host "正常使用请打开肥鱼桌面客户端。数据目录：$AppData"
