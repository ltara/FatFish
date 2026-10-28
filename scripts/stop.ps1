# Stop only the process trees recorded for this installation.
$ErrorActionPreference = "Continue"
$Root = [System.IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
$AppData = if ($env:FATFISH_APPDATA) { $env:FATFISH_APPDATA } else { Join-Path $env:APPDATA "FatFish" }
$Runtime = Join-Path $AppData "runtime"
function Stop-PidFile([string]$Name, [string[]]$ExpectedPaths) {
  $file = Join-Path $Runtime $Name
  if (-not (Test-Path -LiteralPath $file)) { return }
  $idText = (Get-Content -LiteralPath $file -Raw).Trim()
  if ($idText -match '^\d+$') {
    $process = Get-CimInstance Win32_Process -Filter "ProcessId = $idText" -ErrorAction SilentlyContinue
    if ($process) {
      $owned = $false
      foreach ($expected in $ExpectedPaths) { if ($process.CommandLine -and $process.CommandLine.IndexOf($expected, [System.StringComparison]::OrdinalIgnoreCase) -ge 0) { $owned = $true } }
      if ($owned) { & taskkill.exe /PID $idText /T /F | Out-Null; Write-Host "已停止 $Name 对应的进程树。" }
      else { Write-Warning "PID 已被其他进程占用或无法核对来源，未终止该进程。" }
    }
  }
  Remove-Item -LiteralPath $file -Force -ErrorAction SilentlyContinue
}
Stop-PidFile "core.pid" @((Join-Path $Root "app\core\server.mjs"))
Stop-PidFile "napcat.pid" @((Join-Path $Root "vendor\napcat"), (Join-Path $Root "bin\napcat"))
Write-Host "停止完成；未按名称终止 QQ 或其他安装的后台进程。"
