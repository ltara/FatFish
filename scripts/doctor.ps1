# Read-only diagnostics. NoPause is useful for automated validation.
param([switch]$NoPause)
$ErrorActionPreference = "Continue"
$AppData = if ($env:FATFISH_APPDATA) { $env:FATFISH_APPDATA } else { Join-Path $env:APPDATA "FatFish" }
$Runtime = Join-Path $AppData "runtime"
Write-Host "=== 肥鱼诊断 ==="
$key = Join-Path $AppData "secrets\deepseek_api_key"
if ((Test-Path -LiteralPath $key) -and (Get-Content -LiteralPath $key -Raw).Trim()) { Write-Host "[OK] 模型密钥已保存（内容不显示）" }
else { Write-Host "[!!] 尚未保存模型密钥，请到肥鱼窗口的设置里填写。" }
$port = 3001; $login = 6099
$configPath = Join-Path $AppData "config.json"
if (Test-Path -LiteralPath $configPath) {
  try {
    $cfg = Get-Content -LiteralPath $configPath -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($cfg.onebot_port) { $port = [int]$cfg.onebot_port }
    if ($cfg.login_ui_port) { $login = [int]$cfg.login_ui_port }
    $owners = @($cfg.owners).Count
    Write-Host "[OK] 已读取绑定表，共 $owners 个账号（账号不显示）。"
  } catch { Write-Host "[!!] 配置无法读取。" }
}
function Test-Port([int]$Port) {
  $client = New-Object System.Net.Sockets.TcpClient
  try {
    $pending = $client.BeginConnect("127.0.0.1", $Port, $null, $null)
    if (-not $pending.AsyncWaitHandle.WaitOne(600, $false)) { return $false }
    $client.EndConnect($pending); return $true
  } catch { return $false } finally { $client.Close() }
}
foreach ($entry in @(@{name="消息渠道";port=$port}, @{name="登录窗口";port=$login})) {
  if (Test-Port $entry.port) { Write-Host "[OK] $($entry.name)端口可连接。" } else { Write-Host "[..] $($entry.name)尚未监听。" }
}
foreach ($name in @("core.pid", "napcat.pid")) {
  $file = Join-Path $Runtime $name
  $idText = if (Test-Path -LiteralPath $file) { (Get-Content -LiteralPath $file -Raw).Trim() } else { "" }
  if ($idText -match '^\d+$' -and (Get-Process -Id ([int]$idText) -ErrorAction SilentlyContinue)) { Write-Host "[OK] $name 进程存在，PID=$idText。" }
  else { Write-Host "[..] 未发现 $name 对应进程。" }
}
Write-Host "数据目录：$AppData"
Write-Host "=== 结束 ==="
if (-not $NoPause) { Read-Host "按回车结束" | Out-Null }
