# Diagnostics (user-facing labels only)
$ErrorActionPreference = "Continue"
$AppData = if ($env:FATFISH_APPDATA) { $env:FATFISH_APPDATA } else { Join-Path $env:APPDATA "FatFish" }
$keyPath = Join-Path $AppData "secrets\deepseek_api_key"
$configPath = Join-Path $AppData "config.json"
$Runtime = Join-Path $AppData "runtime"

Write-Host "=== 肥鱼诊断 ==="

$qqHints = @(
  "$env:ProgramFiles\Tencent\QQNT\QQ.exe",
  "${env:ProgramFiles(x86)}\Tencent\QQ\QQ.exe",
  "$env:ProgramFiles\Tencent\QQ\QQ.exe"
)
$qq = $qqHints | Where-Object { Test-Path $_ } | Select-Object -First 1
if ($qq) { Write-Host "[OK] 已检测到 QQ: $qq" } else { Write-Host "[!!] 未检测到 QQ，请先安装官方 QQ" }

if ((Test-Path $keyPath) -and (Get-Content $keyPath -Raw).Trim()) {
  Write-Host "[OK] 已保存 API Key（内容不显示）"
} else {
  Write-Host "[!!] 未填写 API Key — 打开设置粘贴后保存"
}

$port = 3001
$settingsPort = 8787
$loginPort = 6099
if (Test-Path $configPath) {
  try {
    $cfg = Get-Content $configPath -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($cfg.onebot_port) { $port = [int]$cfg.onebot_port }
    if ($cfg.settings_port) { $settingsPort = [int]$cfg.settings_port }
    if ($cfg.login_ui_port) { $loginPort = [int]$cfg.login_ui_port }
  } catch {}
}

function Test-Port([int]$P) {
  try {
    $c = New-Object System.Net.Sockets.TcpClient
    $iar = $c.BeginConnect("127.0.0.1", $P, $null, $null)
    $ok = $iar.AsyncWaitHandle.WaitOne(600, $false)
    if ($ok) { $c.EndConnect($iar); $c.Close(); return $true }
    $c.Close(); return $false
  } catch { return $false }
}

if (Test-Port $port) { Write-Host "[OK] 本地服务端口 $port 可连接" } else { Write-Host "[!!] 本地服务端口 $port 未监听 — 请先启动并完成登录" }
if (Test-Port $settingsPort) { Write-Host "[OK] 设置页端口 $settingsPort 可连接" } else { Write-Host "[!!] 设置页端口 $settingsPort 未监听" }
if (Test-Port $loginPort) { Write-Host "[OK] 登录窗口端口 $loginPort 可连接" } else { Write-Host "[..] 登录窗口端口 $loginPort 未监听（登录前可能正常）" }

foreach ($n in @("bridge.pid","local-server.pid","napcat.pid")) {
  $f = Join-Path $Runtime $n
  if (Test-Path $f) {
    $id = (Get-Content $f -Raw).Trim()
    $alive = $false
    try { Get-Process -Id ([int]$id) -ErrorAction Stop | Out-Null; $alive = $true } catch {}
    if ($alive) { Write-Host "[OK] 进程 $n = $id 运行中" } else { Write-Host "[!!] 进程 $n = $id 不存在" }
  } else {
    Write-Host "[..] 无 PID 文件 $n"
  }
}

Write-Host "数据目录: $AppData"
Write-Host "=== 结束 ==="
pause
