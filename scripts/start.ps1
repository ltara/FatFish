# Start FatFish local services (loopback only)
$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
$AppData = if ($env:FATFISH_APPDATA) { $env:FATFISH_APPDATA } else { Join-Path $env:APPDATA "FatFish" }
$Secrets = Join-Path $AppData "secrets"
$Logs = Join-Path $AppData "logs"
$Runtime = Join-Path $AppData "runtime"
New-Item -ItemType Directory -Force -Path $Secrets, $Logs, $Runtime | Out-Null

# ACL secrets (current user)
try {
  icacls $Secrets /inheritance:r | Out-Null
  icacls $Secrets /grant:r "$($env:USERNAME):(OI)(CI)F" | Out-Null
} catch { Write-Warning "ACL skip: $_" }

$keyPath = Join-Path $Secrets "deepseek_api_key"
$tokenPath = Join-Path $Secrets "local_token"
$configPath = Join-Path $AppData "config.json"
$personaPath = Join-Path $AppData "persona.txt"

if (-not (Test-Path $tokenPath)) {
  [guid]::NewGuid().ToString("N") | Set-Content -Encoding ASCII $tokenPath
}
$token = (Get-Content $tokenPath -Raw).Trim()

if (-not (Test-Path $configPath)) {
  @{
    onebot_url = "ws://127.0.0.1:3001"
    onebot_host = "127.0.0.1"
    onebot_port = 3001
    settings_port = 8787
    login_ui_port = 6099
    bind = "127.0.0.1"
  } | ConvertTo-Json | Set-Content -Encoding UTF8 $configPath
}

if (-not (Test-Path $personaPath)) {
  $ex = Join-Path $Root "app\bridge\persona.example.txt"
  if (Test-Path $ex) { Copy-Item $ex $personaPath }
}

$cfg = Get-Content $configPath -Raw -Encoding UTF8 | ConvertFrom-Json
$port = if ($cfg.onebot_port) { [int]$cfg.onebot_port } else { 3001 }
$settingsPort = if ($cfg.settings_port) { [int]$cfg.settings_port } else { 8787 }

if (-not (Test-Path $keyPath) -or -not (Get-Content $keyPath -Raw).Trim()) {
  Write-Host "未检测到 API Key。可先打开设置填写；未填 Key 时私聊会提示去设置。"
}

function Resolve-Node {
  $vend = Join-Path $Root "vendor\node\node.exe"
  if (Test-Path $vend) { return $vend }
  $inst = Join-Path $Root "bin\node\node.exe"
  if (Test-Path $inst) { return $inst }
  $cmd = Get-Command node -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  return $null
}

function Resolve-NapcatDir {
  foreach ($d in @(
    (Join-Path $Root "vendor\napcat"),
    (Join-Path $Root "bin\napcat")
  )) {
    if ((Test-Path (Join-Path $d "launcher-user.bat")) -or (Test-Path (Join-Path $d "NapCatWinBootMain.exe"))) {
      return $d
    }
  }
  return $null
}

function Test-PortOpen([string]$HostName, [int]$PortNum, [int]$TimeoutMs = 800) {
  try {
    $c = New-Object System.Net.Sockets.TcpClient
    $iar = $c.BeginConnect($HostName, $PortNum, $null, $null)
    $ok = $iar.AsyncWaitHandle.WaitOne($TimeoutMs, $false)
    if (-not $ok) { $c.Close(); return $false }
    $c.EndConnect($iar)
    $c.Close()
    return $true
  } catch { return $false }
}

# 1) Start backend service (NapCat) if present
$napcat = Resolve-NapcatDir
$napcatPidFile = Join-Path $Runtime "napcat.pid"
if ($napcat) {
  Write-Host "启动后台服务: $napcat"
  $launcher = Join-Path $napcat "launcher-user.bat"
  if (-not (Test-Path $launcher)) { $launcher = Join-Path $napcat "launcher.bat" }
  $p = Start-Process -FilePath "cmd.exe" -ArgumentList @("/c", "`"$launcher`"") -WorkingDirectory $napcat -WindowStyle Minimized -PassThru
  $p.Id | Set-Content -Encoding ASCII $napcatPidFile
} else {
  Write-Warning "未找到后台服务目录 (vendor\napcat 或 bin\napcat)。请先运行 fetch-vendor，并安装官方 QQ。"
}

# 2) Wait for 127.0.0.1:3001
Write-Host "等待本地端口 127.0.0.1:$port ..."
$deadline = (Get-Date).AddSeconds(45)
$ready = $false
while ((Get-Date) -lt $deadline) {
  if (Test-PortOpen "127.0.0.1" $port) { $ready = $true; break }
  Start-Sleep -Milliseconds 500
}
if ($ready) { Write-Host "[OK] 端口 $port 已就绪" }
else { Write-Warning "端口 $port 未在超时内就绪。请打开「登录窗口」完成登录后重试。" }

# Seed onebot loopback hint into AppData (actual service config may be set via 登录窗口)
$hint = Join-Path $AppData "network-hint.json"
@{
  host = "127.0.0.1"
  port = $port
  token_file = "secrets/local_token"
  note = "Configure reverse WS / WS server to 127.0.0.1 only via 登录窗口"
} | ConvertTo-Json | Set-Content -Encoding UTF8 $hint

# 3) Start bridge
$node = Resolve-Node
$bridgePidFile = Join-Path $Runtime "bridge.pid"
$bridgeLog = Join-Path $Logs "bridge.log"
if (-not $node) {
  Write-Error "未找到 node。请运行 scripts\fetch-vendor.ps1 或安装 Node.js 18+。"
}
$bridgeJs = Join-Path $Root "app\bridge\server.mjs"
$env:FATFISH_APPDATA = $AppData
$bp = Start-Process -FilePath $node -ArgumentList @($bridgeJs) -WorkingDirectory (Join-Path $Root "app\bridge") `
  -WindowStyle Hidden -PassThru -RedirectStandardOutput $bridgeLog -RedirectStandardError (Join-Path $Logs "bridge.err.log")
$bp.Id | Set-Content -Encoding ASCII $bridgePidFile
Write-Host "[OK] 智能回复引擎 PID=$($bp.Id)"

# 4) Start local settings server
$localJs = Join-Path $Root "app\shell\local-server.mjs"
$localPidFile = Join-Path $Runtime "local-server.pid"
$localLog = Join-Path $Logs "local-server.log"
$lp = Start-Process -FilePath $node -ArgumentList @($localJs) -WorkingDirectory (Join-Path $Root "app\shell") `
  -WindowStyle Hidden -PassThru -RedirectStandardOutput $localLog -RedirectStandardError (Join-Path $Logs "local-server.err.log")
$lp.Id | Set-Content -Encoding ASCII $localPidFile
Write-Host "[OK] 设置服务 http://127.0.0.1:$settingsPort  PID=$($lp.Id)"
Write-Host "启动完成。AppData=$AppData"
