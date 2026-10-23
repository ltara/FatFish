# Stop FatFish local services
$ErrorActionPreference = "Continue"
$AppData = if ($env:FATFISH_APPDATA) { $env:FATFISH_APPDATA } else { Join-Path $env:APPDATA "FatFish" }
$Runtime = Join-Path $AppData "runtime"

function Stop-PidFile([string]$Name) {
  $f = Join-Path $Runtime $Name
  if (-not (Test-Path $f)) { return }
  $id = (Get-Content $f -Raw).Trim()
  if ($id -match '^\d+$') {
    try {
      Stop-Process -Id ([int]$id) -Force -ErrorAction SilentlyContinue
      Write-Host "stopped $Name pid=$id"
    } catch {
      Write-Host "already gone $Name pid=$id"
    }
  }
  Remove-Item $f -Force -ErrorAction SilentlyContinue
}

Stop-PidFile "bridge.pid"
Stop-PidFile "local-server.pid"
Stop-PidFile "napcat.pid"

# Best-effort: stop known process names without exposing internals in UI text
Get-Process -Name "NapCatWinBootMain","QQ" -ErrorAction SilentlyContinue | ForEach-Object {
  # Do not kill QQ by default — only boot helper if still around
  if ($_.Name -eq "NapCatWinBootMain") {
    Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue
  }
}

Write-Host "停止完成"
